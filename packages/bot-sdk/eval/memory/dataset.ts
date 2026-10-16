// The LongMemEval cleaned S file, downloaded at a pinned Hugging Face revision into a gitignored
// cache the first time the eval runs. The file is never committed (docs/research/longmemeval-eval.md).

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LongMemEvalItem } from "./cases";

export const datasetRevision = "98d7416c24c778c2fee6e6f3006e7a073259d48f";
export const datasetFile = "longmemeval_s_cleaned.json";
export const datasetUrl = `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/${datasetRevision}/${datasetFile}`;

/** Reads the cached S file, downloading it first when it is missing. */
export async function loadDataset(cacheDir: string): Promise<LongMemEvalItem[]> {
  const path = join(cacheDir, datasetFile);
  if (!existsSync(path)) {
    const response = await fetch(datasetUrl);
    if (!response.ok) {
      throw new Error(`Downloading ${datasetUrl} failed: HTTP ${response.status}`);
    }
    await mkdir(cacheDir, { recursive: true });
    // Written under a temporary name, so an interrupted download never looks complete.
    const partial = `${path}.part`;
    await writeFile(partial, Buffer.from(await response.arrayBuffer()));
    await rename(partial, path);
  }
  return JSON.parse(await readFile(path, "utf8")) as LongMemEvalItem[];
}
