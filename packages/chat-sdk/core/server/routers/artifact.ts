import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { readArtifactVersion } from "../artifact/store";
import { protectedProcedure } from "../procedures";

export const artifactRouter = {
  /**
   * One version of an Artifact, with its content, for the user who owns its Conversation (ADR
   * 0016). The version is the one with that number on the Branch that ends at `messageId` (the
   * Message whose `artifact` part names it), since each Branch numbers its own. Another user's
   * Artifact and a version that doesn't exist on that Branch both answer NOT_FOUND.
   */
  version: protectedProcedure
    .input(
      z.object({
        artifactId: z.string().min(1).max(64),
        number: z.number().int().positive(),
        messageId: z.string().uuid(),
      }),
    )
    .handler(async ({ context, input }) => {
      // Off, there is no route: a Host that doesn't turn Artifacts on sees none of them.
      const version = context.deps.artifacts
        ? await readArtifactVersion(context.deps, context.user.id, input)
        : null;
      if (!version) throw new ORPCError("NOT_FOUND", { message: "Artifact version not found" });
      return version;
    }),
};
