/// <reference types="node" />
import { createServer, type Server } from "node:http";

/** The Model the fake Ollama host lists as installed. */
export const fakeModel = "e2e-model";

/** A prompt with this marker, and a link in it, makes the fake Model call `fetch_url` on the link. */
export const fetchMarker = "[fetch]";
const fetchToolName = "fetch_url";

/** The page the fake host serves for `fetch_url`: its title and the text the reply quotes. */
export const fetchedPagePath = "/e2e/article";
export const fetchedPageTitle = "Launch notes";
export const fetchedPageText = "The launch date is 14 March.";

/**
 * A Bot prompt with this marker makes the fake Model call `mcpToolName` (the e2e MCP server's
 * `create_issue`, under its Host key) through `run_tool`, as a Connector tool is called, then
 * send what the tool returned with `send_to_user`.
 */
export const mcpMarker = "[mcp]";
export const mcpToolName = "tracker_create_issue";
/** The arguments the fake Model sends with that call. */
export const mcpToolArguments = { title: "E2E launch" };

/**
 * A prompt with this marker makes the fake Model call `generate_image` (spec #278), when the request
 * offers it. The Host's Image Model is `fakeImageModel`, answered by the fake image adapter.
 */
export const imageMarker = "[image]";
const imageToolName = "generate_image";
export const fakeImageModel = "e2e-image";
export const imagePrompt = "a red bicycle";
/** The reply once the image is made: the Model's words about it, with no pixels. */
export const imageReply = "Here is the image of a red bicycle.";

/**
 * A prompt with this marker makes the fake Model call `create_artifact` with `artifactHtml`, when
 * the request offers it. The prompt's link, if any, is the data the Artifact's script fetches.
 */
export const artifactMarker = "[artifact]";
const createArtifactToolName = "create_artifact";
/** A prompt with this marker makes the fake Model call `update_artifact` on the last Artifact it saw. */
export const updateMarker = "[update]";
const updateArtifactToolName = "update_artifact";
/** The title of the Artifact the fake Model creates, and the heading its first version shows. */
export const artifactTitle = "E2E page";
export const revisedHeading = "Revised page";

/**
 * A Bot's prompt with this marker makes the fake Model call `send_to_user` with `botReply` and
 * `endTurn: true`, so the Turn ends on that one Message. Without it, a Bot's Turn gets plain text
 * and stays quiet.
 */
export const sendMarker = "[send]";
const sendToUserToolName = "send_to_user";
const runToolName = "run_tool";
/** The Auto-review system prompt's first words (`reviewerSystemPrompt`); a call with it gets a verdict. */
const reviewerPromptStart = "You review one tool call";
export const botReply = "Hello from your Bot.";

/** The JSON the fake host serves for the Artifact's fetch, with the CORS header a read would need. */
export const dataPath = "/e2e/data";

/**
 * The HTML the fake Model creates. Its script reports, into the page, whether its `fetch` reached
 * the fake host (which allows it), and whether it can read the parent page or its cookies. The
 * "Shrink" button makes the page shorter, and "Break" throws a script error.
 */
export function artifactHtml(dataUrl: string): string {
  return [
    "<!doctype html><html><body>",
    `<h1>${artifactTitle}</h1>`,
    '<p id="fetch">fetch: pending</p>',
    '<p id="parent">parent: pending</p>',
    '<p id="cookie">cookie: pending</p>',
    "<button id=\"shrink\" onclick=\"document.getElementById('tall').style.height='80px'\">Shrink</button>",
    '<button id="break" onclick="throw new Error(\'boom\')">Break</button>',
    '<div id="tall" style="height:900px"></div>',
    "<script>",
    "function report(id, value) { document.getElementById(id).textContent = id + ': ' + value; }",
    `fetch(${JSON.stringify(dataUrl)}).then(function () { report('fetch', 'allowed'); }, function () { report('fetch', 'blocked'); });`,
    "try { parent.document.title; report('parent', 'reachable'); } catch (error) { report('parent', 'blocked'); }",
    "try { document.cookie; report('cookie', 'readable'); } catch (error) { report('cookie', 'blocked'); }",
    "</script>",
    "</body></html>",
  ].join("");
}

