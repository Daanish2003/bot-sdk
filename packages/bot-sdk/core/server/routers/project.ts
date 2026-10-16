import { project } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { rpcError, unusableModelError } from "../rpc-error";
import {
  countProjectConversations,
  countProjects,
  deleteProject,
  findProject,
  listProjects,
  projectLimit,
} from "../project/store";
import { instructionsMaxChars } from "../../shared/chat/instructions";
import { protectedProcedure } from "../procedures";
import { uuidv7 } from "../lib/uuidv7";

export const projectRouter = {
  /** The caller's Projects, newest activity first. */
  list: protectedProcedure.handler(async ({ context }) => ({
    items: await listProjects(context.deps, context.user.id),
  })),

  /** One of the caller's Projects; `defaultModel` and `instructions` are null when it has none. */
  get: protectedProcedure.input(z.object({ id: z.uuid() })).handler(async ({ context, input }) => {
    const row = await findProject(context.deps, context.user.id, input.id);
    if (!row) throw rpcError("NOT_FOUND", "error.projectNotFound", "Project not found");
    return {
      id: row.id,
      name: row.name,
      defaultModel: row.defaultModel,
      instructions: row.instructions,
    };
  }),

  /**
   * Renames the caller's Project, sets its default Model and its Instructions. A `defaultModel` left
   * out keeps the stored one without checking it, so a Model that has since gone can't block a
   * rename; a string must be a Model the user can use now, and `null` clears it. Instructions left
   * out are kept; blank ones (or `null`) clear them, and they're capped like the user's.
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().trim().min(1).max(100),
        defaultModel: z.string().nullish(),
        instructions: z.string().nullish(),
      }),
    )
    .handler(async ({ context, input }) => {
      const userId = context.user.id;
      if (!(await findProject(context.deps, userId, input.id))) {
        throw rpcError("NOT_FOUND", "error.projectNotFound", "Project not found");
      }
      if (input.instructions && input.instructions.length > instructionsMaxChars) {
        throw rpcError(
          "BAD_REQUEST",
          "error.instructionsTooLong",
          `Instructions are limited to ${instructionsMaxChars} characters`,
          {
            max: instructionsMaxChars,
          },
        );
      }
      const changes: {
        name: string;
        defaultModel?: string | null;
        instructions?: string | null;
      } = { name: input.name };
      if (input.instructions !== undefined) {
        changes.instructions = input.instructions?.trim() || null;
      }
      if (typeof input.defaultModel === "string") {
        const model = await context.deps.plugin("models").resolveModel(userId, input.defaultModel);
        if (!model) {
          throw rpcError(
            "BAD_REQUEST",
            "error.modelNotAvailable",
            `"${input.defaultModel}" is not an available Model`,
            {
              model: input.defaultModel,
            },
          );
        }
        if (!(await context.deps.plugin("models").resolveModelCall(userId, model.id))) {
          throw unusableModelError(model.provider, context.deps.plugin("models").byok);
        }
        changes.defaultModel = model.id;
      } else if (input.defaultModel === null) {
        changes.defaultModel = null;
      }
      await context.deps.db
        .update(project)
        .set(changes)
        .where(and(eq(project.id, input.id), eq(project.userId, userId)));
    }),

  /** Creates a Project. A name is 1 to 100 characters once trimmed; a user has at most 100 Projects. */
  create: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(100) }))
    .handler(async ({ context, input }) => {
      if ((await countProjects(context.deps, context.user.id)) >= projectLimit) {
        throw rpcError(
          "BAD_REQUEST",
          "error.projectLimit",
          `You can have at most ${projectLimit} Projects`,
          {
            max: projectLimit,
          },
        );
      }
      const id = uuidv7();
      await context.deps.db
        .insert(project)
        .values({ id, userId: context.user.id, name: input.name });
      return { id };
    }),

  /** How many Conversations the Project holds, for the delete confirmation. */
  conversationCount: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ context, input }) => {
      const count = await countProjectConversations(context.deps, context.user.id, input.id);
      if (count === undefined)
        throw rpcError("NOT_FOUND", "error.projectNotFound", "Project not found");
      return { count };
    }),

  /**
   * Deletes the Project with its Conversations, Messages and Shared links, for good. Live Runs in
   * those Conversations stop first. Answers how many Conversations went.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ context, input }) => {
      const count = await deleteProject(context.deps, context.user.id, input.id);
      if (count === undefined)
        throw rpcError("NOT_FOUND", "error.projectNotFound", "Project not found");
      return { count };
    }),
};
