import { describe, expect, it } from "vitest";

import { RateLimitedError } from "../../../../core/client/rate-limit";
import { attachment } from "../../../../core/server/db/schema/attachment";
import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps, Credentials } from "../../../../core/server/deps";
import { resolveRateLimits } from "../../../../core/server/rate-limits";
import { maxDictationBytes } from "../../../../core/shared/chat/voice";
import { createTestDeps } from "../../../support/deps";
import { createFakeTranscription } from "../../../support/fake-transcription-adapter";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser, type TestUser } from "../../../support/users";

const audio = Buffer.from("not really webm").toString("base64");
const recording = { audio, mimeType: "audio/webm;codecs=opus", durationSeconds: 4 };

/** Own Provider keys for a user, by Provider. */
async function saveOwnKeys(deps: AppDeps, user: TestUser, services: string[]) {
  for (const service of services) {
    await saveCredentials(deps, user.id, {
      service,
      fields: { apiKey: `sk-own-${service}` },
      hint: "…key",
      verified: true,
    });
  }
}

/**
 * Deps whose transcription adapter is `fake`, recording the engine each call was built for: its
 * `"provider:model"` id and the credentials it was given.
 */
function setup({
  error,
  text,
  byok = true,
  ...overrides
}: Partial<AppDeps> & { error?: Error; text?: string } = {}) {
  const fake = createFakeTranscription({ text, error });
  const engines: Array<{ model: string; credentials: Credentials }> = [];
  const deps = createTestDeps({
    byok,
    transcriptionAdapterFor: (model, credentials) => {
      engines.push({ model, credentials });
      return fake.adapter;
    },
    ...overrides,
  });
  return { deps, engines, fake };
}

describe("voice.status", () => {
  it.each(["openai", "groq", "grok"])(
    "is available on the caller's own %s key, and not on Host credentials",
    async (service) => {
      const { deps } = setup();
      const user = await insertUser();
      await saveOwnKeys(deps, user, [service]);

      await expect(chatRpc({ user, deps }).voice.status()).resolves.toEqual({
        transcription: { available: true, onHostCredentials: false },
      });
    },
  );

  it("is unavailable with no key of the caller's own", async () => {
    const { deps } = setup();
    const user = await insertUser();
    const other = await insertUser();
    await saveOwnKeys(deps, other, ["openai"]);

    await expect(chatRpc({ user, deps }).voice.status()).resolves.toEqual({
      transcription: { available: false, onHostCredentials: false },
    });
  });

  it("is unavailable with byok off, even with a key", async () => {
    const { deps } = setup({ byok: false });
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["openai"]);

    await expect(chatRpc({ user, deps }).voice.status()).resolves.toEqual({
      transcription: { available: false, onHostCredentials: false },
    });
  });
});

