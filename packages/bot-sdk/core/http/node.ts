import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import type { HttpHandler } from "./handler";

/**
 * A Node `(req, res)` listener over a fetch handler, for `http.createServer` and Express-style
 * servers. The response body streams as it is produced (server-sent events included), and a client
 * that disconnects aborts the request's signal.
 */
export function toNodeHandler(
  handler: HttpHandler,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    let response: Response;
    try {
      response = await handler(requestOf(req, abort.signal));
    } catch (error) {
      // The client gets an answer; the error still reaches the server's caller.
      res.statusCode = 500;
      res.end();
      throw error;
    }
    res.statusCode = response.status;
    if (response.statusText) res.statusMessage = response.statusText;
    for (const [name, value] of response.headers) {
      if (name !== "set-cookie") res.setHeader(name, value);
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) res.setHeader("set-cookie", cookies);
    if (!response.body) {
      res.end();
      return;
    }
    res.flushHeaders();
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || res.destroyed) break;
        if (!res.write(value)) await once(res, "drain", { signal: abort.signal });
      }
    } catch (error) {
      // A client gone mid-stream is no failure; anything else is.
      if (!abort.signal.aborted) throw error;
    } finally {
      if (abort.signal.aborted) await reader.cancel().catch(() => {});
      else reader.releaseLock();
      res.end();
    }
  };
}

/** The fetch `Request` of a Node request, its URL on the `Host` it was sent to. */
function requestOf(req: IncomingMessage, signal: AbortSignal): Request {
  const secure = "encrypted" in req.socket && Boolean(req.socket.encrypted);
  const url = new URL(
    req.url ?? "/",
    `${secure ? "https" : "http"}://${req.headers.host ?? "localhost"}`,
  );
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    signal,
    ...(hasBody && { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" }),
  } as RequestInit);
}
