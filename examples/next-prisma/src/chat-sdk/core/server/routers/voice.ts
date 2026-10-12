import { ORPCError } from "@orpc/server";
import { z } from "zod";

import {
  isDictationAudioType,
  maxDictationBytes,
  maxDictationSeconds,
} from "../../shared/chat/voice";
import { DictationError, ownDictationEngine, transcribeRecording } from "../chat/transcription";
import { protectedProcedure } from "../procedures";

/** A base64 string of `maxDictationBytes` decodes to at most that many bytes. */
const maxAudioChars = Math.ceil(maxDictationBytes / 3) * 4;

export const voiceRouter = {
  /**
   * Whether the caller can dictate: a key of their own for OpenAI, Groq or Grok, with `byok` on.
   * `onHostCredentials` is always false until the Host's transcription Models are offered.
   */
  status: protectedProcedure.handler(async ({ context }) => ({
    transcription: {
      available: (await ownDictationEngine(context.deps, context.user.id)) !== null,
      onHostCredentials: false,
    },
  })),

  /**
   * Transcribes one recording with the caller's own Provider key, and returns its text. The audio
   * is never stored. Refused over 10 minutes, over 25 MB, or for a type other than audio.
   */
  transcribe: protectedProcedure
    .input(
      z.object({
        audio: z.string().min(1).max(maxAudioChars, { error: "A recording can be at most 25 MB" }),
        mimeType: z.string().max(200),
        durationSeconds: z.number().positive(),
        language: z.string().trim().min(2).max(35).optional(),
      }),
    )
    .handler(async ({ context, input }) => {
      if (input.durationSeconds > maxDictationSeconds) {
        throw new ORPCError("BAD_REQUEST", { message: "A recording can be at most 10 minutes" });
      }
      if (!isDictationAudioType(input.mimeType)) {
        throw new ORPCError("BAD_REQUEST", {
          message: "That recording isn't an audio type dictation accepts",
        });
      }
      const bytes = new Uint8Array(Buffer.from(input.audio, "base64"));
      if (bytes.byteLength > maxDictationBytes) {
        throw new ORPCError("BAD_REQUEST", { message: "A recording can be at most 25 MB" });
      }
      try {
        const text = await transcribeRecording(context.deps, context.user.id, {
          bytes,
          mimeType: input.mimeType,
          language: input.language,
        });
        return { text };
      } catch (caught) {
        if (caught instanceof DictationError) {
          throw new ORPCError("BAD_REQUEST", {
            message: caught.message,
            data: { reason: caught.reason },
          });
        }
        throw caught;
      }
    }),
};
