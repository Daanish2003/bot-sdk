import { isProcedure, type AnyProcedure, type AnyRouter } from "@orpc/server";
import { describe, expect, it } from "vitest";

import { createBotSdk, httpPartsOf } from "../../../core/server/create-chat";
import { emailChannel } from "../../../plugins/channel/server/index";
import { fakeEmailProvider } from "../../../plugins/channel/fake/index";
import { knowledge } from "../../../plugins/knowledge/server/plugin";
import { mcp } from "../../../plugins/mcp/server/plugin";
import { memory } from "../../../plugins/memory/server/feature";
import { skills } from "../../../plugins/skills/server/plugin";
import { fakeComputerProvider } from "../../support/fake-computer-provider";
import { postgres } from "../../../core/server/database";

/** Every procedure under `router`, by its dotted path. */
function proceduresOf(router: AnyRouter, path: string[] = []): [string, AnyProcedure][] {
  if (isProcedure(router)) return [[path.join("."), router]];
  return Object.entries(router).flatMap(([key, child]) =>
    proceduresOf(child as AnyRouter, [...path, key]),
  );
}

/**
 * A stand-in for the SDK that records each call made on it: any property is another stand-in, and
 * calling one records its arguments and returns another.
 */
function recordingSdk() {
  const calls: { path: string; args: unknown[] }[] = [];
  const at = (path: string[]): unknown =>
    new Proxy(() => {}, {
      // Not a thenable, so an awaited stand-in resolves to itself.
      get: (_target, key) => (key === "then" ? undefined : at([...path, String(key)])),
      apply: (_target, _this, args: unknown[]) => {
        calls.push({ path: path.join("."), args });
        return at([...path, "()"]);
      },
    });
  return { sdk: at([]), calls };
}

// Every router the HTTP layer serves, of an instance with every feature and the email Channel.
const { router: routers } = httpPartsOf(
  createBotSdk({
    database: postgres({ connectionString: "postgresql://postgres:password@127.0.0.1:1/unused" }),
    keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
    models: {},
    computer: fakeComputerProvider().provider,
    channels: [
      emailChannel({ provider: fakeEmailProvider().provider, domain: "bots.example", appUrl: "" }),
    ],
    features: [memory(), skills(), knowledge(), mcp()],
  }),
);

describe("the procedures", () => {
  it("act as the signed-in user, whatever `userId` the input carries", async () => {
    const actedAs = new Set<string>();
    let checked = 0;
    for (const [path, procedure] of proceduresOf(routers as AnyRouter)) {
      const { sdk, calls } = recordingSdk();
      // The handler alone, past the input schema: a looser schema would let `userId` through.
      await (async () =>
        procedure["~orpc"].handler({
          context: { user: { id: "signed-in" }, sdk },
          input: { userId: "someone-else", botId: "bot" },
          path: path.split("."),
          procedure,
          signal: undefined,
          lastEventId: undefined,
          errors: {},
        }))().catch(() => {});
      for (const { args } of calls) {
        for (const arg of args) {
          const userId = (arg as { userId?: unknown } | null)?.userId;
          if (typeof userId !== "string") continue;
          checked += 1;
          actedAs.add(`${path}: ${userId}`);
        }
      }
    }

    expect(checked).toBeGreaterThan(40);
    expect([...actedAs].filter((entry) => !entry.endsWith(": signed-in"))).toEqual([]);
  });
});
