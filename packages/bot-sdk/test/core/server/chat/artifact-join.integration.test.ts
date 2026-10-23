import { message } from "../../../../core/server/db/schema";
import { parsePartialJSON } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import { insertConversation } from "../../../support/conversations";
import { createTestSdk, type TestDeps, sendAs } from "../../../support/assistant";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { insertUser, type TestUser } from "../../../support/users";

const anthropicModel = "anthropic:claude-sonnet-5-5";

const page = { kind: "html", title: "Landing page", content: "<h1>Hi</h1>" };

/**
 * A signed-in user whose Model streams a create_artifact call in four argument deltas, and a
 * manual adapter that lets the test release each chunk.
 */
async function setup() {
  const user: TestUser = await insertUser();
  const fake = createFakeAdapter({
    rounds: [
      round(toolCall({ id: "call-1", name: "create_artifact", input: page, split: 4 })),
      round(text("Done.")),
    ],
    manual: true,
  });
  const deps: TestDeps = createTestSdk({ adapterFor: () => fake.adapter, artifacts: true });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  const conv = await insertConversation(user, { title: "Artifacts", model: anthropicModel });
  const send = () =>
    sendAs(
      new Request("http://localhost/api/chat/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: "Make me a page",
            attachmentIds: [],
            model: anthropicModel,
            webSearch: false,
          },
        }),
      }),
      user,
      deps,
    );
  return { user, deps, fake, conv, send };
}

/** The argument deltas of every TOOL_CALL_ARGS event in a server-sent event body, in order. */
function argumentDeltas(sse: string): string[] {
  return sse
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string; delta?: string })
    .filter((event) => event.type === "TOOL_CALL_ARGS")
    .map((event) => event.delta ?? "");
}

describe("joining a Run mid-call", () => {
  it("a client that joins while an Artifact's arguments stream gets the deltas it needs to rebuild them", async () => {
    const { user, deps, fake, conv, send } = await setup();
    const posting = await send();
    const [reply] = await deps.db
      .select()
      .from(message)
      .where(eq(message.conversationId, conv.id))
      .orderBy(asc(message.createdAt))
      .then((rows) => rows.filter((row) => row.role === "assistant"));

    // RUN_STARTED, TOOL_CALL_START and the first two argument deltas have streamed.
    await fake.release(4);
    const join = await sendAs(
      new Request(`http://localhost/api/chat/run?offset=-1&runId=${reply!.id}`),
      user,
      deps,
    );
    const joined = join.text();
    await fake.releaseAll();
    const posted = await posting.text();

    const joinedDeltas = argumentDeltas(await joined);
    expect(joinedDeltas).toEqual(argumentDeltas(posted));
    expect(joinedDeltas).toHaveLength(4);
    // The first two deltas already rebuild the Artifact's kind, as a partial parse.
    expect(parsePartialJSON(joinedDeltas.slice(0, 2).join(""))).toMatchObject({ kind: "html" });
    expect(JSON.parse(joinedDeltas.join(""))).toEqual(page);
  });
});
