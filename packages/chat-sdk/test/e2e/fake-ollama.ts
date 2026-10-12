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
 * A prompt with this marker makes the fake Model call `mcpToolName` (the e2e MCP server's
 * `create_issue`, under its Host key), when the request offers it.
 */
export const mcpMarker = "[mcp]";
export const mcpToolName = "tracker_create_issue";
/** The arguments the fake Model sends with that call. */
export const mcpToolArguments = { title: "E2E launch" };

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
      if (stream && !answering && offers(mcpToolName) && prompt.includes(mcpMarker)) {
        calls(mcpToolName, mcpToolArguments);
        return;
      }
      const text =
        last?.role === "tool" && stream
          ? asked === mcpToolName
            ? mcpReply(last.content)
            : fetchedReply(last.content)
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
