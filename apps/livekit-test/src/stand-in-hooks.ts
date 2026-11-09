import { createServer } from "node:http";

import type { CallStart } from "./hooks.ts";

/**
 * A local stand-in for the product's three voice routes, for the real-call test. It logs what the
 * Voice agent sends and answers with a fixed Representative. Callers listed in
 * `STAND_IN_DECLINE_CALLERS` are declined, to test declining before answering.
 */

const port = Number(process.env.VOICE_HOOK_PORT ?? 4100);
const secret = process.env.VOICE_HOOK_SECRET;
const declined = (process.env.STAND_IN_DECLINE_CALLERS ?? "").split(",").filter(Boolean);

if (!secret) throw new Error("VOICE_HOOK_SECRET is not set");

const answer: CallStart = {
  decision: "answer",
  greeting:
    "Thanks for calling Cool Air Heating and Cooling. I'm an automated assistant, and this call may be transcribed. How can I help?",
  instructions: [
    "You answer the phone for Cool Air Heating and Cooling, an HVAC business.",
    "Speak in short, plain sentences and ask one question at a time.",
    "Published facts: open Monday to Friday, 8am to 6pm. A service visit costs 89 dollars.",
    "Topics you may answer: opening hours and the service visit price.",
    "On any other topic, say someone will confirm by text.",
    "When the caller wants something done, use record_request. If it fails, still say someone will follow up.",
    "If the caller reports a gas smell or a fire, tell them to leave the building and call 911, then use record_request with emergency set to true.",
  ].join(" "),
  maxSeconds: 600,
};

const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);

  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  if (request.headers.authorization !== `Bearer ${secret}`)
    return reply(401, { error: "unauthorized" });

  const path = request.url;
  if (request.method !== "POST" || !["/start", "/request", "/end"].includes(path ?? "")) {
    return reply(404, { error: "not found" });
  }

  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { caller?: string };
  console.log(new Date().toISOString(), path, JSON.stringify(body, null, 2));

  if (path !== "/start") return reply(200, { ok: true });
  return reply(200, declined.includes(body.caller ?? "") ? { decision: "decline" } : answer);
});

server.listen(port, () => console.log(`Stand-in hooks on http://localhost:${port}`));
