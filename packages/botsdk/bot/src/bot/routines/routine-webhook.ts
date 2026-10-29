import { and, eq } from "drizzle-orm";

import { bot, botRoutine, botTrigger } from "../../storage";
import { uuidv7 } from "../../lib/uuidv7";
import type { BotSdkContext } from "../../plugin";
import {
  fireKeyPrefix,
  lastRanAt,
  routineSnapshot,
  untrustedBlock,
  webhookPayloadLabel,
  webhookTokenHash,
} from "./routine";
import { lockConversation, receive } from "../triggers";
import { hintChanged } from "../conversation";

/** The largest webhook body a Routine takes (ADR 0021); a bigger one gets 413. */
export const webhookBodyLimit = 64 * 1024;

/** The longest `Idempotency-Key` a webhook takes: it becomes part of the Trigger's primary key. */
export const idempotencyKeyLimit = 255;

/**
 * What `routines.receiveWebhook` did with a delivery: `accepted` (handed to the Router, or dropped
 * as a retry or while the user's Quota is spent or they are Banned, which the sender never learns),
 * `notFound` (no active Routine has the token), `payloadTooLarge` (over 64 KB) or
 * `idempotencyKeyTooLong` (over 255 characters).
 */
export type WebhookReceipt = "accepted" | "notFound" | "payloadTooLarge" | "idempotencyKeyTooLong";

/**
 * `routines.receiveWebhook` (ADR 0021, spec #873): a delivery to an `active` Routine's webhook
 * hands the Router a `routine` / `webhook` Trigger, never waiting for the Turn. An
 * `Idempotency-Key` header makes a retried delivery a no-op.
 */
export async function receiveRoutineWebhook(
  deps: BotSdkContext,
  {
    token,
    body,
    headers,
  }: { token: string; body: string; headers?: Headers | Record<string, string> },
): Promise<WebhookReceipt> {
  const key = idempotencyKeyOf(new Headers(headers));
  if (key === tooLong) return "idempotencyKeyTooLong";
  if (new TextEncoder().encode(body).byteLength > webhookBodyLimit) return "payloadTooLarge";
  const received = await receiveWebhook(deps, {
    tokenHash: webhookTokenHash(token),
    key,
    payload: body,
  });
  if (received === undefined) return "notFound";
  if (received) {
    deps.runner.wake();
    await hintChanged(deps, received);
  }
  return "accepted";
}

/** The HTTP answer to each receipt. */
const receiptResponse: Record<WebhookReceipt, () => Response> = {
  accepted: () => new Response(null, { status: 202 }),
  notFound: () => new Response("Not found", { status: 404 }),
  payloadTooLarge: () => new Response("Payload too large", { status: 413 }),
  idempotencyKeyTooLong: () => new Response("Idempotency-Key too long", { status: 400 }),
};

/**
 * The webhook's HTTP route, `POST <basePath>/routines/webhook/<token>`, with no sign-in: the token
 * is the authentication. It answers `202` at once, `413` to a body over 64 KB (read no further),
 * `404` to a token that matches no active Routine, which reveals nothing, and `400` to an
 * `Idempotency-Key` over 255 characters.
 */
export async function handleRoutineWebhook(
  deps: BotSdkContext,
  request: Request,
  token: string,
): Promise<Response> {
  // Checked before the body is read, which the domain method checks again.
  if (idempotencyKeyOf(request.headers) === tooLong) return receiptResponse.idempotencyKeyTooLong();
  // Measured as bytes while it is read, so a huge body is never held in memory.
  const body = await readBody(request, webhookBodyLimit);
  if (body === null) return receiptResponse.payloadTooLarge();
  const receipt = await receiveRoutineWebhook(deps, { token, body, headers: request.headers });
  return receiptResponse[receipt]();
}

/** What `idempotencyKeyOf` gives for a key over 255 characters. */
const tooLong = Symbol("too long");

/** The `Idempotency-Key` header, trimmed; `null` when it is missing or blank. */
function idempotencyKeyOf(headers: Headers): string | null | typeof tooLong {
  const key = headers.get("Idempotency-Key")?.trim() || null;
  return key && key.length > idempotencyKeyLimit ? tooLong : key;
}

/** The body as text, or `null` once it is over `limit` bytes. */
async function readBody(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > limit) return null;
  if (!request.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Hands the Router the webhook's Trigger for the active Routine whose token hashes to `tokenHash`:
 * its prompt, then the payload as untrusted data. Its ID is `routine:<id>:<key>`, so a delivery
 * retried with the same `Idempotency-Key` makes none; with no key, every call makes one. While the
 * user's Quota is spent or they are Banned (#585) none is handed, as for a scheduled fire. Returns
 * the Conversation that got a Trigger, `null` when none was handed, or `undefined` for no active
 * Routine.
 */
async function receiveWebhook(
  deps: BotSdkContext,
  { tokenHash, key, payload }: { tokenHash: string; key: string | null; payload: string },
): Promise<string | null | undefined> {
  const [owner] = await deps.db
    .select({
      routineId: botRoutine.id,
      conversationId: bot.conversationId,
      userId: bot.userId,
      model: bot.model,
    })
    .from(botRoutine)
    .innerJoin(bot, eq(bot.id, botRoutine.botId))
    .where(and(eq(botRoutine.webhookTokenHash, tokenHash), eq(botRoutine.state, "active")));
  if (!owner) return undefined;
  // The Quota and the Ban are read outside the transaction, so a slow read never holds up the
  // Conversation.
  const call = await deps.models.resolveModelCall(owner.userId, owner.model);
  if (call && !(await call.meter.mayRun()).ok) return null;
  if (await deps.isUserBlocked(owner.userId)) return null;

  return deps.db.transaction(async (tx) => {
    // The Conversation's row lock first, as in every transaction that hands the Router a Trigger.
    await lockConversation(tx, owner.conversationId);
    const [routine] = await tx
      .select()
      .from(botRoutine)
      .where(eq(botRoutine.id, owner.routineId))
      .for("update");
    // Paused, sent back for approval or rotated since the lookup: not found.
    if (routine?.state !== "active" || routine.webhookTokenHash !== tokenHash) return undefined;

    const id = `${fireKeyPrefix(routine.id)}${key ?? uuidv7()}`;
    const [seen] = await tx
      .select({ id: botTrigger.id })
      .from(botTrigger)
      .where(eq(botTrigger.id, id));
    if (seen) return null;
    const now = deps.clock();
    await receive(deps, tx, {
      id,
      conversationId: owner.conversationId,
      source: "routine",
      channel: "webhook",
      text: `${routineSnapshot({ ...routine, slot: now, lastRanAt: await lastRanAt(tx, routine.id) })}\n\n${untrusted(payload)}`,
      receivedAt: now,
    });
    return owner.conversationId;
  });
}

/** A webhook's payload as the Turn reads it (slide 29): a fenced block labelled as untrusted data. */
function untrusted(payload: string): string {
  return untrustedBlock(webhookPayloadLabel, payload);
}
