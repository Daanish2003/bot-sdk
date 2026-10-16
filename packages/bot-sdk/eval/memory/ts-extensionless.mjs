// A Node resolve hook for register-ts.mjs: a relative import that doesn't exist as written is tried
// with `.ts`, then as a folder's `index.ts`.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    const missing = ["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"].includes(error.code);
    if (!missing || !relative || !context.parentURL) throw error;
    const base = new URL(specifier, context.parentURL);
    const candidates = [new URL(`${base.href}.ts`), new URL("index.ts", `${base.href}/`)];
    const found = candidates.find((url) => existsSync(fileURLToPath(url)));
    if (!found) throw error;
    return nextResolve(found.href, context);
  }
}
