import { conversation, message, project } from "../../../../core/server/db/schema/chat";
import { toolDefinition } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { HostToolContext } from "../../../../core/server/chat/host-tools";
import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps } from "../../../../core/server/deps";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { citationPrompt } from "../../../../core/shared/chat/citations";
import type { ChatCommand } from "../../../../core/shared/chat/command";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { getTestDb } from "../../../support/test-database";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { createFakeSearchClient } from "../../../support/fake-search-client";
import { chatRpc, sendAs } from "../../../support/sdk";
import { insertUser } from "../../../support/users";

const anthropicModel = "anthropic:claude-sonnet-5-5";
const userInstructions = "Answer briefly. Use British spelling.";
const projectInstructions = "This Project is about thesis work.";
const basePath = "http://localhost/api/chat";

type Rounds = Parameters<typeof createFakeAdapter>[0]["rounds"];

/**
 * A signed-in user with Anthropic and Tavily keys, the user's own Instructions, an optional Project
 * with Instructions, and scripted adapters: one per `adapterFor` call, in order.
 */
async function setup({
  scripts = [[round(text("Sure."))]],
  manual = false,
  tools = [],
  projectNotes = projectInstructions,
  inProject = true,
}: {
  scripts?: Rounds[];
  manual?: boolean;
  tools?: ReturnType<typeof sendMail>[];
  projectNotes?: string | null;
  inProject?: boolean;
} = {}) {
  const user = await insertUser();
  const fakes = scripts.map((rounds) => createFakeAdapter({ rounds, manual }));
  const adapters = fakes.map((fake) => fake.adapter);
  const deps = createTestDeps({
    adapterFor: () => {
      const next = adapters.shift();
      if (!next) throw new Error("No more fake adapters");
      return next;
    },
    searchClient: createFakeSearchClient({ results: [] }),
    tools,
  });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  await saveCredentials(deps, user.id, {
    service: "tavily",
    fields: { apiKey: "tvly-test-key" },
    hint: "…-key",
    verified: true,
  });
  await chatRpc({ user, deps }).settings.setInstructions({ instructions: userInstructions });
  const projectId = uuidv7();
  await getTestDb()
    .insert(project)
    .values({ id: projectId, userId: user.id, name: "Thesis", instructions: projectNotes });
  const conv = await insertConversation(user, {
    title: "Project chat",
    ...(inProject ? { projectId } : {}),
  });
  const send = (command: Partial<ChatCommand> = {}) =>
    sendAs(
      new Request(`${basePath}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: "What's new?",
            attachmentIds: [],
            model: anthropicModel,
            webSearch: false,
            ...command,
          },
        }),
      }),
      user,
      deps,
    );
  return { user, deps, fakes, conv, projectId, send };
}

async function messagesOf(deps: AppDeps, conversationId: string) {
  return deps.db
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt), asc(message.role));
}

describe("Project Instructions in a Run", () => {
  it("are sent after the SDK's own prompts and then the user's Instructions, the Project's last", async () => {
    const { fakes, send } = await setup();

    await (await send({ webSearch: true })).text();

    expect(fakes[0]!.calls[0]!.systemPrompts).toEqual([
      citationPrompt,
      userInstructions,
      projectInstructions,
    ]);
  });

  it("are sent without web search, after the user's Instructions", async () => {
    const { fakes, send } = await setup();

    await (await send({ webSearch: false })).text();

    expect(fakes[0]!.calls[0]!.systemPrompts).toEqual([userInstructions, projectInstructions]);
  });

  it("are sent alone when the user has none", async () => {
    const { fakes, deps, user, send } = await setup();
    await chatRpc({ user, deps }).settings.setInstructions({ instructions: null });

    await (await send({ webSearch: false })).text();

    expect(fakes[0]!.calls[0]!.systemPrompts).toEqual([projectInstructions]);
  });

  it("are not sent to a Conversation with no Project", async () => {
    const { fakes, send } = await setup({ inProject: false });

    await (await send({ webSearch: false })).text();

    expect(fakes[0]!.calls[0]!.systemPrompts).toEqual([userInstructions]);
  });

  it("are not sent when the Project has none", async () => {
    const { fakes, send } = await setup({ projectNotes: null });

    await (await send({ webSearch: false })).text();

    expect(fakes[0]!.calls[0]!.systemPrompts).toEqual([userInstructions]);
  });

  it("from an edited Project apply to the next Run, and leave the earlier reply as it was", async () => {
    const { fakes, deps, user, conv, projectId, send } = await setup({
      scripts: [[round(text("First."))], [round(text("Second."))]],
    });
    await (await send({ webSearch: false })).text();
    const [before] = (await messagesOf(deps, conv.id)).filter((row) => row.role === "assistant");

    await chatRpc({ user, deps }).project.update({
      id: projectId,
      name: "Thesis",
      instructions: "Now answer in French.",
    });
    const [question] = (await messagesOf(deps, conv.id)).filter((row) => row.role === "user");
    await (await send({ text: undefined, parentId: question!.id, webSearch: false })).text();

    expect(fakes[1]!.calls[0]!.systemPrompts).toEqual([userInstructions, "Now answer in French."]);
    const [after] = (await messagesOf(deps, conv.id)).filter((row) => row.role === "assistant");
    expect(after!.parts).toEqual(before!.parts);
  });

  it("follow a Conversation moved to another Project from its next Run", async () => {
    const { fakes, deps, user, conv, send } = await setup({
      scripts: [[round(text("First."))], [round(text("Second."))]],
    });
    const other = uuidv7();
    await getTestDb()
      .insert(project)
      .values({ id: other, userId: user.id, name: "Other", instructions: "Other rules." });
    await (await send({ webSearch: false })).text();

    await chatRpc({ user, deps }).conversation.move({ id: conv.id, projectId: other });
    const [question] = (await messagesOf(deps, conv.id)).filter((row) => row.role === "user");
    await (await send({ text: undefined, parentId: question!.id, webSearch: false })).text();

    expect(fakes[1]!.calls[0]!.systemPrompts).toEqual([userInstructions, "Other rules."]);
  });

  it("are sent to a resumed Run after an Approval, as the Run that asked", async () => {
    const { fakes, deps, user, conv, send } = await setup({
      scripts: [[round(mailCall("call-1"))], [round(text("Sent."))]],
      tools: [sendMail([])],
    });
    await (await send({ webSearch: false })).text();
    const [reply] = (await messagesOf(deps, conv.id)).filter((row) => row.role === "assistant");

    await chatRpc({ user, deps }).chat.decide({ messageId: reply!.id, approved: true });
    await sendAs(
      new Request(`${basePath}/run?runId=${reply!.id}`, { method: "GET" }),
      user,
      deps,
    ).then((response) => response.text());

    expect(fakes[1]!.calls[0]!.systemPrompts).toEqual([userInstructions, projectInstructions]);
  });
});

describe("a Project's Instructions and the Shared link", () => {
  it("never reach the snapshot a Shared link serves", async () => {
    const { user, deps, conv, projectId } = await setup();
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hello" });
    await insertMessage({
      conversationId: conv.id,
      parentId: question!.id,
      role: "assistant",
      text: "Hi there",
      active: true,
    });
    const client = chatRpc({ user, deps });
    const link = await client.share.upsert({ conversationId: conv.id });

    const shared = await chatRpc({ deps }).share.get({ token: link.token });

    const snapshot = JSON.stringify(shared);
    expect(snapshot).toContain("Hi there");
    expect(snapshot).not.toContain("Thesis");
    expect(snapshot).not.toContain(projectInstructions);
    expect(snapshot).not.toContain(projectId);
  });

  it("continued by a viewer, the copy has no Project and sends only the viewer's Instructions", async () => {
    const { user, deps, fakes, conv } = await setup({
      scripts: [[round(text("Continued."))]],
    });
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hello" });
    await insertMessage({
      conversationId: conv.id,
      parentId: question!.id,
      role: "assistant",
      text: "Hi there",
      active: true,
    });
    const link = await chatRpc({ user, deps }).share.upsert({ conversationId: conv.id });
    const viewer = await insertUser();
    await saveCredentials(deps, viewer.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-viewer-key" },
      hint: "…-key",
      verified: true,
    });
    await chatRpc({ user: viewer, deps }).settings.setInstructions({ instructions: "Be terse." });

    const { id } = await chatRpc({ user: viewer, deps }).share.continue({ token: link.token });

    const [copy] = await deps.db.select().from(conversation).where(eq(conversation.id, id));
    expect(copy?.projectId).toBeNull();
    const viewerSend = sendAs(
      new Request(`${basePath}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: id,
            parentId: null,
            text: "Go on",
            attachmentIds: [],
            model: anthropicModel,
            webSearch: false,
          },
        }),
      }),
      viewer,
      deps,
    );
    await (await viewerSend).text();

    expect(fakes[0]!.calls[0]!.systemPrompts).toEqual(["Be terse."]);
  });
});

const mailArgs = z.object({ to: z.string(), body: z.string() });

/** A Host tool that needs Approval, so its reply waits for a decision. */
function sendMail(runs: Array<z.infer<typeof mailArgs>>) {
  return toolDefinition({
    name: "send_mail",
    description: "Sends an email.",
    inputSchema: mailArgs,
    needsApproval: true,
  }).server<HostToolContext>(async (args) => {
    runs.push(args);
    return { sent: true, to: args.to };
  });
}

const mailCall = (id: string) =>
  toolCall({ id, name: "send_mail", input: { to: "a@b.c", body: "Hi" } });
