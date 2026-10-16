// Maintainer-run snapshot of the curated Models' limits: `pnpm snapshot:models`.
//
// Fetches models.dev and rewrites core/shared/chat/models-snapshot.ts with each curated Model's
// context window, max output and reasoning efforts. The app never fetches models.dev at runtime,
// and this script stays in the canonical repo: `copy` ships only core/, so Hosts don't get it.
//
// Every curated Model needs a row in `sources`: its models.dev `[provider, model]`, or `null` when
// it has no entry (its limits stay unknown). A curated Model without a row, or a row for a Model
// that isn't curated, stops the run, so the snapshot never drifts from the curated list.
//
// Node runs this file directly (type stripping), so it imports only node: built-ins.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_TS = join(SDK_ROOT, "core/shared/chat/models.ts");
const SNAPSHOT_TS = join(SDK_ROOT, "core/shared/chat/models-snapshot.ts");
const MODELS_DEV_URL = "https://models.dev/api.json";

/** The efforts the chat offers. `off` is reported separately. */
const LEVELS = ["low", "medium", "high"] as const;

/** Providers whose API has no reasoning setting to send (Bedrock Converse). */
const NO_REASONING_SETTING = new Set(["bedrock"]);

type DevModel = {
  limit?: { context?: number; output?: number };
  reasoning_options?: { type: string; values?: string[] }[];
};
type ModelsDev = Record<string, { models?: Record<string, DevModel> }>;

/** Where each curated Model sits on models.dev: `[provider, model]`, or `null` when unknown. */
const sources: Record<string, [string, string] | null> = {
  "anthropic:claude-opus-5-5": ["anthropic", "claude-opus-5-5"],
  "anthropic:claude-sonnet-5-5": ["anthropic", "claude-sonnet-5-5"],
  "anthropic:claude-fable-5-1": ["anthropic", "claude-fable-5-1"],
  "anthropic:claude-haiku-4-5": ["anthropic", "claude-haiku-4-5"],
  "openai:gpt-6.1-sol": ["openai", "gpt-6.1-sol"],
  "openai:gpt-6-luna": ["openai", "gpt-6-luna"],
  "openai:gpt-5.6": ["openai", "gpt-5.6"],
  "openai:gpt-5.4-mini": ["openai", "gpt-5.4-mini"],
  "gemini:gemini-3.8-flash": ["google", "gemini-3.8-flash"],
  "gemini:gemini-3.5-flash-lite": ["google", "gemini-3.5-flash-lite"],
  "gemini:gemini-3.1-pro-preview": ["google", "gemini-3.1-pro-preview"],
  "gemini:gemini-2.5-pro": ["google", "gemini-2.5-pro"],
  "mistral:mistral-medium-latest": ["mistral", "mistral-medium-latest"],
  "mistral:mistral-large-latest": ["mistral", "mistral-large-latest"],
  "mistral:mistral-small-latest": ["mistral", "mistral-small-latest"],
  "mistral:magistral-medium-latest": ["mistral", "magistral-medium-latest"],
  "mistral:codestral-latest": ["mistral", "codestral-latest"],
  "groq:openai/gpt-oss-120b": ["groq", "openai/gpt-oss-120b"],
  "groq:llama-3.3-70b-versatile": ["groq", "llama-3.3-70b-versatile"],
  "groq:meta-llama/llama-4-maverick-17b-128e-instruct": null,
  "groq:moonshotai/kimi-k2-instruct-0905": null,
  "groq:qwen/qwen3-32b": null,
  "grok:grok-4.7": ["xai", "grok-4.7"],
  "grok:grok-4.6": ["xai", "grok-4.6"],
  "grok:grok-4.3": ["xai", "grok-4.3"],
  "grok:grok-build-0.1": ["xai", "grok-build-0.1"],
  "bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0": [
    "amazon-bedrock",
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  ],
  "bedrock:us.anthropic.claude-haiku-4-5-20251001-v1:0": [
    "amazon-bedrock",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  ],
  "bedrock:us.amazon.nova-pro-v1:0": ["amazon-bedrock", "us.amazon.nova-pro-v1:0"],
  "bedrock:us.meta.llama4-maverick-17b-instruct-v1:0": [
    "amazon-bedrock",
    "us.meta.llama4-maverick-17b-instruct-v1:0",
  ],
  "bedrock:openai.gpt-oss-120b-1:0": ["amazon-bedrock", "openai.gpt-oss-120b-1:0"],
  "cloudflare:@cf/openai/gpt-oss-120b": ["cloudflare-workers-ai", "@cf/openai/gpt-oss-120b"],
  "cloudflare:@cf/meta/llama-4-scout-17b-16e-instruct": [
    "cloudflare-workers-ai",
    "@cf/meta/llama-4-scout-17b-16e-instruct",
  ],
  "cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast": [
    "cloudflare-workers-ai",
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  ],
  "cloudflare:@cf/moonshotai/kimi-k2.6": ["cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6"],
  "cloudflare:@cf/zai-org/glm-4.7-flash": ["cloudflare-workers-ai", "@cf/zai-org/glm-4.7-flash"],
  // BytePlus's Seed models are listed on models.dev under volcengine, with the same ids.
  "byteplus:seed-2-0-lite-260428": ["volcengine", "doubao-seed-2-0-lite-260428"],
  "byteplus:seed-2-0-pro-260328": null,
  "byteplus:seed-2-0-mini-260428": ["volcengine", "doubao-seed-2-0-mini-260428"],
  "byteplus:glm-5-2-260617": ["volcengine", "glm-5-2-260617"],
  "llmgateway:claude-sonnet-5": ["llmgateway", "claude-sonnet-5"],
  "llmgateway:gpt-5.6-terra": ["llmgateway", "gpt-5.6-terra"],
  "llmgateway:gemini-3.6-flash": ["llmgateway", "gemini-3.6-flash"],
  "llmgateway:kimi-k3": ["llmgateway", "kimi-k3"],
  "llmgateway:deepseek-v4-pro": ["llmgateway", "deepseek-v4-pro"],
  // Lovable's Models are looked up under their upstream Provider.
  "lovable:google/gemini-3.7-flash": ["google", "gemini-3.7-flash"],
  "lovable:google/gemini-3.1-pro-preview": ["google", "gemini-3.1-pro-preview"],
  "lovable:openai/gpt-5.6-sol": ["openai", "gpt-5.6-sol"],
  "lovable:openai/gpt-5.4-mini": ["openai", "gpt-5.4-mini"],
  "vercel-gateway:anthropic/claude-sonnet-5.5": ["vercel", "anthropic/claude-sonnet-5.5"],
  "vercel-gateway:openai/gpt-6.1-sol": ["vercel", "openai/gpt-6.1-sol"],
  "vercel-gateway:google/gemini-3.8-flash": ["vercel", "google/gemini-3.8-flash"],
  "vercel-gateway:spacexai/grok-4.7": ["vercel", "spacexai/grok-4.7"],
  "vercel-gateway:moonshotai/kimi-k3": ["vercel", "moonshotai/kimi-k3"],
};

