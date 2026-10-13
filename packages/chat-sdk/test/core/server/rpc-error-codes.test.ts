import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { en } from "../../../core/shared/i18n";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "../../../core/server");

/** Every `.ts` file under `dir`, relative to the Chat SDK's `core/server`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") ? [relative(serverDir, path).replaceAll("\\", "/")] : [];
  });
}

const files = sourceFiles(serverDir).map((file) => ({
  file,
  source: readFileSync(join(serverDir, file), "utf8"),
}));

describe("oRPC errors carry a dictionary code", () => {
  it("builds every oRPC error through rpcError, never with ORPCError directly", () => {
    const direct = files
      .filter(({ file, source }) => file !== "rpc-error.ts" && /new ORPCError\(/.test(source))
      .map(({ file }) => file);

    expect(direct).toEqual([]);
  });

  it("lists the codes the server sends: each has a dictionary key, and each key has a use", () => {
    const used = new Set(
      files.flatMap(({ source }) =>
        [...source.matchAll(/"(error\.\w+)"/g)].map((match) => match[1] ?? ""),
      ),
    );
    // error.unexpected is the client's own fallback, so the server never sends it.
    const keys = Object.keys(en).filter(
      (key) => key.startsWith("error.") && key !== "error.unexpected",
    );

    for (const code of used) expect(en).toHaveProperty([code]);
    expect([...used].sort()).toEqual(keys.sort());
  });
});
