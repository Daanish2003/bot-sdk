import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Recorded = {
  method: string;
  token: string;
  /** The JSON body, or the multipart form's text fields (a file is `{ name, size }`). */
  body: Record<string, unknown>;
};

export type Reply = { status?: number; body: unknown } | { bytes: Uint8Array };

/**
 * A local fake Telegram Bot API: answers each method from `replies` (a value, or a function of the
 * request's body) and records every request, as the web push and Mailpit tests do.
 */
export class FakeBotApi {
  readonly requests: Recorded[] = [];
  readonly replies = new Map<string, Reply | ((body: Record<string, unknown>) => Reply)>();
  url = "";
  private server: Server;

  constructor() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        void this.handle(request.url ?? "", request.headers["content-type"], Buffer.concat(chunks))
          .then((reply) => {
            if ("bytes" in reply) {
              response.writeHead(200).end(reply.bytes);
              return;
            }
            response
              .writeHead(reply.status ?? 200, { "content-type": "application/json" })
              .end(JSON.stringify(reply.body));
          })
          .catch((error) => response.writeHead(500).end(String(error)));
      });
    });
  }

  private async handle(path: string, contentType: string | undefined, raw: Buffer) {
    const file = /^\/file\/bot([^/]+)\/(.+)$/.exec(path);
    if (file) {
      const reply = this.replies.get(`file:${file[2]}`);
      return typeof reply === "function" ? reply({}) : (reply ?? { status: 404, body: {} });
    }
    const [, token = "", method = ""] = /^\/bot([^/]+)\/(.+)$/.exec(path) ?? [];
    let body: Record<string, unknown> = {};
    if (contentType?.startsWith("multipart/")) {
      const form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
      for (const [key, value] of form.entries()) {
        body[key] = typeof value === "string" ? value : { name: value.name, size: value.size };
      }
    } else if (raw.length > 0) {
      body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    }
    this.requests.push({ method, token, body });
    const reply = this.replies.get(method) ?? { body: { ok: true, result: true } };
    return typeof reply === "function" ? reply(body) : reply;
  }

  of(method: string): Recorded[] {
    return this.requests.filter((request) => request.method === method);
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
