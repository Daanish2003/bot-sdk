/**
 * The three routes a Voice agent calls, as `apps/livekit-test` sees them. The product will serve
 * the same contract per voice account; `stand-in-hooks.ts` serves it locally until then.
 */

export type CallStart =
  | { decision: "decline" }
  | {
      decision: "answer";
      instructions: string;
      greeting: string;
      maxSeconds: number;
    };

export type TranscriptLine = { role: "caller" | "agent"; text: string };

const baseUrl = process.env.VOICE_HOOK_URL ?? "http://localhost:4100";
const timeoutMs = 5_000;

async function post(path: string, body: unknown): Promise<Response> {
  const response = await fetch(`${baseUrl}/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.VOICE_HOOK_SECRET ?? ""}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${path} hook answered ${response.status}`);
  return response;
}

export async function callStart(input: {
  callId: string;
  caller: string;
  called: string | undefined;
}): Promise<CallStart> {
  const response = await post("start", input);
  return (await response.json()) as CallStart;
}

export async function recordRequest(input: {
  callId: string;
  request: string;
  callback: string | undefined;
  emergency: boolean;
}): Promise<void> {
  await post("request", input);
}

export async function callEnd(input: {
  callId: string;
  transcript: TranscriptLine[];
}): Promise<void> {
  await post("end", input);
}
