// A receipt as a PNG, drawn here so the Files eval needs no image file or image library: a few lines
// of text in a 5x7 pixel font, scaled up, encoded as an 8-bit grayscale PNG with node:zlib.

import { deflateSync } from "node:zlib";

/** Each glyph's seven rows, five pixels wide, "1" for ink. */
const font: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  $: ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};

/** The receipt's lines: a cafe, two items and a total the Bot reads off the image. */
export const receiptLines = ["CAFE AURORA", "LATTE    $6.50", "BAGEL    $4.40", "TOTAL   $10.90"];

const scale = 6;
const margin = 4 * scale;
const lineGap = 4 * scale;

/** `lines` drawn black on white, as PNG bytes. Only the glyphs in `font` can be drawn. */
export function textPng(lines: readonly string[]): Uint8Array {
  const columns = Math.max(...lines.map((line) => line.length));
  const width = margin * 2 + columns * 6 * scale;
  const height = margin * 2 + lines.length * 7 * scale + (lines.length - 1) * lineGap;
  const pixels = new Uint8Array(width * height).fill(255);
  lines.forEach((line, row) => {
    [...line].forEach((char, column) => {
      const glyph = font[char];
      if (!glyph) throw new Error(`No glyph for "${char}"`);
      glyph.forEach((bits, y) => {
        [...bits].forEach((bit, x) => {
          if (bit !== "1") return;
          const left = margin + (column * 6 + x) * scale;
          const top = margin + row * (7 * scale + lineGap) + y * scale;
          for (let dy = 0; dy < scale; dy++) {
            pixels.fill(0, (top + dy) * width + left, (top + dy) * width + left + scale);
          }
        });
      });
    });
  });
  // Each row starts with filter type 0.
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit grayscale, deflate, no filter set, no interlace
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typed = concat([new TextEncoder().encode(type), data]);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typed, 4);
  view.setUint32(8 + data.length, crc32(typed));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
