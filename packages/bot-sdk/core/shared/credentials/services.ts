import { z } from "zod";

/**
 * Providers, their Provider credentials fields and help text. Plain data and zod only:
 * the web app imports it into the browser for the Keys & settings page.
 */

/** The 14 TanStack AI HTTP chat Providers, in the order Keys & settings lists them. */
export const providers = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "gemini", label: "Google Gemini" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "mistral", label: "Mistral" },
  { id: "groq", label: "Groq" },
  { id: "grok", label: "xAI Grok" },
  { id: "bedrock", label: "Amazon Bedrock" },
  { id: "cloudflare", label: "Cloudflare Workers AI" },
  { id: "byteplus", label: "BytePlus" },
  { id: "llmgateway", label: "LLM Gateway" },
  { id: "lovable", label: "Lovable" },
  { id: "vercel-gateway", label: "Vercel AI Gateway" },
  { id: "ollama", label: "Ollama" },
] as const;

export type ProviderId = (typeof providers)[number]["id"];

const apiKey = z.string().trim().min(1, "Enter an API key");
const accountId = z.string().trim().min(1, "Enter your account id");
const region = z
  .string()
  .trim()
  .regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "Enter an AWS region, for example us-east-1");
const host = z
  .string()
  .trim()
  .pipe(z.url({ protocol: /^https?$/, error: "Enter a URL, for example http://localhost:11434" }))
  .transform((url) => url.replace(/\/+$/, ""));

/** The field schema of each service whose credentials can be saved. */
export const credentialFieldSchemas = {
  anthropic: z.object({ apiKey }),
  openai: z.object({ apiKey }),
  gemini: z.object({ apiKey }),
  openrouter: z.object({ apiKey }),
  mistral: z.object({ apiKey }),
  groq: z.object({ apiKey }),
  grok: z.object({ apiKey }),
  bedrock: z.object({ apiKey, region }),
  cloudflare: z.object({ accountId, apiKey }),
  byteplus: z.object({ apiKey }),
  llmgateway: z.object({ apiKey }),
  lovable: z.object({ apiKey }),
  "vercel-gateway": z.object({ apiKey }),
  ollama: z.object({ host }),
  tavily: z.object({ apiKey }),
};

export type CredentialService = keyof typeof credentialFieldSchemas;

/** `credentials.save` input: a service and its fields. */
export const saveCredentialsInput = z.discriminatedUnion("service", [
  z.object({ service: z.literal("anthropic"), fields: credentialFieldSchemas.anthropic }),
  z.object({ service: z.literal("openai"), fields: credentialFieldSchemas.openai }),
  z.object({ service: z.literal("gemini"), fields: credentialFieldSchemas.gemini }),
  z.object({ service: z.literal("openrouter"), fields: credentialFieldSchemas.openrouter }),
  z.object({ service: z.literal("mistral"), fields: credentialFieldSchemas.mistral }),
  z.object({ service: z.literal("groq"), fields: credentialFieldSchemas.groq }),
  z.object({ service: z.literal("grok"), fields: credentialFieldSchemas.grok }),
  z.object({ service: z.literal("bedrock"), fields: credentialFieldSchemas.bedrock }),
  z.object({ service: z.literal("cloudflare"), fields: credentialFieldSchemas.cloudflare }),
  z.object({ service: z.literal("byteplus"), fields: credentialFieldSchemas.byteplus }),
  z.object({ service: z.literal("llmgateway"), fields: credentialFieldSchemas.llmgateway }),
  z.object({ service: z.literal("lovable"), fields: credentialFieldSchemas.lovable }),
  z.object({
    service: z.literal("vercel-gateway"),
    fields: credentialFieldSchemas["vercel-gateway"],
  }),
  z.object({ service: z.literal("ollama"), fields: credentialFieldSchemas.ollama }),
  z.object({ service: z.literal("tavily"), fields: credentialFieldSchemas.tavily }),
]);

export type SaveCredentialsInput = z.input<typeof saveCredentialsInput>;

export const credentialServices = Object.keys(credentialFieldSchemas) as [
  CredentialService,
  ...CredentialService[],
];

/** How the Keys & settings form asks for each field, and the one-line help text. */
export const credentialForms: Record<
  CredentialService,
  {
    /** `visible` fields aren't secrets (an account id, a region, a host): shown as typed. */
    fields: { name: string; label: string; placeholder: string; visible?: boolean }[];
    helpText: string;
  }
