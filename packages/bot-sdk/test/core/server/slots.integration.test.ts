import { eq } from "drizzle-orm";
import { pgSchema, text } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  createBotSdk,
  defineFeature,
  memoryRuntime,
  type BotSdkOptions,
  type SlotOptions,
} from "../../../core/server/index";
import { buildBotSdk } from "../../../core/server/create-chat";
import { blob, bot } from "../../../core/server/db/schema";
import type { ComputerApi } from "../../../plugins/computer/server/plugin";
import { isInProcessRunner } from "../../../plugins/runner/server/jobs/in-process";
import { runnerJobs } from "../../../plugins/runner/server/plugin";
import { fakeComputerProvider } from "../../plugins/computer/server/fake-provider";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";
import { insertUser } from "../../support/users";

/*
 * The factory's flat slots (spec #871): what an omitted slot falls back to, and a feature's
 * `needs` and `schema` checked at construction.
 */

const basePath = "/api/chat";
const keyEncryptionSecrets = ["test-key-encryption-secret-not-for-production"];
const unreachable = "postgresql://nobody:nothing@127.0.0.1:1/unreachable";

const shared = { databaseUrl: unreachable, getUser: () => null, keyEncryptionSecrets, basePath };

const slots = (options: Partial<SlotOptions & BotSdkOptions> = {}) =>
  ({ ...shared, models: {}, ...options }) as BotSdkOptions;

describe("createBotSdk with flat slots", () => {
  it("serves the Bots, Models and Channels with no plugin listed", async () => {
    const user = await insertUser();
    const sdk = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => ({ id: user.id }),
      keyEncryptionSecrets,
      basePath,
      models: {},
      channels: [],
    });

    const call = (path: string) =>
      sdk.handler(
        new Request(`http://localhost${basePath}/rpc/${path}`, { method: "POST", body: "{}" }),
      );
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

  it("falls back to the in-process runner, Postgres blobs and no Computer", async () => {
    const { context } = buildBotSdk(slots({ databaseUrl: testDatabaseUrl }), {});

    await context.blobStore.put("slots-test", new TextEncoder().encode("bytes"), {
      contentType: "text/plain",
    });

    expect(isInProcessRunner(runnerJobs(context))).toBe(true);
    expect(context.hasPlugin("computer")).toBe(false);
    const rows = await getTestDb().select().from(blob).where(eq(blob.key, "slots-test"));
    expect(rows).toHaveLength(1);
    await getTestDb().delete(blob).where(eq(blob.key, "slots-test"));
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
  it.each(["then", "bot", "models", "runner", "channel", "core"])(
    "can't be %s, which the instance or the core holds",
    (id) => {
      expect(() => createBotSdk(slots({ features: [defineFeature({ id })] }))).toThrow(
        `Feature id "${id}" is reserved by the core`,
      );
    },
  );
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
