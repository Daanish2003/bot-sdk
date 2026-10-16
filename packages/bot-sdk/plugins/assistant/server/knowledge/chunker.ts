/**
 * The text chunker, ported from Sim Studio (https://github.com/simstudioai/sim) at commit
 * 22c3de1f7d02fdb6fc925ad858abb555c20f5493, from `apps/sim/lib/chunkers/text-chunker.ts`,
 * `chunk-budget.ts` and the helpers of `utils.ts` it calls. Licensed under Apache-2.0; see the
 * NOTICE file that ships with the Bot SDK (ADR 0014).
 *
 * Changes from the source: the helpers are reduced to the ones this chunker uses, the minimum
 * chunk length is applied here (Sim resolves it but never applies it in this chunker), and the
 * `Chunk` shape is the one the Knowledge processing job needs.
 */

/** Raised before the chunker would produce more than its configured output ceiling. */
export class ChunkLimitExceededError extends Error {
  readonly maxChunks: number;

  constructor(maxChunks: number) {
    super(`Chunk production exceeded the configured limit of ${maxChunks.toLocaleString()}`);
    this.name = "ChunkLimitExceededError";
    this.maxChunks = maxChunks;
  }
}

/** Shared output budget that lets the recursive splitter enforce one ceiling. */
class ChunkBudget {
  private produced = 0;

  private readonly maxChunks: number;

  constructor(maxChunks: number) {
    this.maxChunks = maxChunks;
  }

  add(target: string[], value: string): void {
    if (this.produced >= this.maxChunks) throw new ChunkLimitExceededError(this.maxChunks);
    target.push(value);
    this.produced += 1;
  }
}

export type ChunkerOptions = {
  /** Tokens per chunk. */
  chunkSize: number;
  /** Tokens shared with the previous chunk, at most half a chunk. */
  chunkOverlap: number;
  /** Chunks shorter than this (in characters) are dropped, unless that would leave none. */
  minCharactersPerChunk: number;
  /** The most chunks one text may produce. */
  maxChunks: number;
};

export type Chunk = { text: string; tokenCount: number };

/** 1 token is about 4 characters for English text (Sim's estimate). */
export function estimateTokens(text: string): number {
  if (!text.trim()) return 0;
  return Math.ceil(text.length / 4);
}

function tokensToChars(tokens: number): number {
  return tokens * 4;
}

function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\t/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** Splits on a literal separator, keeping empty parts, as `String.split` does. */
function* literalParts(text: string, separator: string): Generator<string> {
  let cursor = 0;
  while (cursor <= text.length) {
    const next = text.indexOf(separator, cursor);
    if (next === -1) {
      yield text.slice(cursor);
      return;
    }
    yield text.slice(cursor, next);
    cursor = next + separator.length;
  }
}

function hasMultipleNonEmptyParts(text: string, separator: string): boolean {
  let nonEmpty = 0;
  for (const part of literalParts(text, separator)) {
    if (!part.trim()) continue;
    nonEmpty += 1;
    if (nonEmpty === 2) return true;
  }
  return false;
}

/** Cuts text into pieces of at most `chunkSizeChars`, preferring to end at a space. */
function* wordBoundaryChunks(text: string, chunkSizeChars: number): Generator<string> {
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + chunkSizeChars, text.length);
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(" ", end);
      if (lastSpace > pos) end = lastSpace;
    }
    const raw = text.slice(pos, end);
    const start = pos + (raw.length - raw.trimStart().length);
    const stop = end - (raw.length - raw.trimEnd().length);
    if (stop > start) yield text.slice(start, stop);
    if (end >= text.length) break;
    pos = end;
    while (pos < text.length && text[pos] === " ") pos += 1;
  }
}

/** Prefixes each chunk with the tail of the one before it, cut at a word. */
function addOverlap(chunks: string[], overlapChars: number): string[] {
  if (overlapChars <= 0 || chunks.length <= 1) return chunks;
  return chunks.map((chunk, index) => {
    if (index === 0) return chunk;
    const previous = chunks[index - 1]!;
    const tail = previous.slice(-Math.min(overlapChars, previous.length));
    const wordStart = tail.match(/^\s*\S/);
    const clean = wordStart ? tail.slice(tail.indexOf(wordStart[0].trim())) : tail;
    return clean.trim() ? `${clean.trim()} ${chunk}` : chunk;
  });
}

const separators = [
  "\n---\n",
  "\n***\n",
  "\n___\n",
  "\n# ",
  "\n## ",
  "\n### ",
  "\n#### ",
  "\n##### ",
  "\n###### ",
  "\n\n",
  "\n",
  ". ",
  "! ",
  "? ",
  "; ",
  ", ",
  " ",
];

/**
 * Splits text into chunks of about `chunkSize` tokens, breaking at the largest separator that
 * fits (Markdown rules first, then paragraphs, lines, sentences and words), and overlapping each
 * chunk with the end of the one before it.
 */
export function chunkText(text: string, options: ChunkerOptions): Chunk[] {
  if (!text.trim()) return [];
  const budget = new ChunkBudget(options.maxChunks);
  const chunks: string[] = [];
  splitRecursively(cleanText(text), chunks, budget, options.chunkSize, 0);

  const sized = chunks.filter((chunk) => chunk.length >= options.minCharactersPerChunk);
  // A text shorter than the minimum is still one chunk, rather than no chunks at all.
  const kept = sized.length > 0 ? sized : chunks.slice(0, 1);
  const overlapped = addOverlap(kept, tokensToChars(options.chunkOverlap));
  return overlapped.map((chunk) => ({ text: chunk, tokenCount: estimateTokens(chunk) }));
}

function splitRecursively(
  text: string,
  chunks: string[],
  budget: ChunkBudget,
  chunkSize: number,
  separatorIndex: number,
): void {
  if (estimateTokens(text) <= chunkSize) {
    if (text.trim()) budget.add(chunks, text);
    return;
  }

  if (separatorIndex >= separators.length) {
    for (const part of wordBoundaryChunks(text, tokensToChars(chunkSize))) budget.add(chunks, part);
    return;
  }

  const separator = separators[separatorIndex]!;
  if (!hasMultipleNonEmptyParts(text, separator)) {
    splitRecursively(text, chunks, budget, chunkSize, separatorIndex + 1);
    return;
  }

  let current = "";
  for (const part of literalParts(text, separator)) {
    if (!part.trim()) continue;
    const candidate = current + (current ? separator : "") + part;
    if (estimateTokens(candidate) <= chunkSize) {
      current = candidate;
      continue;
    }
    if (current.trim()) budget.add(chunks, current.trim());
    if (estimateTokens(part) > chunkSize) {
      splitRecursively(part, chunks, budget, chunkSize, separatorIndex + 1);
      current = "";
    } else {
      current = part;
    }
  }
  if (current.trim()) budget.add(chunks, current.trim());
}
