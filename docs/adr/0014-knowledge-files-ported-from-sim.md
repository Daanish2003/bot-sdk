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
