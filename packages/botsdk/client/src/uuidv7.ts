/**
 * A uuidv7 (RFC 9562): a 48-bit millisecond timestamp, then random bits. Sorts by creation time. It
 * runs in the browser and on the server, so a client can make the id of a Message it sends (#498).
 */
export function uuidv7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let index = 5, rest = now; index >= 0; index--, rest = Math.floor(rest / 256)) {
    bytes[index] = rest % 256;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