> = {
  anthropic: {
    fields: [{ name: "apiKey", label: "API key", placeholder: "sk-ant-…" }],
    helpText: "Create a key in the Anthropic Console under Settings → API keys.",
  },
  openai: {
    fields: [{ name: "apiKey", label: "API key", placeholder: "sk-…" }],
    helpText: "Create a key in the OpenAI dashboard under API keys.",
  },
  gemini: {
    fields: [{ name: "apiKey", label: "API key", placeholder: "AIza…" }],
    helpText:
      "Create a key in Google AI Studio. On the free tier, Google may use your prompts and replies to improve its products.",
  },
  openrouter: {
    fields: [{ name: "apiKey", label: "API key", placeholder: "sk-or-…" }],
    helpText: "Create a key at openrouter.ai under Keys. The picker lists its live Models.",
  },
  mistral: {
    fields: [{ name: "apiKey", label: "API key", placeholder: "Mistral API key" }],
    helpText: "Create a key in the Mistral console under API keys.",
  },
  groq: {
    fields: [{ name: "apiKey", label: "API key", placeholder: "gsk_…" }],
    helpText: "Create a key in the GroqCloud console under API keys.",
  },
  grok: {
    fields: [{ name: "apiKey", label: "API key", placeholder: "xai-…" }],
    helpText: "Create a key in the xAI console under API keys.",
  },
  bedrock: {
    fields: [
      { name: "apiKey", label: "Bedrock API key", placeholder: "ABSK…" },
      { name: "region", label: "AWS region", placeholder: "us-east-1", visible: true },
    ],
    helpText:
      "Use a Bedrock API key. The Models are US cross-region profiles, so pick a us-* region. Bedrock has no check, so it's saved unverified.",
  },
  cloudflare: {
    fields: [
      { name: "accountId", label: "Account id", placeholder: "Account id", visible: true },
      { name: "apiKey", label: "API token", placeholder: "Workers AI API token" },
    ],
    helpText:
      "Create an API token with Workers AI access; the account id is on the Workers AI page.",
  },
  byteplus: {
    fields: [{ name: "apiKey", label: "API key", placeholder: "ModelArk API key" }],
    helpText: "Create a key in the BytePlus ModelArk console under API keys.",
  },
  llmgateway: {
    fields: [{ name: "apiKey", label: "API key", placeholder: "llmgtwy_…" }],
    helpText: "Create a key at llmgateway.io. LLM Gateway has no check, so it's saved unverified.",
  },
  lovable: {
    fields: [{ name: "apiKey", label: "API key", placeholder: "Lovable AI Gateway key" }],
    helpText: "Use your Lovable AI Gateway key. Lovable has no check, so it's saved unverified.",
  },
  "vercel-gateway": {
    fields: [{ name: "apiKey", label: "API key", placeholder: "AI Gateway API key" }],
    helpText: "Create an AI Gateway API key in your Vercel dashboard.",
  },
  ollama: {
    fields: [{ name: "host", label: "Host", placeholder: "http://localhost:11434", visible: true }],
    helpText:
      "No key needed, only your Ollama server's URL. When this app runs in Docker, use http://host.docker.internal:11434.",
  },
  tavily: {
    fields: [{ name: "apiKey", label: "API key", placeholder: "tvly-…" }],
    helpText: "Create a key at app.tavily.com. The free plan includes 1,000 searches a month.",
  },
};

export function isCredentialService(service: string): service is CredentialService {
  return Object.hasOwn(credentialFieldSchemas, service);
}

export function providerLabel(service: string) {
  return (
    providers.find((provider) => provider.id === service)?.label ??
    toolServices.find((tool) => tool.id === service)?.label ??
    service
  );
}

/** The Tavily Tool credential's service: the key the `web_search` tool searches with. */
export const tavilyService = "tavily";

/** Tools that need a Tool credential, in the order Keys & settings lists them. */
export const toolServices = [
  { id: tavilyService, label: "Tavily", description: "Web search" },
] as const;

/** Why a Model can't be used: its Provider has no credentials. */
export function addKeyMessage(service: string) {
  const label = providerLabel(service);
  return `Add ${/^[aeiou]/i.test(label) ? "an" : "a"} ${label} key or pick another Model`;
}

/** Why a Model can't be used: the key prompt while the user may bring keys (`byok`), else only "pick another". */
export function unusableModelMessage(service: string, byok: boolean) {
  return byok ? addKeyMessage(service) : "Pick another Model";
}

/**
 * The hint the client sees instead of the credentials: the end of the key, e.g. "…abcd", or the
 * Ollama host, which isn't a secret.
 */
export function credentialHint(fields: Record<string, string>) {
  return fields.apiKey ? `…${fields.apiKey.slice(-4)}` : (fields.host ?? "");
}

/** A Provider or Tool credential as the client sees it: its service, the key's hint and whether it verified. */
export type CredentialSummary = { service: string; hint: string; verified: boolean };
