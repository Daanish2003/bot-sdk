import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { RateLimitedError } from "../../../../core/client/rate-limit";
import { attachment, usage } from "../../../../core/server/db/schema";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import type { Credentials, HostProvider } from "../../../../core/server/deps";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { resolveRateLimits } from "../../../../core/server/rate-limits";
import { maxDictationBytes } from "../../../../core/shared/chat/voice";
import { createTestSdk, type TestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeTranscription } from "../../../support/fake-transcription-adapter";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser, type TestUser } from "../../../support/users";

const audio = Buffer.from("not really webm").toString("base64");
const recording = { audio, mimeType: "audio/webm;codecs=opus", durationSeconds: 4 };

/** Own Provider keys for a user, by Provider. */
async function saveOwnKeys(deps: TestDeps, user: TestUser, services: string[]) {
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
  duration,
  billedSeconds,
  byok = true,
  ...overrides
}: TestDepsOverrides & {
  error?: Error;
  text?: string;
  duration?: number;
  billedSeconds?: number;
} = {}) {
  const fake = createFakeTranscription({ text, error, duration, billedSeconds });
  const engines: Array<{ model: string; credentials: Credentials }> = [];
  const deps = createTestSdk({
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

/** A Host Provider that offers the given transcription Models, with a key that must never reach a user. */
function hostWith(
  provider: HostProvider["provider"],
  transcriptionModels: NonNullable<HostProvider["transcriptionModels"]>,
): HostProvider {
  return {
    provider,
    credentials: { apiKey: `sk-host-${provider}` },
    models: [],
    transcriptionModels,
  };
}

const hostOpenai = hostWith("openai", [
  { model: "gpt-4o-mini-transcribe", pricePerMinuteUsd: 0.006 },
]);
const hostGroq = hostWith("groq", [{ model: "whisper-large-v3-turbo", pricePerMinuteUsd: 0.6 }]);

/** The usage rows of a user, without their ids and creation times. */
async function usageOf(userId: string) {
  const rows = await getTestDb().select().from(usage).where(eq(usage.userId, userId));
  return rows.map(({ id: _id, createdAt: _createdAt, ...row }) => row);
}

/** Spend already in the window: a Run that cost `costMicros`. */
async function spend(userId: string, costMicros: number) {
  await getTestDb().insert(usage).values({
    id: uuidv7(),
    userId,
    kind: "run",
    model: "anthropic:claude-sonnet-5-5",
    inputTokens: 0,
    outputTokens: 0,
    costMicros,
    estimated: false,
    createdAt: new Date(),
  });
}

/** When the UTC day after `now` starts, which is when a "day" Quota resets. */
function nextUtcDay(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

describe("voice.status on Host credentials", () => {
  it("is available on the Host's transcription Model when the caller has no key of their own", async () => {
    const { deps } = setup({ hostProviders: [hostOpenai] });
    const user = await insertUser();

    await expect(chatRpc({ user, deps }).voice.status()).resolves.toEqual({
      transcription: { available: true, onHostCredentials: true },
    });
  });

  it("stays on the caller's own key over the Host's", async () => {
    const { deps } = setup({ hostProviders: [hostOpenai] });
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["openai"]);

    await expect(chatRpc({ user, deps }).voice.status()).resolves.toEqual({
      transcription: { available: true, onHostCredentials: false },
    });
  });

  it("is unavailable when the Host offers no transcription Model", async () => {
    const { deps } = setup({
      hostProviders: [{ provider: "openai", credentials: { apiKey: "sk-host" }, models: [] }],
    });
    const user = await insertUser();

    await expect(chatRpc({ user, deps }).voice.status()).resolves.toEqual({
      transcription: { available: false, onHostCredentials: false },
    });
  });

  it("uses the Host's Model with byok off, even with a key of the caller's own", async () => {
    const { deps } = setup({ byok: false, hostProviders: [hostOpenai] });
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["openai"]);

    await expect(chatRpc({ user, deps }).voice.status()).resolves.toEqual({
      transcription: { available: true, onHostCredentials: true },
    });
  });
});

describe("voice.transcribe on Host credentials", () => {
  it("transcribes on the Host's first transcription Model with the Host's key", async () => {
    const { deps, engines } = setup({ hostProviders: [hostOpenai] });
    const user = await insertUser();

    await expect(chatRpc({ user, deps }).voice.transcribe(recording)).resolves.toEqual({
      text: "Hello there",
    });
    expect(engines).toEqual([
      { model: "openai:gpt-4o-mini-transcribe", credentials: { apiKey: "sk-host-openai" } },
    ]);
  });

  it("takes the first Provider entry that offers a transcription Model", async () => {
    const { deps, engines } = setup({
      hostProviders: [
        { provider: "openai", credentials: { apiKey: "sk-host-openai" }, models: [] },
        hostGroq,
        hostOpenai,
      ],
    });
    const user = await insertUser();

    await chatRpc({ user, deps }).voice.transcribe(recording);

    expect(engines.map((engine) => engine.model)).toEqual(["groq:whisper-large-v3-turbo"]);
  });

  it("uses the caller's own key before the Host's Model, whichever Provider", async () => {
    const { deps, engines } = setup({ hostProviders: [hostOpenai] });
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["groq"]);

    await chatRpc({ user, deps }).voice.transcribe(recording);

    expect(engines).toEqual([
      { model: "groq:whisper-large-v3-turbo", credentials: { apiKey: "sk-own-groq" } },
    ]);
  });

  it("with byok off, uses only the Host's Model and ignores the caller's key", async () => {
    const { deps, engines } = setup({ byok: false, hostProviders: [hostOpenai] });
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["groq"]);

    await chatRpc({ user, deps }).voice.transcribe(recording);

    expect(engines).toEqual([
      { model: "openai:gpt-4o-mini-transcribe", credentials: { apiKey: "sk-host-openai" } },
    ]);
  });

  it("refuses as quota_exceeded, with the reset time, once the window's spend reaches the budget", async () => {
    const { deps, engines } = setup({
      hostProviders: [hostOpenai],
      getQuota: async () => ({ budgetUsd: 0.01, window: "day" }),
    });
    const user = await insertUser();
    await spend(user.id, 10_000);

    await expect(chatRpc({ user, deps }).voice.transcribe(recording)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "quota_exceeded", resetsAt: nextUtcDay(new Date()) },
    });
    expect(engines).toEqual([]);
  });

  it("does not check or meter the caller's own key, even over the Quota", async () => {
    const { deps, engines } = setup({
      hostProviders: [hostOpenai],
      getQuota: async () => ({ budgetUsd: 0.01, window: "day" }),
    });
    const user = await insertUser();
    await saveOwnKeys(deps, user, ["openai"]);
    await spend(user.id, 10_000);

    await expect(chatRpc({ user, deps }).voice.transcribe(recording)).resolves.toEqual({
      text: "Hello there",
    });
    expect(engines.map((engine) => engine.model)).toEqual(["openai:gpt-4o-mini-transcribe"]);
    expect((await usageOf(user.id)).map((row) => row.kind)).toEqual(["run"]);
  });

  it("counts a transcription's spend against the Quota for the next one", async () => {
    // One minute of audio at $0.60 costs 600,000 micros, over a $0.10 budget.
    const { deps, engines } = setup({
      hostProviders: [
        hostWith("openai", [{ model: "gpt-4o-mini-transcribe", pricePerMinuteUsd: 0.6 }]),
      ],
      getQuota: async () => ({ budgetUsd: 0.1, window: "day" }),
    });
    const user = await insertUser();
    const client = chatRpc({ user, deps });

    await client.voice.transcribe({ ...recording, durationSeconds: 60 });

    await expect(client.voice.transcribe(recording)).rejects.toMatchObject({
      data: { reason: "quota_exceeded" },
    });
    expect(engines).toHaveLength(1);
  });

  it("writes no usage row when the Provider fails", async () => {
    const { deps } = setup({ hostProviders: [hostOpenai], error: new Error("socket hang up") });
    const user = await insertUser();

    await expect(chatRpc({ user, deps }).voice.transcribe(recording)).rejects.toMatchObject({
      data: { reason: "failed" },
    });
    expect(await usageOf(user.id)).toEqual([]);
  });
});

