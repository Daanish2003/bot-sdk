# TanStack AI embeddings in 0.66.0

Research for issue #200 (child of the Wayfinder map #197). Researched on 2026-10-12.

**Versions checked** (installed in `packages/chat-sdk/node_modules/@tanstack`, resolved from the lockfile):

| Package                     | Version | Underlying SDK         |
| --------------------------- | ------- | ---------------------- |
| `@tanstack/ai`              | 0.66.0  | -                      |
| `@tanstack/ai-openai`       | 0.28.0  | `openai` 7.30.0        |
| `@tanstack/ai-gemini`       | 0.37.0  | `@google/genai` 2.27.0 |
| `@tanstack/ai-event-client` | 0.13.x  | (defines `TokenUsage`) |

"Source:" means I read the installed implementation (paths are relative to `node_modules/@tanstack/` unless they name another package). "Docs:" means the provider's official docs, fetched on 2026-10-12.

## Short answer

- `embed({ adapter, input, dimensions?, modelOptions?, debug?, middleware? })` returns `{ id, model, embeddings: [{ vector, index }], usage? }`, one vector per input item, in input order.
- **One provider request per `embed()` call, with no batching or chunking by TanStack.** The caller must split inputs to fit each provider's per-request limits.
- **No abort support.** `EmbedOptions` has no `abortController`/`signal`, and neither adapter passes one to its SDK. Only the SDK client's `timeout` and retry settings (set when constructing the adapter) bound a call.
- **Usage**: OpenAI returns `promptTokens`/`totalTokens`; **Gemini returns no usage at all**. Neither returns `cost`.
- **Errors**: provider SDK errors are rethrown unchanged (`OpenAI.APIError` subclasses, `@google/genai` `ApiError`); TanStack adds a few plain `Error`s of its own (listed below).
- Models: OpenAI `text-embedding-3-small` (1536 dims, $0.02/1M tokens) and `text-embedding-3-large` (3072 dims, $0.13/1M); Gemini `gemini-embedding-001` (3072 dims, 2,048-token input). All three can be shortened through `embed()`'s top-level `dimensions`.
- Gemini has a `taskType` option (`RETRIEVAL_DOCUMENT` vs `RETRIEVAL_QUERY`, and others) plus `title`; OpenAI has no equivalent.

---

## 1. `embed()` signature

Source: `ai/src/activities/embed/index.ts`, `ai/src/types.ts` (lines ~3096–3141).

```ts
embed<TAdapter extends EmbeddingAdapter<string, any, any, any>>(
  options: EmbedOptions<TAdapter>,
): Promise<EmbeddingResult>

type EmbedOptions<TAdapter> = {
  adapter: TAdapter                    // created with a model: openaiEmbedding('text-embedding-3-small')
  input: Item | Array<Item>            // Item narrowed per model; text-only models accept string | TextPart
  dimensions?: number                  // Matryoshka shortening, provider-mapped
  debug?: DebugOption
  middleware?: Array<GenerationMiddleware> // observe-only: start, usage, finish, error
  modelOptions?: ProviderOptions       // required only if the model's options have required keys
}

interface EmbeddingResult {
  id: string
  model: string
  embeddings: Array<{ vector: Array<number>; index: number }> // one per input item, input order
  usage?: TokenUsage
}
```

- A single item is normalised to a one-element array, so `result.embeddings` is always an array.
- `createEmbedOptions()` builds typed options without running them.
- Adapter factories: `openaiEmbedding(model, config?)` reads `OPENAI_API_KEY`; `createOpenaiEmbedding(model, apiKey, config?)` takes the key explicitly. Same for `geminiEmbedding` (reads `GOOGLE_API_KEY` then `GEMINI_API_KEY`) and `createGeminiEmbedding`. For the user's Provider credentials or Host credentials we need the `create*` forms. Source: `ai-openai/src/adapters/embedding.ts`, `ai-gemini/src/adapters/embedding.ts`, `ai-gemini/src/utils/client.ts`.
- `config` is the SDK client's own options: `OpenAIClientConfig` extends the `openai` `ClientOptions` (`baseURL`, `timeout`, `maxRetries`, `fetch`, ...); `GeminiClientConfig` extends `GoogleGenAIOptions` (`httpOptions.timeout`, `httpOptions.retryOptions`, `vertexai`, ...) plus `baseURL`/`defaultHeaders`. Source: `ai-openai/src/utils/client.ts`, `ai-gemini/src/utils/client.ts`.
- Both adapters accept text only (`requireTextOnlyEmbeddingInput`), joining a fused item's text parts with `\n`. Source: `ai/src/utilities/embedding-input.ts`.
- `embed()` emits devtools events (`embedding:request:started|completed|error`, `embedding:usage`) through `aiEventClient`, and calls the middleware hooks. Source: `ai/src/activities/embed/index.ts`.

## 2. Batching limits

TanStack does no batching of its own: `embed()` calls `adapter.createEmbeddings()` once, and each adapter makes **one** SDK call with the whole input array. Source: `ai/src/activities/embed/index.ts`; adapter class comments "Batch embedding (one request for the whole input array)".

