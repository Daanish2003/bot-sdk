import { describe, expect, it } from "vitest";

import { defineFeature } from "../../../core/server/index";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { featureSectionsNow, featureTools } from "../../../plugins/bot/server/context";
import {
  ComputerOperationError,
  ComputerUnavailableError,
} from "../../../plugins/computer/server/internal";
import { knowledge } from "../../../plugins/knowledge/server/plugin";
import { memory } from "../../../plugins/memory/server/feature";
import { skills } from "../../../plugins/skills/server/plugin";
import { createTestSdk } from "../../support/deps";
import { getTestDb } from "../../support/test-database";
import { insertUser } from "../../support/users";

/*
 * What a feature's failure does to a Turn (spec #871), as main's memory, Skills and Knowledge
 * snapshots did: a Computer that can't be woken or read leaves the Turn without the feature's
 * section, while any other failure throws, so the job retries. An away Summary carries on without
 * the section whatever failed.
 */

const silent = { error: () => {} };

const turnOf = (userId: string) => ({
  id: uuidv7(),
  userId,
  botId: uuidv7(),
  conversationId: uuidv7(),
});

/** A Computer handle whose every operation throws `error`. */
const failingComputer = (error: Error) => ({
  forUser: () =>
    new Proxy(
      {},
      {
        // Not a thenable: an awaited handle resolves to itself.
        get: (_target, key) => (key === "then" ? undefined : () => Promise.reject(error)),
      },
    ),
});

/** The built-in features' `prompt`, over a Computer whose every operation throws `error`. */
async function promptWith(feature: "memory" | "skills" | "knowledge", error: Error) {
  const user = await insertUser();
  const definition = { memory, skills, knowledge }[feature]();
  const context = {
    db: getTestDb(),
    logger: silent,
    clock: () => new Date(),
    computer: failingComputer(error),
  };
  return definition.prompt!(
    {
      ...turnOf(user.id),
      built: null,
      told: [],
      startedAt: new Date(),
      earlier: [],
      signal: new AbortController().signal,
    },
    context as never,
  );
}

describe("a feature's failure", { timeout: 30_000 }, () => {
  it.each(
    (["memory", "skills", "knowledge"] as const).flatMap((feature) => [
      [feature, "can't be woken", new ComputerUnavailableError("u", new Error("down"))] as const,
      [feature, "can't be read", new ComputerOperationError(new Error("exit 1"))] as const,
    ]),
  )("%s: a Computer that %s leaves the Turn without the section", async (feature, _how, error) => {
    const read = await promptWith(feature, error);
    expect(read?.section ?? null).toBeNull();
  });

  it.each(["memory", "skills", "knowledge"] as const)(
    "%s: any other failure throws, so the job retries",
    async (feature) => {
      await expect(promptWith(feature, new TypeError("a bug"))).rejects.toThrow("a bug");
    },
  );

  it("throws a feature's failed Prompt start section on a Turn, and leaves it out of an away Summary", async () => {
    const broken = defineFeature({
      id: "broken",
      prompt: async () => {
        throw new Error("prompt failed");
      },
    });
    const deps = createTestSdk({ features: [broken], logger: silent });
    const user = await insertUser();
    const signal = new AbortController().signal;

    await expect(featureSectionsNow(deps, turnOf(user.id), new Date(), signal)).rejects.toThrow(
      "prompt failed",
    );
    expect(
      await featureSectionsNow(deps, turnOf(user.id), new Date(), signal, { tolerant: true }),
    ).toEqual([]);
  });

  it("memory: lists no search_memory for a Prompt start without the memory section, as an away Summary reads it", async () => {
    const user = await insertUser();
    const context = { db: getTestDb(), logger: silent, clock: () => new Date() };
    const listed = await memory().tools!({ ...turnOf(user.id), section: null }, context as never);
    expect(listed).toEqual([]);
  });

  it("leaves out a feature whose tools throw when only the definitions are read, as an away Summary does", async () => {
    const broken = defineFeature({
      id: "broken",
      tools: async () => {
        throw new Error("tools failed");
      },
    });
    const deps = createTestSdk({ features: [broken], logger: silent });
    const user = await insertUser();
    const definitionOnly = () => {
      throw new Error("not called");
    };

    const listed = await featureTools(deps, turnOf(user.id), definitionOnly, new Set(), []);

    expect(listed.tools).toEqual([]);
  });
});