type Entry = {
  source: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  efforts: (typeof LEVELS)[number][];
  off: boolean;
};

/** The curated ids, read from the `model("provider", "modelId", ...)` calls in models.ts. */
function curatedIds(): { id: string; provider: string }[] {
  const source = readFileSync(MODELS_TS, "utf8");
  return [...source.matchAll(/model\(\s*"([^"]+)",\s*"([^"]+)"/g)].map(
    ([, provider = "", modelId = ""]) => ({ id: `${provider}:${modelId}`, provider }),
  );
}

function entryFor(dev: ModelsDev, provider: string, [devProvider, devModel]: [string, string]) {
  const model = dev[devProvider]?.models?.[devModel];
  if (!model) return undefined;
  const efforts = (model.reasoning_options ?? []).flatMap((option) =>
    option.type === "effort" ? (option.values ?? []) : [],
  );
  const offered = NO_REASONING_SETTING.has(provider)
    ? []
    : LEVELS.filter((level) => efforts.includes(level));
  return {
    source: `${devProvider}/${devModel}`,
    contextWindow: model.limit?.context ?? null,
    maxOutputTokens: model.limit?.output ?? null,
    efforts: [...offered],
    off: !NO_REASONING_SETTING.has(provider) && efforts.includes("none"),
  } satisfies Entry;
}

/** One row, in the shape the repo's formatter keeps, so a rerun is byte-identical. */
function row(id: string, entry: Entry | null): string[] {
  if (entry === null) return [`  ${JSON.stringify(id)}: null,`];
  return [
    `  ${JSON.stringify(id)}: {`,
    `    source: ${JSON.stringify(entry.source)},`,
    `    contextWindow: ${entry.contextWindow ?? "null"},`,
    `    maxOutputTokens: ${entry.maxOutputTokens ?? "null"},`,
    `    efforts: [${entry.efforts.map((level) => JSON.stringify(level)).join(", ")}],`,
    `    off: ${entry.off},`,
    "  },",
  ];
}

function render(entries: Record<string, Entry | null>): string {
  const rows = Object.keys(entries)
    .sort()
    .flatMap((id) => row(id, entries[id] ?? null));
  return [
    "// Generated by `pnpm snapshot:models` from https://models.dev/api.json.",
    "// Do not edit by hand. A `null` row is a curated Model with no data: its limits are unknown.",
    "",
    "export type SnapshotEntry = {",
    "  /** The models.dev entry this came from, as `provider/model`. */",
    "  source: string;",
    "  contextWindow: number | null;",
    "  maxOutputTokens: number | null;",
    '  efforts: ("low" | "medium" | "high")[];',
    "  /** Whether the Model allows reasoning to be turned off. */",
    "  off: boolean;",
    "};",
    "",
    "export const modelsDevSnapshot: Record<string, SnapshotEntry | null> = {",
    ...rows,
    "};",
    "",
  ].join("\n");
}

async function main() {
  const curated = curatedIds();
  const curatedSet = new Set(curated.map(({ id }) => id));
  const unmapped = curated.filter(({ id }) => !(id in sources));
  const stale = Object.keys(sources).filter((id) => !curatedSet.has(id));
  if (unmapped.length || stale.length) {
    throw new Error(
      `Mapping out of step with models.ts. Unmapped: ${unmapped.map(({ id }) => id).join(", ") || "none"}. Stale: ${stale.join(", ") || "none"}.`,
    );
  }

  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
  const dev = (await response.json()) as ModelsDev;

  const entries: Record<string, Entry | null> = {};
  for (const { id, provider } of curated) {
    const mapped = sources[id];
    // A mapped source that has vanished upstream fails the run: it must not quietly become unknown.
    const entry = mapped ? entryFor(dev, provider, mapped) : undefined;
    if (mapped && !entry) throw new Error(`models.dev has no ${mapped.join("/")} for ${id}`);
    entries[id] = entry ?? null;
  }

  writeFileSync(SNAPSHOT_TS, render(entries));
  const known = Object.values(entries).filter((entry) => entry !== null).length;
  console.log(`Wrote ${known} of ${curated.length} curated Models to ${SNAPSHOT_TS}`);
}

await main();
