---
Status: accepted
---

# Knowledge file processing is ported from Sim Studio, not from bcatalyst

The parsers and chunkers for Knowledge files are ported from upstream Sim Studio (github.com/simstudioai/sim, Apache-2.0), with its notice in a `NOTICE` file. The owner's employer's platform has a Knowledge base that is itself a Sim port. We use it only as a guide to which parts are worth taking, and copy nothing from it: that repo is private, unlicensed and dropped Sim's attribution.

We take a small part: parsers for PDF (text layer), DOCX, Markdown, text, CSV and HTML, and one chunker. Search is hybrid pgvector and Postgres full-text search, fused by reciprocal rank, with no reranker. We leave out Sim's OAuth connectors, website crawler, tag slots and OCR.

## Considered Options

- **Copy the employer's code**: fastest, but it isn't ours to publish.
- **Write everything from scratch**: no licence to track, but re-solves file parsing that Sim already handles well.

## Consequences

- Every ported file keeps Apache-2.0 attribution, and `NOTICE` must ship with the Chat SDK copy.
- Embeddings use the user's own OpenAI or Gemini credentials when they have them, and Host credentials otherwise. Each Project's Knowledge keeps one fixed embedding Model.

## Amendment: through TanStack AI, in one 1536-dimension column (2026-10-12, #197, #204)

- **Every model call goes through TanStack AI.** Ported code makes its model calls with `@tanstack/ai`. Embeddings use `embed()` with `openaiEmbedding` or `geminiEmbedding`, and search is a `toolDefinition` tool. Sim's provider layer isn't ported. TanStack's `rerank()` isn't used.
- **One `vector(1536)` column for every Project, with one HNSW cosine index.**
  - `text-embedding-3-small` is natively 1536. `text-embedding-3-large` and `gemini-embedding-001` are asked for 1536 dimensions, and we normalise Gemini's output ourselves.
  - HNSW on `vector` stops at 2,000 dimensions. A column per dimension would mean an index per dimension.
  - `halfvec(3072)` was the alternative: full quality for the larger Models, at half precision. It was rejected because 1536 is enough for every Model we list.
  - Filtering by Project relies on pgvector 0.8's iterative index scans.
- **The Model is fixed once the Project has a Knowledge file.**
  - It's chosen in the Knowledge tab before the first upload. The default is OpenAI if the owner has an OpenAI key, then Gemini, then the Host's Model.
  - It can change only when the Project has no files. Nothing re-embeds automatically.
  - Switching between the owner's key and the Host's for the same Model needs no re-embedding.
- **Embedding on Host credentials counts against the Quota** under a new usage kind, `embedding`. Gemini returns no usage, so its rows are estimated.

## Amendment: no native binary for PDFs, and CSV rows carry their headers (2026-10-12, #205)

- **No native binary for PDFs.** pdf.js needs a `DOMMatrix` when it loads. Sim gets one from `@napi-rs/canvas`, a native binary of about 33 MB per platform, which would break a copied SDK on other platforms. We set a pure-JS polyfill (`@thednp/dommatrix`) before importing `pdfjs-dist`, and a test proves text extraction works. If it doesn't, the fallback is `unpdf`.
- **CSV rows carry their headers.** With one chunker, only the first chunk of a CSV would carry the header row. Our CSV parser writes each row with its header names, so we don't port Sim's separate structured-data chunker.
