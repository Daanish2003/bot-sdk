import { z } from "zod";

import {
  isDictationAudioType,
  maxDictationBytes,
  maxDictationSeconds,
} from "../../../../core/shared/chat/voice";
import { DictationError, dictationEngine, transcribeRecording } from "../transcription";
import { protectedProcedure } from "../../../../core/server/procedures";
import { modelsDeps } from "../state";
import { rpcError } from "../../../../core/server/rpc-error";

/** A base64 string of `maxDictationBytes` decodes to at most that many bytes. */
const maxAudioChars = Math.ceil(maxDictationBytes / 3) * 4;

export const voiceRouter = {
  /**
   * Whether the caller can dictate: a key of their own for OpenAI, Groq or Grok (with `byok` on),
   * else the Host's transcription Model. `onHostCredentials` says the Host pays, so the Quota applies.
   */
  status: protectedProcedure.handler(async ({ context }) => {
    const engine = await dictationEngine(modelsDeps(context), context.user.id);
    return {
      transcription: {
        available: engine !== null,
        onHostCredentials: engine?.meter.onHost === true,
      },
    };
  }),

  /**
   * Transcribes one recording, with the caller's own Provider key or the Host's transcription Model,
   * and returns its text. The audio is never stored. Refused over 10 minutes, over 25 MB, or for a
   * type other than audio.
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
        throw rpcError(
          "BAD_REQUEST",
          "error.recordingTooLong",
          "A recording can be at most 10 minutes",
        );
      }
      if (!isDictationAudioType(input.mimeType)) {
        throw rpcError(
          "BAD_REQUEST",
          "error.recordingType",
          "That recording isn't an audio type dictation accepts",
        );
      }
      const bytes = new Uint8Array(Buffer.from(input.audio, "base64"));
      if (bytes.byteLength > maxDictationBytes) {
        throw rpcError(
          "BAD_REQUEST",
          "error.recordingTooLarge",
          "A recording can be at most 25 MB",
        );
      }
      try {
        const text = await transcribeRecording(modelsDeps(context), context.user.id, {
          bytes,
          mimeType: input.mimeType,
          durationSeconds: input.durationSeconds,
          language: input.language,
        });
        return { text };
      } catch (caught) {
        if (caught instanceof DictationError) {
          throw rpcError("BAD_REQUEST", "error.dictationFailed", caught.message, undefined, {
            reason: caught.reason,
            resetsAt: caught.resetsAt?.toISOString(),
          });
        }
        throw caught;
      }
    }),
};
