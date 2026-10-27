// A minimal WebSocket server end for the lifecycle eval's live-view host (RFC 6455): it accepts an
// upgrade, reads the browser's masked frames and sends unmasked ones. It exists because the SDK has
// no WebSocket server dependency; a real Host mounts the SDK's socket hooks on crossws instead.

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type AcceptedSocket = {
  send: (data: Uint8Array | string) => void;
  close: () => void;
};

/** Frame `payload` unmasked, as a server sends it. */
function frame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65_536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), Buffer.alloc(8)]);
  if (length >= 65_536) header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

/**
 * Completes the upgrade on `socket` (choosing `protocol` when set) and returns the socket's sender.
 * `onMessage` gets each complete message; `onClose` runs once when the socket ends.
 */
export function acceptSocket(
  request: IncomingMessage,
  socket: Duplex,
  protocol: string | undefined,
  handlers: { onMessage: (data: Uint8Array) => void; onClose: () => void },
): AcceptedSocket {
  const key = String(request.headers["sec-websocket-key"]);
  const accept = createHash("sha1")
    .update(key + guid)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
      "",
      "",
    ].join("\r\n"),
  );

  let buffered = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let closed = false;
  const end = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
    handlers.onClose();
  };

  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.length < 2) return;
      const opcode = buffered[0]! & 0x0f;
      const fin = (buffered[0]! & 0x80) !== 0;
      const masked = (buffered[1]! & 0x80) !== 0;
      let length = buffered[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        length = Number(buffered.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (buffered.length < offset + maskLength + length) return;
      const payload = Buffer.from(
        buffered.subarray(offset + maskLength, offset + maskLength + length),
      );
      if (masked) {
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] = payload[i]! ^ buffered[offset + (i % 4)]!;
        }
      }
      buffered = buffered.subarray(offset + maskLength + length);
      if (opcode === 8) {
        socket.write(frame(8, Buffer.alloc(0)));
        return end();
      }
      if (opcode === 9) socket.write(frame(10, payload));
      else if (opcode === 0 || opcode === 1 || opcode === 2) {
        fragments.push(payload);
        if (fin) {
          handlers.onMessage(Buffer.concat(fragments));
          fragments = [];
        }
      }
    }
  });
  socket.on("close", end);
  socket.on("error", end);

  return {
    send: (data) => {
      if (closed) return;
      socket.write(typeof data === "string" ? frame(1, Buffer.from(data)) : frame(2, data));
    },
    close: end,
  };
}
