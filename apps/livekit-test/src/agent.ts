import { fileURLToPath } from "node:url";

import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  voice,
} from "@livekit/agents";
import * as silero from "@livekit/agents-plugin-silero";
import { z } from "zod";

import { type TranscriptLine, callEnd, callStart, recordRequest } from "./hooks.ts";

/**
 * The reference Voice agent: it holds a phone call on LiveKit and runs the conversation with its
 * own model. The product only says what to do at the start of the call and hears what happened at
 * the end, through the routes in `hooks.ts`.
 */

const recordRequestTool = (callId: string) =>
  llm.tool({
    description:
      "Record what the caller wants so the business can act on it after the call. Set emergency only for a danger to people or property.",
    parameters: z.object({
      request: z.string().describe("What the caller wants, in one or two sentences"),
      callback: z.string().optional().describe("How or when the caller wants to be reached"),
      emergency: z.boolean().describe("True only for an emergency"),
    }),
    execute: async ({ request, callback, emergency }) => {
      try {
        await recordRequest({ callId, request, callback, emergency });
        return "Recorded.";
      } catch (error) {
        console.error("record_request failed", error);
        return "Not recorded. Tell the caller someone will follow up anyway.";
      }
    },
  });

function transcriptOf(session: voice.AgentSession): TranscriptLine[] {
  return session.history.items.flatMap((item): TranscriptLine[] => {
    if (item.type !== "message" || (item.role !== "user" && item.role !== "assistant")) return [];
    const text = item.textContent?.trim();
    return text ? [{ role: item.role === "user" ? "caller" : "agent", text }] : [];
  });
}

export default defineAgent({
  prewarm: async (process: JobProcess) => {
    process.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const participant = await ctx.waitForParticipant();
    // Logged for the real-call test: which SIP attributes actually arrive.
    console.log("participant attributes", participant.attributes);

    const caller = participant.attributes["sip.phoneNumber"] ?? "";
    const callId = participant.attributes["sip.callID"] ?? ctx.room.name ?? participant.identity;
    const called = participant.attributes["sip.trunkPhoneNumber"];

    // Nothing is published until the hook has answered, so the caller is still hearing it ring.
    const startedAt = performance.now();
    const start = await callStart({ callId, caller, called }).catch((error: unknown) => {
      console.error("call start failed", error);
      return { decision: "decline" } as const;
    });
    console.log(
      `call start took ${Math.round(performance.now() - startedAt)}ms: ${start.decision}`,
    );

    if (start.decision === "decline") {
      await ctx.deleteRoom();
      return;
    }

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new inference.STT({ model: process.env.STT_MODEL ?? "deepgram/nova-3", language: "en" }),
      llm: new inference.LLM({ model: process.env.LLM_MODEL ?? "openai/gpt-5.4-mini" }),
      tts: new inference.TTS({ model: process.env.TTS_MODEL ?? "cartesia/sonic-3" }),
    });

    const limit = setTimeout(() => void ctx.deleteRoom(), start.maxSeconds * 1000);
    ctx.addShutdownCallback(async () => {
      clearTimeout(limit);
      await callEnd({ callId, transcript: transcriptOf(session) }).catch((error: unknown) => {
        console.error("call end failed", error);
      });
    });
    session.on(voice.AgentSessionEventTypes.Close, () => ctx.shutdown("call ended"));

    await session.start({
      agent: new voice.Agent({
        instructions: start.instructions,
        tools: { record_request: recordRequestTool(callId) },
      }),
      room: ctx.room,
    });
    session.say(start.greeting, { allowInterruptions: false });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