describe("voice.transcribe usage on Host credentials", () => {
  /** Transcribes one recording on Host credentials and returns the caller's usage rows. */
  async function transcribeOnHost({
    host = hostOpenai,
    durationSeconds = 4,
    ...options
  }: {
    host?: HostProvider;
    durationSeconds?: number;
    duration?: number;
    billedSeconds?: number;
  }) {
    const { deps } = setup({ hostProviders: [host], ...options });
    const user = await insertUser();
    await chatRpc({ user, deps }).voice.transcribe({ ...recording, durationSeconds });
    return usageOf(user.id);
  }

  it("prices the duration the Provider reports, as a transcription row", async () => {
    // 90 seconds at $0.006 a minute is $0.009, which is 9,000 micros.
    expect(await transcribeOnHost({ duration: 90, durationSeconds: 30 })).toEqual([
      {
        userId: expect.any(String),
        kind: "transcription",
        model: "openai:gpt-4o-mini-transcribe",
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 9_000,
        estimated: false,
      },
    ]);
  });

  it("prices the seconds the Provider bills when it reports no duration", async () => {
    // 120 billed seconds at $0.006 a minute is 12,000 micros.
    const [row] = await transcribeOnHost({ billedSeconds: 120, durationSeconds: 30 });

    expect(row).toMatchObject({ costMicros: 12_000, estimated: false });
  });

  it("estimates from the recording's length when the Provider reports neither", async () => {
    // 30 seconds at $0.006 a minute is 3,000 micros, marked estimated.
    const [row] = await transcribeOnHost({ durationSeconds: 30 });

    expect(row).toMatchObject({ costMicros: 3_000, estimated: true });
  });

  it("bills Groq's 10-second minimum on an estimate", async () => {
    // 4 seconds is billed as 10: at $0.60 a minute that is 100,000 micros.
    const [row] = await transcribeOnHost({ host: hostGroq, durationSeconds: 4 });

    expect(row).toMatchObject({
      model: "groq:whisper-large-v3-turbo",
      costMicros: 100_000,
      estimated: true,
    });
  });

  it("bills Groq's 10-second minimum on a reported duration too", async () => {
    const [row] = await transcribeOnHost({ host: hostGroq, duration: 5, durationSeconds: 5 });

    expect(row).toMatchObject({ costMicros: 100_000, estimated: false });
  });

  it("does not apply Groq's minimum to another Provider", async () => {
    // 4 seconds at $0.006 a minute is 400 micros.
    const [row] = await transcribeOnHost({ duration: 4, durationSeconds: 4 });

    expect(row).toMatchObject({ costMicros: 400 });
  });
});