/** What the fake Model's update writes: a new heading, so a later version reads differently. */
export const revisedArtifactHtml = `<!doctype html><html><body><h1>${revisedHeading}</h1></body></html>`;

/** The reply to a create or update: the version the tool saved, or why it saved none. */
export function artifactReply(toolResult: string): string {
  const result = JSON.parse(toolResult) as { version?: number; error?: string };
  if (result.error) return `The Artifact could not be saved: ${result.error}.`;
  return `Saved version ${result.version} of the page.`;
}

/** The reply to an MCP tool's result: what the tool returned, as the Model sees it. */
export function mcpReply(toolResult: string): string {
  return `The issue was created. The tool returned: ${toolResult}`;
}

/** The reply to a `fetch_url` result: the page it read, cited by its link, and what it says. */
export function fetchedReply(toolResult: string): string {
  const result = JSON.parse(toolResult) as {
    url?: string;
    title?: string;
    content?: string;
    error?: string;
  };
  if (result.error) return `The page could not be read: ${result.error}.`;
  return `According to [${result.title}](${result.url}): ${result.content}`;
}

/** The reply to the result of the tool the reply asked for last. */
function replyToTool(asked: string | undefined, content: string): string {
  if (asked === imageToolName) return imageReply;
  if (asked === createArtifactToolName || asked === updateArtifactToolName) {
    return artifactReply(content);
  }
  return fetchedReply(content);
}

/** A reply long enough to see streaming, with Markdown and a code block. */
export function fakeReply(prompt: string) {
  return [
    `You said: **${prompt}**.`,
    "",
    "Here is some code:",
    "",
    "```ts",
    "const answer = 42;",
    "```",
    "",
    "That's all.",
  ].join("\n");
}

/**
 * A prompt with this marker gets a reply with a table too wide for a phone and a code line too
 * long for one, to check that they scroll inside the reply.
 */
export const wideMarker = "[wide]";
export function wideReply(): string {
  return [
    "A wide table:",
    "",
    "| Column one | Column two | Column three | Column four | Column five | Column six |",
    "| --- | --- | --- | --- | --- | --- |",
    "| alpha | bravo | charlie | delta | echo | foxtrot |",
    "",
    "A long line of code:",
    "",
    "```ts",
    "const someVeryLongVariableName = computeSomethingUseful(firstArgument, secondArgument, thirdArgument);",
    "```",
    "",
    "That's all.",
  ].join("\n");
}

/** Reply word by word, this far apart; a prompt with `slowMarker` is slow enough to Stop. */
const chunkDelayMs = 40;
const slowChunkDelayMs = 400;
export const slowMarker = "[slow]";

/**
 * A stand-in Ollama server: `/api/tags` lists `fakeModel`, `/api/chat` streams `fakeReply` of the
 * last user Message as NDJSON (or answers in one piece when `stream` is false, as title
 * generation asks).
 */
