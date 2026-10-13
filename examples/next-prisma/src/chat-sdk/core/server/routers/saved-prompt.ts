import { and, asc, count, eq, ne } from "drizzle-orm";
import { z } from "zod";

import {
  savedPromptLimit,
  savedPromptNameMessage,
  savedPromptNamePattern,
  savedPromptTextMaxChars,
} from "../../shared/chat/saved-prompt";
import { savedPrompt } from "../db/schema/saved-prompt";
import { uuidv7 } from "../lib/uuidv7";
import { protectedProcedure } from "../procedures";
import { rpcError } from "../rpc-error";

const savedPromptInput = z.object({ name: z.string(), text: z.string() });

/** Refuses a name or text the rules don't allow; the message is the one the form shows. */
function checkSavedPrompt({ name, text }: { name: string; text: string }) {
  if (!savedPromptNamePattern.test(name)) {
    throw rpcError("BAD_REQUEST", "error.savedPromptName", savedPromptNameMessage);
  }
  if (text.trim() === "") {
    throw rpcError("BAD_REQUEST", "error.savedPromptTextBlank", "Text can't be blank");
  }
  if (text.length > savedPromptTextMaxChars) {
    throw rpcError(
      "BAD_REQUEST",
      "error.savedPromptTextTooLong",
      `Text is limited to ${savedPromptTextMaxChars.toLocaleString("en-US")} characters`,
      { max: savedPromptTextMaxChars },
    );
  }
}

function nameClash(name: string) {
  return rpcError(
    "CONFLICT",
    "error.savedPromptNameTaken",
    `You already have a Saved prompt named "${name}"`,
    { name },
  );
}

export const savedPromptRouter = {
  /** The caller's Saved prompts, by name. */
  list: protectedProcedure.handler(async ({ context }) => {
    const items = await context.deps.db
      .select({
        id: savedPrompt.id,
        name: savedPrompt.name,
        text: savedPrompt.text,
        createdAt: savedPrompt.createdAt,
      })
      .from(savedPrompt)
      .where(eq(savedPrompt.userId, context.user.id))
      .orderBy(asc(savedPrompt.name));
    return { items };
  }),

  /**
   * Saves a Saved prompt. The name is unique among the caller's, and a user has at most 100 Saved
   * prompts.
   */
  create: protectedProcedure.input(savedPromptInput).handler(async ({ context, input }) => {
    const { db } = context.deps;
    const userId = context.user.id;
    checkSavedPrompt(input);
    const [clash] = await db
      .select({ id: savedPrompt.id })
      .from(savedPrompt)
      .where(and(eq(savedPrompt.userId, userId), eq(savedPrompt.name, input.name)));
    if (clash) throw nameClash(input.name);
    const [counted] = await db
      .select({ total: count() })
      .from(savedPrompt)
      .where(eq(savedPrompt.userId, userId));
    if ((counted?.total ?? 0) >= savedPromptLimit) {
      throw rpcError(
        "FORBIDDEN",
        "error.savedPromptLimit",
        `You have ${savedPromptLimit} Saved prompts. Delete one first.`,
        { max: savedPromptLimit },
      );
    }
    const id = uuidv7();
    await db.insert(savedPrompt).values({ id, userId, name: input.name, text: input.text });
    return { id };
  }),

  /** Changes the name and text of one of the caller's Saved prompts. */
  update: protectedProcedure
    .input(savedPromptInput.extend({ id: z.uuid() }))
    .handler(async ({ context, input }) => {
      const { db } = context.deps;
      const userId = context.user.id;
      checkSavedPrompt(input);
      const [owned] = await db
        .select({ id: savedPrompt.id })
        .from(savedPrompt)
        .where(and(eq(savedPrompt.id, input.id), eq(savedPrompt.userId, userId)));
      if (!owned)
        throw rpcError("NOT_FOUND", "error.savedPromptNotFound", "Saved prompt not found");
      const [clash] = await db
        .select({ id: savedPrompt.id })
        .from(savedPrompt)
        .where(
          and(
            eq(savedPrompt.userId, userId),
            eq(savedPrompt.name, input.name),
            ne(savedPrompt.id, input.id),
          ),
        );
      if (clash) throw nameClash(input.name);
      await db
        .update(savedPrompt)
        .set({ name: input.name, text: input.text })
        .where(eq(savedPrompt.id, input.id));
    }),

  /** Deletes one of the caller's Saved prompts. */
  delete: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ context, input }) => {
      const removed = await context.deps.db
        .delete(savedPrompt)
        .where(and(eq(savedPrompt.id, input.id), eq(savedPrompt.userId, context.user.id)))
        .returning({ id: savedPrompt.id });
      if (removed.length === 0) {
        throw rpcError("NOT_FOUND", "error.savedPromptNotFound", "Saved prompt not found");
      }
    }),
};
