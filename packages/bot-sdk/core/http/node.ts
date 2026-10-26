import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import type { HttpHandler } from "./handler";

/**
 * A Node `(req, res)` listener over a fetch handler, for `http.createServer` and Express-style
 * servers. The response body streams as it is produced (server-sent events included), and a client
 * that disconnects aborts the request's signal and cancels the body. Mount it before any body parser,
 * since it reads the raw request body. A handler that throws answers 500, and a body that fails
 * mid-stream resets the connection; neither rejects the listener (Node servers don't await it), so
 * each error goes to `console.error`.
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
      console.error(error);
      res.statusCode = 500;
      res.end();
      return;
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
      // A client gone mid-stream is no failure; anything else cuts the response short, visibly.
      if (!abort.signal.aborted && !res.destroyed) {
        console.error(error);
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      // A client gone, by the close event or a destroyed response, cancels the body's producer.
      if (abort.signal.aborted || res.destroyed) await reader.cancel().catch(() => {});
      else reader.releaseLock();
      if (!res.destroyed) res.end();
    }
  };
}

/**
 * The fetch `Request` of a Node request, its URL on the `Host` it was sent to. Express's
 * `originalUrl` keeps the mount path that `app.use` strips from `url`. Forwarded headers aren't
 * trusted: behind a proxy, the Host passes them on as it sees fit.
 */
function requestOf(req: IncomingMessage & { originalUrl?: string }, signal: AbortSignal): Request {
  const secure = "encrypted" in req.socket && Boolean(req.socket.encrypted);
  const url = new URL(
    req.originalUrl ?? req.url ?? "/",
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