| Provider                                                                                                                   | Per-request limits                                                                                                                                                                                      | Source                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI `embeddings.create`                                                                                                 | max **2,048 inputs**; each input max **8,192 tokens**; max **300,000 tokens** summed across inputs                                                                                                      | Docs: [Create embeddings API reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create)                                                                                                                                           |
| Gemini `batchEmbedContents` (the SDK sends multiple `contents` through `{model}:batchEmbedContents` in Developer API mode) | each input max **2,048 tokens**. The docs state no maximum request count; the API is widely reported to reject more than **100 requests per batch**, which I could not confirm in the docs (unverified) | Source: `@google/genai` `dist/node/index.mjs` (`embedContentInternal`, path `{model}:batchEmbedContents`). Docs: [gemini-embedding-001](https://ai.google.dev/gemini-api/docs/models/gemini-embedding-001), [Embeddings API](https://ai.google.dev/api/embeddings) |

Notes:

- The Gemini adapter throws if the number of returned embeddings differs from the number of inputs.
- Over-long input: OpenAI rejects it with a 400. Gemini's Developer API has no `autoTruncate` (the SDK throws if you set it outside Vertex mode); I did not verify whether over-long Gemini input is truncated or rejected. The chunker should keep chunks well under 2,048 tokens if Gemini is a possible Model.
- Provider "Batch API" jobs (asynchronous, 50% price) are a different thing and are not exposed through `embed()`.

## 3. Abort support

None in 0.66.0.

- `EmbedOptions` and `EmbeddingOptions` have no `abortController` or `signal` field. Source: `ai/src/activities/embed/index.ts`, `ai/src/types.ts`.
- The OpenAI adapter calls `this.client.embeddings.create(request)` with no request options, so no `signal`. Source: `ai-openai/src/adapters/embedding.ts`.
- The Gemini adapter builds `config` from only `outputDimensionality`, `taskType` and `title`; `@google/genai` would accept `config.abortSignal`, but the adapter never sets it. Source: `ai-gemini/src/adapters/embedding.ts`; `@google/genai` `embedContentInternal` reads `params.config.abortSignal`.

What bounds a call instead:

- OpenAI: client `timeout` (default 600,000 ms) and `maxRetries` (default 2). Source: `openai/client.js` (`DEFAULT_TIMEOUT`, `_OpenAI_normalizeRetries`).
- Gemini: `httpOptions.timeout` and `httpOptions.retryOptions` (`attempts`, default 5 when retry options are given). Source: `@google/genai/dist/genai.d.ts` (`HttpOptions`, `HttpRetryOptions`).

A cancelled Knowledge file job therefore has to stop between `embed()` calls, or pass a custom `fetch` in the client config that honours a signal.

## 4. Usage and cost

`TokenUsage` (from `@tanstack/ai-event-client`, `src/index.ts`) has `promptTokens`, `completionTokens`, `totalTokens`, and optional `cost`, `costDetails`, `billed`, `providerUsageDetails`.

| Adapter | `usage`                                                                                       | `cost`  |
| ------- | --------------------------------------------------------------------------------------------- | ------- |
| OpenAI  | `{ promptTokens: usage.prompt_tokens, completionTokens: 0, totalTokens: usage.total_tokens }` | not set |
| Gemini  | **omitted** ("The Gemini embedding API does not report token usage")                          | not set |

Source: both adapter files. So cost must be computed by us: tokens × price for OpenAI; for Gemini, tokens must be estimated or counted separately (for example the chunker's own token count or `models.countTokens`), since the response carries none.

## 5. Errors

`embed()` emits `embedding:request:error`, runs the middleware `onError` hook, logs, and **rethrows the original error**. Source: `ai/src/activities/embed/index.ts`.

| Thrown by                       | When                                                                          | Type                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `embed()` preflight             | an input item uses a `{ type: 'file' }` source                                | `Error` (`assertPromptFileSourceSupport`)                                                                                   |
| `requireTextOnlyEmbeddingInput` | an item contains an image part                                                | `Error`: `<provider> model "<model>" only supports text embedding inputs; ...`                                              |
| `getApiKeyFromEnv`              | `openaiEmbedding`/`geminiEmbedding` with the env var unset                    | `Error` (at adapter construction)                                                                                           |
| `createGeminiClient`            | empty API key, not Vertex mode                                                | `Error` (at adapter construction)                                                                                           |
| Gemini adapter                  | returned embedding count differs from input count                             | `Error`                                                                                                                     |
| `openai` SDK                    | HTTP errors: 400 (too many tokens, bad `dimensions`), 401, 429, 5xx, timeouts | `OpenAI.APIError` subclasses (`BadRequestError`, `AuthenticationError`, `RateLimitError`, `APIConnectionTimeoutError`, ...) |
| `@google/genai` SDK             | HTTP errors                                                                   | `ApiError` (has `status`)                                                                                                   |

Note: the `dimensions` JSDoc says "adapters for fixed-dimension models throw a clear runtime error", but neither the OpenAI nor the Gemini adapter validates `dimensions`; an out-of-range value goes to the provider and comes back as its HTTP 400. Source: both adapter files.

## 6. Models

Model lists: `OPENAI_EMBEDDING_MODELS` in `ai-openai/src/model-meta.ts` (~line 2939) and `GEMINI_EMBEDDING_MODELS` in `ai-gemini/src/model-meta.ts` (~line 1246). The types allow only these ids.

| Model                    | Adapter           | Default dims | Shortening                                                                          | Input limit  | Price (standard)                           |
| ------------------------ | ----------------- | ------------ | ----------------------------------------------------------------------------------- | ------------ | ------------------------------------------ |
| `text-embedding-3-small` | `openaiEmbedding` | 1536         | yes, `dimensions` (sent as OpenAI `dimensions`)                                     | 8,192 tokens | $0.02 / 1M tokens                          |
| `text-embedding-3-large` | `openaiEmbedding` | 3072         | yes, `dimensions`                                                                   | 8,192 tokens | $0.13 / 1M tokens                          |
| `gemini-embedding-001`   | `geminiEmbedding` | 3072         | yes, `dimensions` → `outputDimensionality`, 128–3072, recommended 768 / 1536 / 3072 | 2,048 tokens | not on the current pricing page; see below |

Sources: Docs: [OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings) (dims, 8,192 tokens, shortening), [OpenAI pricing](https://developers.openai.com/api/docs/pricing) ($0.02, $0.13), [Gemini embeddings guide](https://ai.google.dev/gemini-api/docs/embeddings) and [gemini-embedding-001 model page](https://ai.google.dev/gemini-api/docs/models/gemini-embedding-001) (3072, 128–3072, 2,048 tokens).

Things that matter for pgvector:

- **Normalisation.** OpenAI vectors are normalised to length 1, including when shortened through `dimensions`. Gemini `gemini-embedding-001` vectors are normalised only at 3072; "you must manually normalize non-3072 dimensions" (Gemini embeddings guide). TanStack does not normalise.
- pgvector's `vector` type with an HNSW or IVFFlat index supports at most 2,000 dimensions, so a 3072-dim column cannot be indexed as `vector`; shortening to 1536 (or using `halfvec`) avoids that. (pgvector README, not re-checked here.)
- **Gemini price.** The [Gemini pricing page](https://ai.google.dev/gemini-api/docs/pricing) now lists only `gemini-embedding-2`: text $0.20 / 1M tokens ($0.10 batch), with a free tier. `gemini-embedding-001` is no longer priced there; it was $0.15 / 1M tokens when last published (from memory, unverified). The model page lists it as Stable (last updated June 2025) with no deprecation notice.
- **`gemini-embedding-2` is not supported by `@tanstack/ai-gemini` 0.37.0** (not in `GEMINI_EMBEDDING_MODELS`). It has an 8,192-token input, 128–3072 dims with auto-normalisation, no `taskType`, and an embedding space incompatible with `gemini-embedding-001` (Gemini embeddings guide). Choosing 001 now means re-embedding to move to 2 later; that fits "one fixed embedding Model per Project's Knowledge".
- OpenAI price for Batch API embeddings is not shown on the pricing page.

## 7. Task type (Gemini query vs. document)

`GeminiEmbeddingProviderOptions` (`ai-gemini/src/embedding/embedding-provider-options.ts`):

```ts
modelOptions: {
  taskType?: 'SEMANTIC_SIMILARITY' | 'CLASSIFICATION' | 'CLUSTERING'
    | 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' | 'QUESTION_ANSWERING'
    | 'FACT_VERIFICATION' | 'CODE_RETRIEVAL_QUERY'
  title?: string // only with RETRIEVAL_DOCUMENT
}
```

The adapter maps both into the SDK `config`, which applies them to every request in the batch. For Knowledge: embed chunks with `RETRIEVAL_DOCUMENT` (optionally `title` = file name) and the `search_knowledge` query with `RETRIEVAL_QUERY` (or `QUESTION_ANSWERING`).

OpenAI has no task type: `OpenAIEmbeddingProviderOptions` has only `user`. The adapter spreads `modelOptions` first and then pins `model`, `input` and `encoding_format: 'float'`, so `modelOptions` cannot override them. Source: `ai-openai/src/embedding/embedding-provider-options.ts`, `ai-openai/src/adapters/embedding.ts`.

## Open points for the spec

- A wrapper must split inputs to the per-request limits (OpenAI 2,048 inputs / 300k tokens; Gemini, safely, 100 inputs) and normalise shortened Gemini vectors.
- Cost accounting for Gemini needs our own token count.
- Cancellation can only happen between batches unless we pass a signal-aware `fetch`.
- A fake adapter for tests can extend `BaseEmbeddingAdapter` (exported from `@tanstack/ai/adapters`) and implement `createEmbeddings`.
