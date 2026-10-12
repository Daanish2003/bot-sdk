# What we port from Sim Studio for Knowledge files

Research for [#198](https://github.com/Daanish2003/ai-chat/issues/198) (child of map [#197](https://github.com/Daanish2003/ai-chat/issues/197)). Researched 2026-10-12.

## Question

For each format we support (PDF text layer, DOCX, MD, TXT, CSV, HTML), which files in upstream Sim Studio hold the parser, and which hold the one chunker? Record each file's path at a pinned commit, its npm dependencies (name, version, licence, size, whether it runs in Node without native binaries), and the Sim-specific code it pulls in that we'd strip. Also record how Sim stores chunks and searches them: table shape, vector column and dimension, indexes, and whether it already does full-text search or RRF.

## Pinned source

- Repo: `github.com/simstudioai/sim`, commit **`22c3de1f7d02fdb6fc925ad858abb555c20f5493`** (2026-10-11). Every path below is at this commit. Base URL: `https://github.com/simstudioai/sim/blob/22c3de1f7d02fdb6fc925ad858abb555c20f5493/`.
- Licence: `LICENSE` is Apache-2.0, and both `package.json` and `apps/sim/package.json` declare `"license": "Apache-2.0"`. The root `NOTICE` reads "Sim Studio / Copyright 2026 Sim Studio / This product includes software developed for the Sim project." Our `NOTICE` must carry that text (ADR 0014).
- Dependency versions are the exact pins in `apps/sim/package.json`. Licences, sizes and dependencies come from the npm registry (`pnpm view <pkg>@<version>`).

## Answer

Sim keeps parsers in `apps/sim/lib/file-parsers/` and chunkers in `apps/sim/lib/chunkers/`. Our six formats need about 20 parser files, and the one chunker is **`TextChunker`** plus three small helpers. Together that's about 5,600 lines before trimming, and it pulls in no Sim provider, billing or OCR code. The OCR and provider code lives in `apps/sim/lib/knowledge/documents/document-processor.ts` (1,368 lines), which we don't port. We take only its chunker-selection logic as a guide.

New npm dependencies (each is the owner's decision, AGENTS.md §6):

| Package           | Sim's pin          | Licence      | Unpacked size                                                      | Native?           | Used for                                                             |
| ----------------- | ------------------ | ------------ | ------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------- |
| `pdfjs-dist`      | 5.4.296            | Apache-2.0   | 36.6 MB                                                            | No, but see below | PDF text layer                                                       |
| `@napi-rs/canvas` | 0.1.100            | MIT          | 125 kB + **~33 MB native binary per platform** (`-linux-x64-gnu`)  | **Yes**           | Supplies `DOMMatrix` to pdf.js                                       |
| `mammoth`         | 1.12.3             | BSD-2-Clause | 2.2 MB (deps: jszip, @xmldom/xmldom, bluebird, underscore, lop, …) | No                | DOCX to HTML                                                         |
| `cheerio`         | 1.1.2              | MIT          | 1.3 MB (deps: parse5, htmlparser2 ^10, undici, …)                  | No                | HTML (and DOCX's HTML) to structured text                            |
| `htmlparser2`     | ^10 (from cheerio) | MIT          | 235 kB (v12)                                                       | No                | `office-text.ts` imports it directly, so it must be a direct dep too |
| `csv-parse`       | 7.0.2              | MIT          | 1.6 MB, no deps                                                    | No                | CSV                                                                  |

MD and TXT need no dependency. `TextChunker` needs none either: it estimates tokens as `length / 4` (`chunkers/utils.ts` `estimateTokens`), not with a tokenizer. The repo's lockfile already has `htmlparser2@10.1.0` and `@8.0.2` as transitive deps, but none of the packages above as direct deps.

**The PDF native-binary problem needs a decision.** pdfjs-dist 5.4.296 lists `@napi-rs/canvas` as an _optional_ dependency. Its Node legacy build (`legacy/build/pdf.mjs`) still runs `const SCALE_MATRIX = new DOMMatrix();` at module top level (line 15620 in the published tarball), and it only polyfills `DOMMatrix` when `@napi-rs/canvas` loads (lines 14341–14352). Without a `DOMMatrix`, importing the module throws. Sim imports `@napi-rs/canvas` explicitly before pdf.js for exactly this reason (`file-parsers/pdfjs-server.ts`: "PDF.js constructs DOMMatrix during module evaluation, including text-only use"). The owner's options:

1. Take `@napi-rs/canvas` as Sim does. It's a ~33 MB prebuilt native binary per platform.
2. Set a pure-JS `globalThis.DOMMatrix` before importing pdf.js (for example `@thednp/dommatrix` 3.1.2, MIT, 351 kB). Text extraction never renders, so this probably works. That's **unverified**, and a test would need to prove it.
3. Use `unpdf` (1.8.1, MIT, 2.1 MB, no deps, which describes itself as "PDF extraction and rendering across all JavaScript runtimes") instead of `pdfjs-dist` directly. We'd then drop Sim's `pdfjs-server.ts` loader and keep its layout files. Whether unpdf's bundled pdf.js exposes the text-item geometry that `pdf-lines.ts` reads is **unverified**.

`officeparser` 5.2.2 (MIT) is Sim's DOCX fallback when mammoth fails. It drags in its own `pdfjs-dist`, `yauzl` and `file-type`. **Strip it.** A DOCX that mammoth can't read gets the failed status.

## Per-format file map

All paths are under `apps/sim/lib/`.

**Shared by every parser (port, trimmed):**

| File                                                                  | Lines         | Notes                                                                                                                                              |
| --------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file-parsers/index.ts`                                               | 220           | `parseBuffer(buffer, ext)` registry. Trim the `PARSERS` map to `pdf, docx, md, txt, csv, html, htm`. Drop the `parseFile` path (we parse buffers). |
| `file-parsers/types.ts`                                               | 83            | `FileParseResult`, `FileParseOptions`. Trim `SupportedFileType`.                                                                                   |
| `file-parsers/errors.ts`                                              | 85            | `FileParserError` with codes (`invalid_format`, `encrypted_file`, `complexity_limit`, `empty_input`, …). These map onto our failed status.         |
| `file-parsers/utils.ts`                                               | 250           | `decodeTextBuffer` (UTF-8/UTF-16/Windows-1252 sniffing), `sanitizeTextForUTF8`. No deps.                                                           |
| `file-parsers/sniff.ts`                                               | 357           | Content sniffing that re-routes a mislabelled file. Optional. Trim the routes to our formats, or drop it and trust the extension.                  |
| `file-parsers/zip-guard.ts`, `ooxml-limits.ts`, `ooxml-encryption.ts` | 604 + 37 + 30 | Zip-bomb and encrypted-OOXML guards, built on Node's `zlib` only. `index.ts` runs the guard on every buffer.                                       |

**Per format:**

| Format           | Parser files                                                                                                                                                                                                                                                                                                                                   | Dependencies                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| PDF (text layer) | `file-parsers/pdf-parser.ts` (518), `pdfjs-server.ts` (114), `pdf-lines.ts` (497), `pdf-layout.ts` (483), `pdf-furniture.ts` (393; strips repeated headers and footers). Also `knowledge/documents/pdf-text-layer.ts` (104): `assessPdfTextLayer()` judges whether a text layer is usable (≥100 chars/page, ≥80% printable, ≤50% CID escapes). | `pdfjs-dist`, plus `@napi-rs/canvas` or an alternative (above) |
| DOCX             | `file-parsers/docx-parser.ts` (280): mammoth to HTML, then `htmlToStructuredText` from `html-parser.ts`. Bounded by a 50k-node / 2 MiB conversion budget. Remove the `officeparser-module.ts` fallback.                                                                                                                                        | `mammoth`, `cheerio`                                           |
| MD               | `file-parsers/md-parser.ts` (45): decode and sanitise only; no Markdown parsing                                                                                                                                                                                                                                                                | none                                                           |
| TXT              | `file-parsers/txt-parser.ts` (45): same shape as MD                                                                                                                                                                                                                                                                                            | none                                                           |
| CSV              | `file-parsers/csv-parser.ts` (190): `csv-parse` with `columns: true`, output as a `header, header…` line then one `v, v…` line per row. Uses `complete-text.ts` (37) for a byte budget.                                                                                                                                                        | `csv-parse`                                                    |
| HTML             | `file-parsers/html-parser.ts` (561): cheerio to structured text, with size and complexity limits. Imports `imageAltText` from `office-text.ts` (175), which imports `htmlparser2` and type-only `jszip`.                                                                                                                                       | `cheerio`, `htmlparser2`                                       |

## The one chunker

| File                       | Lines | Notes                                                                                                                                                             |
| -------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chunkers/text-chunker.ts` | 117   | `TextChunker`: recursive split on `---`/`***`/`___`, Markdown headings `#`–`######`, blank line, newline, sentence ends, `; `, `, `, space; then optional overlap |
| `chunkers/chunk-budget.ts` | 31    | `ChunkBudget` / `ChunkLimitExceededError` (a hard ceiling on chunk count)                                                                                         |
| `chunkers/utils.ts`        | 242   | `estimateTokens` (chars/4), `cleanText`, `addOverlap`, `buildChunks` (start/end offsets), `resolveChunkerOptions` (default 1,024 tokens, overlap capped at 50%)   |
| `chunkers/types.ts`        | 79    | Keep `Chunk` and `ChunkerOptions`; drop the other strategies' types                                                                                               |

Sim's defaults come from `processDocument()` in `knowledge/documents/document-processor.ts` and the `knowledge_base.chunking_config` default in `packages/db/schema.ts`: chunk size 1,024 tokens, overlap 200, minimum 100 characters, at most `MAX_DOCUMENT_CHUNKS = 5_000` chunks (`knowledge/documents/document-processing-error.ts`).

**A tradeoff for the owner.** In `auto` mode Sim doesn't send CSV through `TextChunker`. `StructuredDataChunker.isStructuredData()` matches `text/csv`, and `chunkStructuredData()` repeats the header row in every chunk (`chunkers/structured-data-chunker.ts`, 268 lines, no deps). With "one chunker", CSV goes through `TextChunker`: it splits on newlines, so rows stay whole, but only the first chunk carries the header line. Options: accept that, or have the CSV parser prefix each row with its header names (a small change in our copy) and still keep one chunker.

**Not ported:** `docs-chunker.ts` (Sim's own docs index), `json-yaml-chunker.ts` (needs `js-yaml`), and `recursive-chunker.ts`, `regex-chunker.ts`, `sentence-chunker.ts`, `token-chunker.ts` (user-selectable strategies; `regex-chunker` imports `@/lib/core/security/linear-regex`).

## Sim-specific code to strip

- **Logging and utils:** every parser imports `createLogger` from `@sim/logger`. Several use `@sim/utils` helpers: `sleep`, `getErrorMessage`, `truncate`, `isRecordLike`, `toRecord`, `escapeRegExp`, `toError`. Swap these for our logger and inline the one-liners.
- **Path alias:** `@/lib/file-parsers/*` and `@/lib/chunkers/*` become relative imports.
- **Provider layer and billing:** `knowledge/embeddings.ts` imports `@/lib/embeddings` (`embedKnowledge`, an Ollama catalog), `@/lib/billing/*`, `@/providers/utils` (`calculateCost`) and `@/lib/tokenization`. Replace it all with TanStack AI `embed()` (map Notes). Don't port `embedding-models.ts` (the `KB_EMBEDDING_MODEL` env catalog) either.
- **OCR:** in `document-processor.ts`: Mistral OCR (`@/lib/internal/mistral/*`), `ocr-*.ts`, `pdf-ocr-chunking.ts`, `pdf-lib` (page counting and splitting for OCR), BYOK keys (`@/lib/api-key/byok`), provider admission and rate limits, and model-input provenance. Without OCR, a PDF that fails `assessPdfTextLayer()` gets the failed status with "no extractable text", which matches Sim's own `PermanentDocumentProcessingError('no_extractable_text')` path.
- **Tag slots, connectors and ACLs:** the `tag1..7`, `number1..5`, `date1..2` and `boolean1..3` columns, `documents/tag-filter.ts`, `search/tag-filters.ts`, connector, ACL and live-source access (`knowledge/access/*`), and the `embedding_search` projection triggers.
- **Other formats:** `doc`, `xlsx`, `pptx`, `odt`, `json` and `yaml` parsers, plus `officeparser-module.ts`, `ooxml-presentation.ts`, `odf-text.ts`, `sheet-display-text.ts`, `data-uri.ts` and `csv-preview-slice.ts`.

## How Sim stores and searches chunks

From `packages/db/schema.ts` and `apps/sim/lib/knowledge/search/*`.

**Tables:**

- `knowledge_base` (line 3576): `embedding_model text default 'text-embedding-3-small'`, `embedding_dimension integer default 1536`, `chunking_config json default {"maxSize":1024,"minSize":1,"overlap":200}`. That's one model per base, which matches our "one fixed embedding Model per Project's Knowledge".
- `document` (line 3645): `filename`, `file_url`, `storage_key`, `file_size`, `mime_type`, `chunk_count`, `token_count`, `character_count`, `processing_status` (`'pending' | 'processing' | 'completed' | 'failed'`), `processing_error`, plus attempt, queue, lease and recovery timestamps for its own job runner.
- `embedding` (line 3952), one row per chunk: `id`, `knowledge_base_id` and `document_id` (cascade), `chunk_index`, `chunk_hash`, `content`, `content_length`, `token_count`, `start_offset`, `end_offset`, `embedding_model`, `enabled`, the tag columns, and `content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content))`.
- **Vector columns:** one pgvector `vector` column per width, with exactly one filled per row (enforced by a `CHECK` using `num_nonnulls(...) = 1`): `embedding vector(1536)`, `embedding_384`, `embedding_768`, `embedding_1024`, `embedding_3072`. This is how Sim lets each base pick a different model.
- `embedding_search` (line 4114): a trigger-maintained projection with `halfvec` copies (1536/384/512/768/1024/3072) carrying the HNSW indexes, so candidate scans skip the TOASTed full-precision vectors. That's scale engineering; we don't need it for v1.

**Indexes:** unique `(document_id, chunk_index)`, `(knowledge_base_id, enabled)`, `(document_id, enabled)`, `(knowledge_base_id, embedding_model)`, and **GIN on `content_tsv`**. HNSW (`m = 16, ef_construction = 64`, `halfvec_cosine_ops`) sits on `embedding_search`, not on `embedding`. A comment in the `embedding` table's index block says it deliberately has no ANN index. Sim's docs index (`docs_embeddings`, line 4227) is the simpler shape: one `vector(1536)` with HNSW `vector_cosine_ops` and a GIN-indexed generated tsvector.

**Search** (`knowledge/search/queries.ts`): Sim **already does hybrid search with RRF**. The vector leg ranks by cosine distance `<=>` (`knowledge/vector-columns.ts`), sets `hnsw.ef_search` and `hnsw.iterative_scan = relaxed_order` (`search/vector-leg.ts`), and applies a distance threshold. The keyword leg uses `websearch_to_tsquery('english', q)` ranked by `ts_rank_cd(content_tsv, q)`, with no threshold (`FTS_CONFIG = 'english'` in `search/candidates.ts`). Each leg fetches `min(max(topK*3, 50), 200)` candidates. `fuseByReciprocalRank()` (around line 564) scores `Σ 1/(RRF_K + rank)` with `RRF_K = 60` (`search/recency.ts`), breaks ties round-robin across legs, and lists the keyword leg first. That function is self-contained and worth porting as is. Sim also adds an optional recency boost and a reranker; we skip both (ADR 0014).

**For our schema** (the owner decides schema): with one fixed model per Project's Knowledge and only OpenAI or Gemini models, a single vector column per width is the simplest Sim-shaped option. OpenAI `text-embedding-3-small` is 1536; `gemini-embedding-001` is 3072 by Sim's schema comment. pgvector's HNSW index caps `vector` at 2,000 dimensions (pgvector README; not re-checked here), which is why Sim indexes 3072 as `halfvec`. Note too that local Postgres is plain `postgres:18` with no pgvector (map Notes). The image and the extension are infrastructure decisions.

## Sources

- Sim at `22c3de1`: `LICENSE`, `NOTICE`, `apps/sim/package.json`, `apps/sim/lib/file-parsers/*`, `apps/sim/lib/chunkers/*`, `apps/sim/lib/knowledge/documents/{document-processor,pdf-text-layer,document-processing-error}.ts`, `apps/sim/lib/knowledge/{embeddings,vector-columns}.ts`, `apps/sim/lib/knowledge/search/{queries,recency,candidates,vector-leg}.ts`, `packages/db/schema.ts`.
- npm registry via `pnpm view`: `pdfjs-dist@5.4.296`, `@napi-rs/canvas@0.1.100` and `@napi-rs/canvas-linux-x64-gnu@0.1.100`, `mammoth@1.12.3`, `csv-parse@7.0.2`, `cheerio@1.1.2`, `officeparser@5.2.2`, `htmlparser2`, `unpdf`, `@thednp/dommatrix`.
- `pdfjs-dist@5.4.296` tarball, `package/legacy/build/pdf.mjs`, lines 14330–14370 and 15620 (read as data, not run).
