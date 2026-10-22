import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createBotSdk } from "../../../../core/server/create-chat";
import { runner } from "../../../../plugins/runner/server/plugin";
import { models } from "../../../../plugins/models/server/plugin";
import { defineJob } from "../../../../plugins/runner/server/jobs/define";
import { testDatabaseUrl } from "../../../support/test-database";

const silent = { error: () => {} };
const handled = vi.fn(async (_payload: { label: string }) => {});

defineJob({
  name: "test.run-job.echo",
  payload: z.object({ label: z.string() }),
  run: (payload) => handled(payload),
});

function chatWithTestDb() {
  return createBotSdk({
    databaseUrl: testDatabaseUrl,
    getUser: () => null,
    keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
    basePath: "/api/chat",
    logger: silent,
    plugins: [models(), runner()],
  });
}

describe("chat.runJob", () => {
  it("runs the named job's handler with the validated payload", async () => {
    handled.mockClear();
    const chat = chatWithTestDb();

    await chat.plugin("runner").runJob("test.run-job.echo", { label: "hello" });

    expect(handled).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledWith({ label: "hello" });
  });

  it("rejects a payload that fails the job's schema, without running the handler", async () => {
    handled.mockClear();
    const chat = chatWithTestDb();

    await expect(chat.plugin("runner").runJob("test.run-job.echo", { label: 42 })).rejects.toThrow(
      /test\.run-job\.echo.*invalid payload/,
    );
    expect(handled).not.toHaveBeenCalled();
  });

  it("rejects an unknown job name", async () => {
    const chat = chatWithTestDb();

    await expect(chat.plugin("runner").runJob("test.run-job.missing", {})).rejects.toThrow(
      /Unknown job "test\.run-job\.missing"/,
    );
  });
});
