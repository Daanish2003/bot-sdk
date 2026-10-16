import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { AnyTextAdapter } from "@tanstack/ai";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventHooks } from "../../../../core/server/index";
import { createBotSdk } from "../../../../core/server/create-chat";
import type { HostProvider } from "../../../../core/server/deps";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { testKeyEncryptionSecret } from "../../../support/deps";
import { insertConversation } from "../../../support/conversations";
import { testDatabaseUrl } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

// The Run's adapter: the handler's `createBotSdk` builds its adapters itself, so the module hands
// it the scripted fake for each test.
const scripted = vi.hoisted(() => ({ adapter: undefined as unknown as AnyTextAdapter }));
vi.mock("../../../../core/server/chat/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../core/server/chat/adapters")>()),
  adapterFor: () => scripted.adapter,
}));

// TypeScript names files with forward slashes, also on Windows.
const sdkRoot = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\\/g, "/");
const readme = readFileSync(`${sdkRoot}README.md`, "utf8");

const basePath = "/api/chat";
const hostModel = "anthropic:claude-sonnet-5-5";
const hostProvider: HostProvider = {
  provider: "anthropic",
  credentials: { apiKey: "sk-ant-host-key" },
  models: [
    {
      modelId: "claude-sonnet-5-5",
      maxOutputTokens: 1_000,
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
    },
  ],
};

/** The recipe's TypeScript: the first code block of the README's "Webhooks from the event hooks". */
function recipeSource(): string {
  const heading = "\n## Webhooks from the event hooks\n";
  const start = readme.indexOf(heading);
  if (start === -1) throw new Error("The README has no Webhooks recipe section");
  const rest = readme.slice(start + heading.length);
  const section = rest.slice(0, rest.indexOf("\n## ") + 1 || undefined);
  const block = /```ts\n([\s\S]*?)```/.exec(section)?.[1];
  if (block === undefined) throw new Error("The Webhooks recipe has no ts code block");
  return block;
}

/** The recipe's type errors, checked against the SDK's own `EventHooks`. */
function recipeTypeErrors(source: string): string[] {
  const fileName = `${sdkRoot}__webhook-recipe.ts`;
  const options: ts.CompilerOptions = {
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
    types: ["node"],
    typeRoots: [`${sdkRoot}../../node_modules/@types`],
    skipLibCheck: true,
    verbatimModuleSyntax: true,
    // The recipe imports `EventHooks` from the Host's copy of the server entry point; here that
    // is the module that declares it, so the check doesn't compile the whole SDK.
    paths: { "@/lib/bot-sdk/core/server": [`${sdkRoot}core/server/chat/hooks.ts`] },
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === fileName
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, ...rest);
  const fileExists = host.fileExists;
  host.fileExists = (name) => name === fileName || fileExists(name);
  const readFile = host.readFile;
  host.readFile = (name) => (name === fileName ? source : readFile(name));
  const program = ts.createProgram([fileName], options, host);
  const file = program.getSourceFile(fileName);
  if (!file) throw new Error("The recipe was not loaded");
  return ts
    .getPreEmitDiagnostics(program, file)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

/** The recipe as a module: its exports, run as JavaScript (its types erased). */
function loadRecipe(): Record<string, (...args: never[]) => unknown> {
  const { outputText } = ts.transpileModule(recipeSource(), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} as Record<string, (...args: never[]) => unknown> };
  new Function("module", "exports", "require", outputText)(module, module.exports, undefined);
  return module.exports;
}

type Recipe = {
  chatWebhookHooks: (options: { url: string; secret: string }) => EventHooks;
  receiveWebhook: (request: Request, secret: string, now?: number) => Promise<unknown>;
};

/** A `createBotSdk` over the test database whose Host hooks come from `hooks`. */
function chatWith(userId: string, hooks: EventHooks): ReturnType<typeof createBotSdk> {
  return createBotSdk({
    databaseUrl: testDatabaseUrl,
    getUser: () => ({ id: userId }),
    keyEncryptionSecrets: [testKeyEncryptionSecret],
    basePath,
    hostProviders: [hostProvider],
    logger: { error: () => {} },
    hooks,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Webhooks recipe in the README", () => {
  it("type-checks against the SDK's EventHooks", () => {
    expect(recipeTypeErrors(recipeSource())).toEqual([]);
  }, 60_000);

  it("sends a real onRunEnd event that its receiver accepts, and rejects a tampered body and a stale timestamp", async () => {
    const recipe = loadRecipe() as Recipe;
    const url = "https://host.example.com/hooks/chat";
    const secret = "whsec_recipe_test_secret";
    const sent: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      sent.push(new Request(input, init));
      return new Response(null, { status: 204 });
    });

    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Signed" });
    scripted.adapter = createFakeAdapter({ rounds: [round(text("Hello", " there"))] }).adapter;
    const chat = chatWith(user.id, recipe.chatWebhookHooks({ url, secret }));

    const response = await chat.handler(
      new Request(`http://localhost${basePath}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: "Hi",
            attachmentIds: [],
            model: hostModel,
            webSearch: false,
          },
        }),
      }),
    );
    await response.text();
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    const [request] = sent as [Request];
    const body = await request.clone().text();
    expect(request.url).toBe(url);
    expect(body).not.toContain("Hello there");

    // The receiver accepts the event the hook signed.
    const received = await recipe.receiveWebhook(request.clone(), secret);
    expect(received).toMatchObject({
      type: "run.ended",
      data: {
        userId: user.id,
        conversationId: conv.id,
        ending: "complete",
        model: hostModel,
        onHostCredentials: true,
        hidden: false,
      },
    });

    // A changed body no longer matches its signature.
    const tampered = new Request(url, {
      method: "POST",
      headers: request.headers,
      body: body.replace('"complete"', '"error"'),
    });
    await expect(recipe.receiveWebhook(tampered, secret)).rejects.toThrow(/signature/i);

    // A signature checked more than five minutes after it was sent is stale.
    await expect(
      recipe.receiveWebhook(request.clone(), secret, Date.now() + 301_000),
    ).rejects.toThrow(/stale/i);
  });
});
