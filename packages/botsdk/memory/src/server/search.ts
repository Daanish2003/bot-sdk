import type { ComputerHandle } from "@botsdk/bot/computer/internal";
import {
  dayOf,
  decay,
  defaultImportance,
  importanceWeight,
  logMonthsOf,
  logPath,
  type MemoryBot,
  notesPath,
  parseLog,
  parseNotes,
  parseProfile,
  profilePath,
  readText,
} from "./bot-memory";

/** How many lines `search_memory` returns. */
export const searchResultLimit = 10;

/** One line `search_memory` found: where it is, when it is dated, and what it says. */
export type MemoryHit = {
  /** The file's path on the Computer. */
  file: string;
  /** The line's date (`YYYY-MM-DD`); null for a Profile fact, which has none. */
  date: string | null;
  /** The Bot whose Profile it is, when it is not the searching Bot's own. */
  bot?: string;
  text: string;
};

type Candidate = MemoryHit & { weight: number; tokens: string[] };

const k1 = 1.2;
const b = 0.75;

const tokensOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Searches Bot `botId`'s memory for `query`, as of `now`: its own Profile, every Log month and
 * Notes, and every other Bot's Profile, never another Bot's Log or Notes (ADR 0022). Lines rank
 * by BM25 x the importance multiplier x the decay, in plain TypeScript with no index; the top 10
 * with a match come back. A Computer failure throws, and so does `signal`'s abort.
 */
export async function searchBotMemory(
  computer: ComputerHandle,
  {
    botId,
    bots,
    query,
    now,
    signal,
  }: { botId: string; bots: MemoryBot[]; query: string; now: Date; signal?: AbortSignal },
): Promise<MemoryHit[]> {
  const terms = [...new Set(tokensOf(query))];
  if (terms.length === 0) return [];
  const read = (path: string) => readText(computer, path, { signal });
  const today = dayOf(now);
  const others = bots.filter((other) => other.id !== botId);

  const months = await logMonthsOf(computer, botId, { signal });
  const [own, notes, logs, profiles] = await Promise.all([
    read(profilePath(botId)),
    read(notesPath(botId)),
    Promise.all(months.map((month) => read(logPath(botId, month)))),
    Promise.all(others.map((other) => read(profilePath(other.id)))),
  ]);

  const candidates: Candidate[] = [];
  const add = (hit: MemoryHit, weight: number) =>
    candidates.push({ ...hit, weight, tokens: tokensOf(hit.text) });
  for (const { fact } of parseProfile(own)) {
    add({ file: profilePath(botId), date: null, text: fact }, 1);
  }
  others.forEach((other, index) => {
    for (const { fact } of parseProfile(profiles[index] ?? "")) {
      add({ file: profilePath(other.id), date: null, bot: other.name, text: fact }, 1);
    }
  });
  months.forEach((month, index) => {
    for (const line of parseLog(logs[index] ?? "", month)) {
      add(
        { file: logPath(botId, month), date: line.date, text: line.event },
        importanceWeight(line.importance) * decay(line.date, now),
      );
    }
  });
  for (const note of parseNotes(notes, today)) {
    add(
      { file: notesPath(botId), date: note.date, text: note.detail },
      importanceWeight(defaultImportance) * decay(note.date, now),
    );
  }

  // BM25 over every line as a document.
  const average = candidates.reduce((sum, c) => sum + c.tokens.length, 0) / candidates.length;
  const documentFrequency = new Map(
    terms.map((term) => [term, candidates.filter((c) => c.tokens.includes(term)).length]),
  );
  return candidates
    .map((candidate, order) => {
      let bm25 = 0;
      for (const term of terms) {
        const frequency = candidate.tokens.filter((token) => token === term).length;
        if (frequency === 0) continue;
        const containing = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (candidates.length - containing + 0.5) / (containing + 0.5));
        const length = candidate.tokens.length / average;
        bm25 += (idf * frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * length));
      }
      return { candidate, order, score: bm25 * candidate.weight };
    })
    .filter((ranked) => ranked.score > 0)
    .sort((x, y) => y.score - x.score || x.order - y.order)
    .slice(0, searchResultLimit)
    .map(({ candidate: { weight: _weight, tokens: _tokens, ...hit } }) => hit);
}
