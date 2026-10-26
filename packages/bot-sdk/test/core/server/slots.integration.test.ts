import { eq } from "drizzle-orm";
import { pgSchema, text } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";

import { createHttpHandler } from "../../../core/http/index";
import {
  createBotSdk,
  defineFeature,
  memoryRuntime,
  type BotSdkOptions,
} from "../../../core/server/index";
import { buildBotSdk } from "../../../core/server/create-chat";
import { blob, bot, job } from "../../../core/server/storage";
import type { ComputerApi } from "../../../plugins/computer/server/internal";
import { fakeEmailProvider } from "../../../plugins/channel/fake/index";
import { emailChannel, type InboundMail } from "../../../plugins/channel/server/index";
import { models } from "../../../plugins/models/server/internal";
import { defineJob } from "../../../plugins/runner/server/internal";
import { manualExecutor } from "../../support/executors";
import { fakeComputerProvider } from "../../support/fake-computer-provider";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";
import { insertUser } from "../../support/users";

/*
 * The factory's flat slots (spec #871): what an omitted slot falls back to, and a feature's
 * `needs` and `schema` checked at construction.
 */

const basePath = "/api/chat";
const keyEncryptionSecrets = ["test-key-encryption-secret-not-for-production"];
const unreachable = "postgresql://nobody:nothing@127.0.0.1:1/unreachable";

const shared = { databaseUrl: unreachable, keyEncryptionSecrets };

const slots = (options: Partial<BotSdkOptions> = {}) =>
  ({ ...shared, models: {}, ...options }) as BotSdkOptions;

const slotsJob = defineJob({
  name: "slots.job",
  payload: z.object({ n: z.number() }),
  run: async ({ n }) => {
    slotsRan.push(n);
  },
});
const slotsRan: number[] = [];

describe("createBotSdk with flat slots", () => {
  it("serves the Bots, Models and Channels with no plugin listed", async () => {
    const user = await insertUser();
    const sdk = createBotSdk({
      databaseUrl: testDatabaseUrl,
      keyEncryptionSecrets,
      models: {},
      channels: [],
    });

    const http = createHttpHandler(sdk, { basePath, getUser: () => ({ id: user.id }) });
    const call = (path: string) =>
      http(new Request(`http://localhost${basePath}/rpc/${path}`, { method: "POST", body: "{}" }));
    const [bots, mode] = [await call("bot/list"), await call("credentials/mode")];

    expect([bots.status, mode.status]).toEqual([200, 200]);
    expect(await bots.json()).toEqual({ json: [] });
  });

  it("serves the Models the models slot configures as sdk.models", async () => {
    vi.setSystemTime(new Date("2026-10-10T18:00:00Z"));
    try {
      const user = await insertUser();
      const sdk = createBotSdk(
        slots({
          databaseUrl: testDatabaseUrl,
          models: { getQuota: () => ({ budgetUsd: 2, window: "day" }), byok: false },
        }),
      );

      expect(await sdk.models.quota(user.id)).toEqual({
        budgetMicros: 2_000_000,
        spentMicros: 0,
        window: "day",
        resetsAt: new Date("2026-10-11T00:00:00Z"),
      });
      expect(sdk.models.byok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves the Bots as sdk.bots and the channels slot's adapters as sdk.channels", async () => {
    const email = fakeEmailProvider();
    const sdk = createBotSdk(
      slots({
        databaseUrl: testDatabaseUrl,
        channels: [emailChannel({ provider: email.provider, domain: "bots.example", appUrl: "" })],
      }),
    );

    const unknownToken = await sdk.routines.receiveWebhook({ token: "nope", body: "{}" });
    const stranger = await email.provider.parseInbound(
      email.request({ from: "x@example.com", to: ["nobody@bots.example"], text: "hi" }),
    );
    if ("rejected" in stranger) throw new Error(stranger.rejected);

    expect(unknownToken).toBe("notFound");
    await expect(sdk.channels.receive("email", stranger)).resolves.toBeUndefined();
  });

  it("gives Auto-review the reviewModel option's Model, and none when it's unset", () => {
    const set = createBotSdk(slots({ reviewModel: "openai:gpt-5.4-mini" }));
    const unset = createBotSdk(slots());

    // What Auto-review reads (`review.ts`): the Host's Model, else the Bot's own.
    expect(set.bots.reviewModel).toBe("openai:gpt-5.4-mini");
    expect(unset.bots.reviewModel).toBeUndefined();
  });

  it("has no plugin lookup and takes no plugin list (#887)", () => {
    const sdk = createBotSdk(slots());

    expect("plugin" in sdk).toBe(false);
    expect(() =>
      // @ts-expect-error -- the plugin-list shape is gone: the core is always on.
      createBotSdk({ ...shared, plugins: [] }),
    ).toThrow(/models slot/);
  });

  it("has no Channel besides web when the channels slot is empty", async () => {
    const sdk = createBotSdk(slots({ databaseUrl: testDatabaseUrl }));

    await expect(sdk.channels.receive("email", {} as InboundMail)).rejects.toThrow(
      /no email adapter/,
    );
  });

  it(
    "falls back to the in-process runner, Postgres blobs and no Computer",
    { timeout: 30_000 },
    async () => {
      const { context, instance } = buildBotSdk(
        slots({ databaseUrl: testDatabaseUrl, jobs: [slotsJob] }),
        {},
      );

      await context.blobStore.put("slots-test", new TextEncoder().encode("bytes"), {
        contentType: "text/plain",
      });

      // No runner slot, yet a queued job runs: the in-process runner is the default.
      slotsRan.length = 0;
      await instance.start();
      try {
        const id = await instance.runner.enqueue("slots.job", { n: 7 });
        await expect
          .poll(async () => (await instance.runner.status(id))?.status, { timeout: 10_000 })
          .toBe("succeeded");
        expect(slotsRan).toEqual([7]);
        expect(context.computer !== null).toBe(false);
        const rows = await getTestDb().select().from(blob).where(eq(blob.key, "slots-test"));
        expect(rows).toHaveLength(1);
      } finally {
        await instance.stop();
        await getTestDb().delete(blob).where(eq(blob.key, "slots-test"));
        await getTestDb().delete(job).where(eq(job.name, "slots.job"));
      }
    },
  );

  it("wakes the instance's jobs up through the runner slot's Executor", async () => {
    const manual = manualExecutor();
    // Models alone: this test is about the runner slot, not the Bots.
    const sdk = buildBotSdk(
      slots({ runner: manual.executor, jobs: [slotsJob] }),
      { db: getTestDb() },
      [models()],
    ).instance;

    const id = await sdk.runner.enqueue("slots.job", { n: 1 });

    expect(manual.notified).toEqual([{ jobId: id }]);
    expect((await sdk.runner.status(id))?.status).toBe("queued");
  });

  it("gives the context the computer slot's Computer", () => {
    const { context } = buildBotSdk(slots({ computer: fakeComputerProvider().provider }), {});

    expect(context.computer !== null).toBe(true);
  });

  it("warns at start that in-memory pub/sub works in one process only, unless pubsub is given", async () => {
    const warned = vi.fn();
    const logger = { error: () => {}, warn: warned };
    const omitted = createBotSdk(slots({ databaseUrl: testDatabaseUrl, logger }));
    const given = createBotSdk(
      slots({ databaseUrl: testDatabaseUrl, logger, pubsub: memoryRuntime() }),
    );

    await omitted.start();
    await omitted.stop();
    expect(warned).toHaveBeenCalledTimes(1);
    expect(String(warned.mock.calls[0]?.[0])).toMatch(/one process/);

    await given.start();
    await given.stop();
    expect(warned).toHaveBeenCalledTimes(1);
  });

  it("warns through a class-based logger, called on the logger", async () => {
    class Logger {
      lines: string[] = [];
      error() {}
      warn(line: string) {
        this.lines.push(line);
      }
    }
    const logger = new Logger();
    const sdk = createBotSdk(slots({ databaseUrl: testDatabaseUrl, logger }));

    await sdk.start();
    await sdk.stop();

    expect(logger.lines).toHaveLength(1);
  });
});

describe("a feature's id", () => {
  const refuses = (id: string) =>
    expect(() => createBotSdk(slots({ features: [defineFeature({ id })] }))).toThrow(
      `Feature id "${id}" is reserved by the core`,
    );

  it.each(["then", "bot", "core", "channel", "rules", "first_message", "version", "exportedAt"])(
    "can't be %s, which the core holds",
    refuses,
  );

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "toJSON"])(
    "can't be %s, which every object inherits",
    refuses,
  );

  it("can't be any namespace of the instance", () => {
    const namespaces = Object.keys(createBotSdk(slots()));
    expect(namespaces).toContain("users");
    for (const id of namespaces) refuses(id);
  });
});