describe("voice.transcribe engines", () => {
  it("transcribes on the caller's OpenAI key with gpt-4o-mini-transcribe", async () => {
    const { deps, engines, fake } = setup({ text: "Plan the trip" });
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["openai"]);

    const result = await chatRpc({ user, deps }).voice.transcribe(recording);

    expect(result).toEqual({ text: "Plan the trip" });
    expect(engines).toEqual([
      { model: "openai:gpt-4o-mini-transcribe", credentials: { apiKey: "sk-own-openai" } },
    ]);
    expect(fake.calls).toHaveLength(1);
  });

  it("uses Groq's whisper-large-v3-turbo when only Groq is saved", async () => {
    const { deps, engines } = setup();
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["groq"]);

    await chatRpc({ user, deps }).voice.transcribe(recording);

    expect(engines.map((engine) => engine.model)).toEqual(["groq:whisper-large-v3-turbo"]);
  });

  it("uses Grok's grok-stt when only Grok is saved", async () => {
    const { deps, engines } = setup();
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["grok"]);

    await chatRpc({ user, deps }).voice.transcribe(recording);

    expect(engines.map((engine) => engine.model)).toEqual(["grok:grok-stt"]);
  });

  it("prefers OpenAI over Groq, and Groq over Grok", async () => {
    const { deps, engines } = setup();
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["grok", "groq", "openai"]);

    await chatRpc({ user, deps }).voice.transcribe(recording);

    expect(engines.map((engine) => engine.model)).toEqual(["openai:gpt-4o-mini-transcribe"]);
  });

  it("refuses as unavailable with no key of the caller's own", async () => {
    const { deps, engines } = setup();
    const user = await insertUser();

    await expect(chatRpc({ user, deps }).voice.transcribe(recording)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "unavailable" },
    });
    expect(engines).toEqual([]);
  });

  it("refuses as unavailable with byok off, even with a key", async () => {
    const { deps, engines } = setup({ byok: false });
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["openai"]);

    await expect(chatRpc({ user, deps }).voice.transcribe(recording)).rejects.toMatchObject({
      data: { reason: "unavailable" },
    });
    expect(engines).toEqual([]);
  });

  it("fails with invalid_key on a rejected key, without trying the next engine", async () => {
    const rejected = Object.assign(new Error("Incorrect API key"), { status: 401 });
    const { deps, engines } = setup({ error: rejected });
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["openai", "groq"]);

    await expect(chatRpc({ user, deps }).voice.transcribe(recording)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "invalid_key" },
    });
    expect(engines.map((engine) => engine.model)).toEqual(["openai:gpt-4o-mini-transcribe"]);
  });

  it("reports a Provider's rate limit as rate_limited", async () => {
    const limited = Object.assign(new Error("Too many requests"), { status: 429 });
    const { deps } = setup({ error: limited });
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["openai"]);

    await expect(chatRpc({ user, deps }).voice.transcribe(recording)).rejects.toMatchObject({
      data: { reason: "rate_limited" },
    });
  });

  it("reports any other Provider failure as failed", async () => {
    const { deps } = setup({ error: new Error("socket hang up") });
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["openai"]);

    await expect(chatRpc({ user, deps }).voice.transcribe(recording)).rejects.toMatchObject({
      data: { reason: "failed" },
    });
  });
});

describe("voice.transcribe limits", () => {
  it("refuses a recording over 10 minutes before the Provider is called", async () => {
    const { deps, engines } = setup();
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["openai"]);

    await expect(
      chatRpc({ user, deps }).voice.transcribe({ ...recording, durationSeconds: 601 }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("10 minutes"),
    });
    expect(engines).toEqual([]);
  });

  it("accepts a recording of exactly 10 minutes", async () => {
    const { deps } = setup();
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["openai"]);

    await expect(
      chatRpc({ user, deps }).voice.transcribe({ ...recording, durationSeconds: 600 }),
    ).resolves.toEqual({ text: "Hello there" });
  });

  it("refuses audio over 25 MB before the Provider is called", async () => {
    const { deps, engines } = setup();
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["openai"]);
    const oversize = Buffer.alloc(maxDictationBytes + 1).toString("base64");

    await expect(
      chatRpc({ user, deps }).voice.transcribe({ ...recording, audio: oversize }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("25 MB") });
    expect(engines).toEqual([]);
  });

  it.each(["video/mp4", "text/plain", "application/octet-stream"])(
    "refuses a %s recording",
    async (mimeType) => {
      const { deps, engines } = setup();
      const user = await insertUser();
      await saveOwnKeys(deps, user, ["openai"]);

      await expect(
        chatRpc({ user, deps }).voice.transcribe({ ...recording, mimeType }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(engines).toEqual([]);
    },
  );

  it("answers 429 with Retry-After past the transcription limit", async () => {
    const { deps } = setup({
      rateLimits: resolveRateLimits({ transcription: { limit: 1, windowSeconds: 600 } }),
    });
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["openai"]);
    const client = chatRpc({ user, deps });

    await client.voice.transcribe(recording);

    await expect(client.voice.transcribe(recording)).rejects.toMatchObject({
      retryAfterSeconds: expect.any(Number),
    });
    await expect(client.voice.transcribe(recording)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("allows 30 transcriptions in 10 minutes by default", async () => {
    const { deps } = setup();
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["openai"]);
    const client = chatRpc({ user, deps });

    for (let attempt = 0; attempt < 30; attempt++) {
      await client.voice.transcribe(recording);
    }
    await expect(client.voice.transcribe(recording)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("keeps the audio out of the database", async () => {
    const { deps } = setup();
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["openai"]);

    await chatRpc({ user, deps }).voice.transcribe(recording);

    expect(await getTestDb().select().from(attachment)).toEqual([]);
  });
});
