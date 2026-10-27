import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { en } from "@botsdk/client/i18n";

const sdkDir = join(dirname(fileURLToPath(import.meta.url)), "../../..");
// The core's source (@botsdk/bot), its HTTP layer included.
const serverDir = join(
  dirname(createRequire(import.meta.url).resolve("@botsdk/bot/package.json")),
  "src",
);
// The server code: the core's, and each feature plugin's.
const serverDirs = [
  serverDir,
  ...readdirSync(join(sdkDir, "plugins"))
    .map((name) => join(sdkDir, "plugins", name, "server"))
    .filter((dir) => existsSync(dir)),
];

/** Every `.ts` file under `dir`, relative to the core's source. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") ? [relative(serverDir, path).replaceAll("\\", "/")] : [];
  });
}

const files = serverDirs.flatMap(sourceFiles).map((file) => ({
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
    // The client's own codes, which the server never sends: error.unexpected is its fallback,
    // and the Knowledge popover refuses a file that isn't UTF-8 before uploading it.
    const clientOnly = new Set(["error.unexpected", "error.knowledgeNotUtf8"]);
    const keys = Object.keys(en).filter((key) => key.startsWith("error.") && !clientOnly.has(key));

    for (const code of used) expect(en).toHaveProperty([code]);
    expect([...used].sort()).toEqual(keys.sort());
  });
});
