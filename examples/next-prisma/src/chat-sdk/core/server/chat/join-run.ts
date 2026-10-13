import { conversation, message } from "../db/schema/chat";
import { resumeServerSentEventsResponse } from "@tanstack/ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { AppDeps } from "../deps";
import type { ChatUser } from "../context";
import { runLogId } from "./run";
import { runStreamDurability, START } from "./run-streams";

/** A refusal: its HTTP status, and a body of the dictionary code and its params (spec #256). */
const refuse = (status: number, code: "error.invalidRunId" | "error.runNotFound") =>
  Response.json({ code, params: {} }, { status });

const runIdSchema = z.uuid();

/**
 * `GET ${basePath}/run?runId=…`: joins a Run. Replays its log from the offset (or from `Last-Event-ID`,
 * which a reconnect sends) and then tails it until it closes, so a reloaded page or a second tab
 * picks a live reply up where it is (ADR 0006).
 */
export async function handleJoin(
  request: Request,
  user: ChatUser,
  deps: AppDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const runId = runIdSchema.safeParse(url.searchParams.get("runId"));
  if (!runId.success) return refuse(400, "error.invalidRunId");

  // A Run is its assistant Message; only the Conversation's owner may join it. The Message's current
  // Run is the newest log, so a reply resumed after an Approval is joined on that Run (ADR 0008).
  const [owned] = await deps.db
    .select({ id: message.id, runNumber: message.runNumber })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .where(and(eq(message.id, runId.data), eq(conversation.userId, user.id)))
    .limit(1);
  if (!owned) return refuse(404, "error.runNotFound");

  const resumeFrom =
    request.headers.get("Last-Event-ID") ?? url.searchParams.get("offset") ?? START;
  return resumeServerSentEventsResponse({
    adapter: runStreamDurability(deps.runStreams, runLogId(owned.id, owned.runNumber), resumeFrom),
  });
}
