import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

/** One request the fake took: its path with its query, and its headers. */
export type NovncRequest = { path: string; headers: IncomingHttpHeaders };

/** The header E2B wants on every request to a sandbox with public traffic off. */
const trafficHeader = "e2b-traffic-access-token";

/**
 * A stand-in for a Screen's noVNC behind E2B, on a local port: websockify's web server and its
 * socket. Like E2B with public traffic off, it refuses (403) any request without the traffic token
 * header. A GET answers `noVNC <path>` (in an HTML page's body for `.html`), or at `/redirect?to=<location>` a 302 there; an upgrade at `/websockify` opens a socket whose binary
 * messages it records, and `send` pushes bytes down every open socket. Just enough of RFC 6455 for
 * one small frame at a time: no new dependency for a test.
 */
export async function fakeNovnc() {
  const requests: NovncRequest[] = [];
  const upgrades: NovncRequest[] = [];
  const messages: number[][] = [];
  const sockets = new Set<Duplex>();
  let closes = 0;
  const server = createServer((request, response) => {
    requests.push({ path: request.url ?? "", headers: request.headers });
    if (!request.headers[trafficHeader]) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://novnc");
    if (url.pathname === "/redirect") {
      response.writeHead(302, { location: url.searchParams.get("to") ?? "/" }).end();
      return;
    }
    // Like websockify's web server: an HTML page has a head, and other files their own type.
    if (url.pathname.endsWith(".html")) {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<!DOCTYPE html><html><head><title>noVNC</title></head><body>noVNC ${request.url}</body></html>`,
        );
      return;
    }
    response.writeHead(200, { "content-type": "text/javascript" }).end(`noVNC ${request.url}`);
  });
  server.on("upgrade", (request, socket: Duplex) => {
    upgrades.push({ path: request.url ?? "", headers: request.headers });
    const key = request.headers["sec-websocket-key"];
    if (!request.headers[trafficHeader] || !request.url?.startsWith("/websockify?") || !key) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    const protocol = request.headers["sec-websocket-protocol"]?.includes("binary")
      ? "Sec-WebSocket-Protocol: binary\r\n"
      : "";
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n${protocol}\r\n`,
    );
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (data: Buffer) => {
      const opcode = data[0]! & 0x0f;
      const length = data[1]! & 0x7f;
      const mask = data.subarray(2, 6);
      const payload = [...data.subarray(6, 6 + length)].map((byte, i) => byte ^ mask[i % 4]!);
      if (opcode === 0x8) {
        closes += 1;
        socket.end(Buffer.from([0x88, 0]));
        return;
      }
      messages.push(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    upgrades,
    messages,
    /** How many sockets the proxy closed with a close frame. */
    get closes() {
      return closes;
    },
    /** Sends `bytes` (under 126) as one binary frame down every open socket. */
    send: (bytes: number[]) => {
      for (const socket of sockets) socket.write(Buffer.from([0x82, bytes.length, ...bytes]));
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