export function startFakeOllama(port: number): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url === fetchedPagePath && request.method === "GET") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        `<!doctype html><html><head><title>${fetchedPageTitle}</title></head>` +
          `<body><main><p>${fetchedPageText}</p></main></body></html>`,
      );
      return;
    }
    if (request.url === dataPath && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.setHeader("access-control-allow-origin", "*");
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/api/tags") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ models: [{ name: fakeModel }] }));
      return;
    }
    if (request.url !== "/api/chat" || request.method !== "POST") {
      response.statusCode = 404;
      response.end();
      return;
    }
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const {
        messages,
        stream = true,
        tools = [],
      } = JSON.parse(body) as {
        messages: {
          role: string;
          content: string;
          tool_calls?: { function: { name: string } }[];
        }[];
        stream?: boolean;
        tools?: { function?: { name?: string } }[];
      };
      const prompt = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      const last = messages.at(-1);
      // Answers from a tool result the stream has just added, as a Model would.
      const answering = stream && last?.role === "tool";
      // The tool the reply asked for last, whose result is the one just added.
      const asked = messages.at(-2)?.tool_calls?.[0]?.function.name;
      const offers = (name: string) => tools.some((tool) => tool.function?.name === name);
      // Scripted: a prompt with the marker and a link asks for `fetch_url`, when the request offers it.
      const link = /https?:\/\/\S+/.exec(prompt)?.[0];
      const calls = (name: string, args: Record<string, unknown>) => {
        response.setHeader("content-type", "application/x-ndjson");
        response.end(
          `${JSON.stringify({
            model: fakeModel,
            created_at: new Date().toISOString(),
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ function: { name, arguments: args } }],
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 1,
            eval_count: 1,
          })}\n`,
        );
      };
      if (stream && !answering && link && offers(fetchToolName) && prompt.includes(fetchMarker)) {
        calls(fetchToolName, { url: link });
        return;
      }
      if (stream && !answering && offers(sendToUserToolName) && prompt.includes(sendMarker)) {
        calls(sendToUserToolName, { text: botReply, endTurn: true });
        return;
      }
      if (stream && !answering && offers(runToolName) && prompt.includes(mcpMarker)) {
        calls(runToolName, { name: mcpToolName, args: mcpToolArguments });
        return;
      }
      if (answering && asked === runToolName && offers(sendToUserToolName)) {
        calls(sendToUserToolName, { text: mcpReply(last?.content ?? ""), endTurn: true });
        return;
      }
      if (stream && !answering && offers(imageToolName) && prompt.includes(imageMarker)) {
        calls(imageToolName, { prompt: imagePrompt, aspectRatio: "landscape" });
        return;
      }
      // The Artifact an update changes: the last one the system prompt lists for this Branch.
      const savedArtifactId = messages
        .map((message) => /<artifact id="([^"]+)"/.exec(message.content)?.[1])
        .filter((id): id is string => id !== undefined)
        .at(-1);
      if (
        stream &&
        !answering &&
        offers(createArtifactToolName) &&
        prompt.includes(artifactMarker)
      ) {
        calls(createArtifactToolName, {
          kind: "html",
          title: artifactTitle,
          content: artifactHtml(link ?? ""),
        });
        return;
      }
      if (
        stream &&
        !answering &&
        savedArtifactId &&
        offers(updateArtifactToolName) &&
        prompt.includes(updateMarker)
      ) {
        calls(updateArtifactToolName, {
          artifactId: savedArtifactId,
          content: revisedArtifactHtml,
        });
        return;
      }
      const text =
        messages[0]?.role === "system" && messages[0].content.startsWith(reviewerPromptStart)
          ? JSON.stringify({ outcome: "pass", reason: "You asked for it.", summary: "Call a tool" })
          : last?.role === "tool" && stream
            ? replyToTool(asked, last.content)
            : prompt.includes(wideMarker)
              ? wideReply()
              : fakeReply(prompt.slice(0, 80));
      const line = (content: string, done: boolean) =>
        JSON.stringify({
          model: fakeModel,
          created_at: new Date().toISOString(),
          message: { role: "assistant", content },
          done,
          ...(done && { done_reason: "stop", prompt_eval_count: 1, eval_count: 1 }),
        });

      if (!stream) {
        response.setHeader("content-type", "application/json");
        response.end(line("E2E title", true));
        return;
      }
      response.setHeader("content-type", "application/x-ndjson");
      const words = text.split(/(?<= )/);
      let index = 0;
      const timer = setInterval(
        () => {
          if (response.destroyed) return clearInterval(timer);
          if (index < words.length) {
            response.write(`${line(words[index++] ?? "", false)}\n`);
            return;
          }
          clearInterval(timer);
          response.end(`${line("", true)}\n`);
        },
        prompt.includes(slowMarker) ? slowChunkDelayMs : chunkDelayMs,
      );
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