describe("a feature's enabling", () => {
  it("throws for a feature listed twice", () => {
    expect(() =>
      createBotSdk(
        slots({ features: [defineFeature({ id: "twice" }), defineFeature({ id: "twice" })] }),
      ),
    ).toThrow('Feature "twice" is enabled twice');
  });
});

describe("a feature's needs", () => {
  const needsComputer = () =>
    defineFeature({
      id: "probe",
      needs: ["computer"],
      api: ({ computer }) => ({ computer: () => computer }),
    });

  it("throw at construction when the Computer slot is empty", () => {
    expect(() => createBotSdk(slots({ features: [needsComputer()] }))).toThrow(
      /Feature "probe" needs the Computer/,
    );
  });

  it("arrive non-optional in the feature's context once the slot is set", () => {
    const sdk = createBotSdk({
      ...shared,
      models: {},
      computer: fakeComputerProvider().provider,
      features: [needsComputer()],
    });

    expectTypeOf(sdk.probe.computer).returns.toEqualTypeOf<ComputerApi>();
    expect(typeof sdk.probe.computer().forUser).toBe("function");
  });

  it("leave a service the feature didn't ask for out of its context", () => {
    defineFeature({
      id: "plain",
      api: (context) => {
        // @ts-expect-error -- `computer` isn't in `needs`
        void context.computer;
        return {};
      },
    });
  });
});

describe("a feature's schema", () => {
  const chat = pgSchema("chat");

  it("can't add columns to a core table", () => {
    const widened = chat.table("bot", { extra: text("extra") });
    expect(() =>
      createBotSdk(slots({ features: [defineFeature({ id: "widen", schema: { widened } })] })),
    ).toThrow(/Feature "widen" declares the core table "bot"/);
  });

  it("may reference a core table", () => {
    const note = chat.table("test_note", {
      id: text("id").primaryKey(),
      botId: text("bot_id").references(() => bot.id),
    });
    expect(() =>
      createBotSdk(slots({ features: [defineFeature({ id: "notes", schema: { note } })] })),
    ).not.toThrow();
  });
});
