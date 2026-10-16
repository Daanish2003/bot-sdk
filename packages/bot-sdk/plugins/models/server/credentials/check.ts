import type { CredentialService } from "../../../../core/shared/credentials/services";
import { providerLabel } from "../../../../core/shared/credentials/services";
import type { ErrorCode } from "../../../../core/shared/i18n";
import type { ErrorParams } from "../../../../core/server/rpc-error";

export type CheckRejectionReason = "invalid_key" | "provider_error";

export type CheckResult =
  | { status: "verified" }
  /** The service has no endpoint to check against; the credentials are saved as given. */
  | { status: "unverified" }
  | {
      status: "rejected";
      reason: CheckRejectionReason;
      /** English, for the logs. */
      message: string;
      /** The dictionary code and params the client shows. */
      code: ErrorCode;
      params: ErrorParams;
    };

type CheckRequest = {
  url: string;
  headers: Record<string, string>;
  /** Statuses that mean the key was refused. Default 401 and 403. */
  invalidKeyStatuses?: number[];
  /** The message when the service can't be reached, with the code the client shows. */
  unreachable?: { message: string; code: ErrorCode; params: ErrorParams };
};

const bearer = (apiKey = "") => ({ authorization: `Bearer ${apiKey}` });

/**
 * The cheap authenticated call that proves credentials work, per service. `null` for a service
 * without an endpoint to check against: its credentials are saved "not verified".
 */
const checkRequests: Record<
  CredentialService,
  ((fields: Record<string, string>) => CheckRequest) | null
> = {
  anthropic: ({ apiKey = "" }) => ({
    url: "https://api.anthropic.com/v1/models?limit=1",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  }),
  openai: ({ apiKey }) => ({
    url: "https://api.openai.com/v1/models",
    headers: bearer(apiKey),
  }),
  gemini: ({ apiKey = "" }) => ({
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
    headers: { "x-goog-api-key": apiKey },
    // Gemini refuses an unknown key with 400 API_KEY_INVALID.
    invalidKeyStatuses: [400, 401, 403],
  }),
  openrouter: ({ apiKey }) => ({
    url: "https://openrouter.ai/api/v1/key",
    headers: bearer(apiKey),
  }),
  mistral: ({ apiKey }) => ({
    url: "https://api.mistral.ai/v1/models",
    headers: bearer(apiKey),
  }),
  groq: ({ apiKey }) => ({
    url: "https://api.groq.com/openai/v1/models",
    headers: bearer(apiKey),
  }),
  grok: ({ apiKey }) => ({
    url: "https://api.x.ai/v1/models",
    headers: bearer(apiKey),
  }),
  bedrock: null,
  // Lists the account's Workers AI Models: checks the token and the account id together.
  cloudflare: ({ accountId = "", apiKey }) => ({
    url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?per_page=1`,
    headers: bearer(apiKey),
  }),
  byteplus: ({ apiKey }) => ({
    url: "https://ark.ap-southeast.bytepluses.com/api/v3/models",
    headers: bearer(apiKey),
  }),
  llmgateway: null,
  lovable: null,
  // The gateway's model list is public; its credits need a valid key.
  "vercel-gateway": ({ apiKey }) => ({
    url: "https://ai-gateway.vercel.sh/v1/credits",
    headers: bearer(apiKey),
  }),
  // Ollama has no key: the check only proves the host is reachable.
  ollama: ({ host = "" }) => ({
    url: `${host}/api/tags`,
    headers: {},
    invalidKeyStatuses: [],
    unreachable: {
      message: `Couldn't reach Ollama at ${host}. Under Docker, use http://host.docker.internal:11434.`,
      code: "error.ollamaUnreachable",
      params: { host },
    },
  }),
  // The usage endpoint authenticates the key without spending a search credit.
  tavily: ({ apiKey }) => ({
    url: "https://api.tavily.com/usage",
    headers: bearer(apiKey),
  }),
};

/**
 * Checks credentials with one request through `fetch` (`deps.fetch`), or not at all for a
 * service without a check endpoint.
 * A 429 counts as verified: the key authenticated, the account is only busy.
 */
export async function checkCredentials(
  service: CredentialService,
  fields: Record<string, string>,
  fetch: typeof globalThis.fetch,
): Promise<CheckResult> {
  const label = providerLabel(service);
  const buildRequest = checkRequests[service];
  if (!buildRequest) return { status: "unverified" };
  const {
    url,
    headers,
    invalidKeyStatuses = [401, 403],
    unreachable = {
      message: `Couldn't reach ${label} to check the key. Try again.`,
      code: "error.keyUnreachable",
      params: { label },
    },
  } = buildRequest(fields);

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    return { status: "rejected", reason: "provider_error", ...unreachable };
  }
  await response.body?.cancel();

  if (response.ok || response.status === 429) return { status: "verified" };
  if (invalidKeyStatuses.includes(response.status)) {
    return {
      status: "rejected",
      reason: "invalid_key",
      message: `${label} rejected this API key.`,
      code: "error.keyRejected",
      params: { label },
    };
  }
  return {
    status: "rejected",
    reason: "provider_error",
    message: `Couldn't check the key with ${label} (HTTP ${response.status}). Try again.`,
    code: "error.keyCheckFailed",
    params: { label, status: response.status },
  };
}
