/**
 * The media type, width and height of an image's bytes, read from its header. The formats the
 * Providers return (PNG, JPEG, WebP). `undefined` for anything else.
 */
export type ImageInfo = { mediaType: string; width: number; height: number };

export function imageInfo(bytes: Uint8Array): ImageInfo | undefined {
  return pngInfo(bytes) ?? jpegInfo(bytes) ?? webpInfo(bytes);
}

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

function pngInfo(bytes: Uint8Array): ImageInfo | undefined {
  // The signature, then the IHDR chunk: its width and height are the first two 32-bit fields.
  if (bytes.length < 24 || bytes[0] !== 0x89 || ascii(bytes, 1, 3) !== "PNG") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    mediaType: "image/png",
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
}

function jpegInfo(bytes: Uint8Array): ImageInfo | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    // A start-of-frame marker (SOF0-SOF15, without DHT, JPG and DAC) carries the size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        mediaType: "image/jpeg",
        height: view.getUint16(at + 5),
        width: view.getUint16(at + 7),
      };
    }
    at += 2 + view.getUint16(at + 2);
  }
  return undefined;
}

function webpInfo(bytes: Uint8Array): ImageInfo | undefined {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = ascii(bytes, 12, 4);
  if (format === "VP8 ") {
    return {
      mediaType: "image/webp",
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (format === "VP8L") {
    const bits = view.getUint32(21, true);
    return {
      mediaType: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (format === "VP8X") {
    return {
      mediaType: "image/webp",
      width: (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1,
      height: (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1,
    };
  }
  return undefined;
}
