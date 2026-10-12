import type { MessagePart } from "@tanstack/ai";

/**
 * What read-aloud (#257) speaks of a reply: its text parts as prose, split into sentence-sized
 * utterances. No server code: safe to import into the browser.
 */

/** The longest utterance handed to the browser, so a long sentence isn't cut off mid-speech. */
export const maxUtteranceLength = 200;

/** An assistant Message's text parts as plain prose, one block per text part. No reasoning, no tool calls. */
export function readableText(parts: MessagePart[]): string {
  return parts
    .flatMap((part) => (part.type === "text" ? [markdownToProse(part.content)] : []))
    .filter(Boolean)
    .join("\n");
}

/** Markdown as the words a reader would hear: code, URLs and syntax removed, link text kept. */
export function markdownToProse(markdown: string): string {
  const withoutBlocks = markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/~~~[\s\S]*?(~~~|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, " ")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ");

  return withoutBlocks
    .split("\n")
    .map((line) => {
      if (/^\s*([-*_]\s*){3,}$/.test(line)) return "";
      if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line)) return "";
      return line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
        .replace(/\|/g, " ")
        .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, "$2")
        .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?![\w*])/g, "$1$2")
        .replace(/[ \t]+/g, " ")
        .trim();
    })
    .filter(Boolean)
    .join("\n");
}

/** Sentence-sized utterances of a prose text: split at line breaks and sentence ends. */
export function utterancesOf(text: string): string[] {
  const utterances: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    for (const sentence of paragraph.split(/(?<=[.!?…])\s+/)) {
      utterances.push(...cutToLength(sentence.trim(), maxUtteranceLength));
    }
  }
  return utterances.filter(Boolean);
}

/** The utterances a reply's text parts read as, in order. */
export function readAloudUtterances(parts: MessagePart[]): string[] {
  return utterancesOf(readableText(parts));
}

/** Cuts a sentence into pieces of at most `max` characters, at a space where one is near. */
function cutToLength(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  pieces.push(rest);
  return pieces;
}

/** The primary tag of a language: `de` for `de-AT`. */
function primaryTag(lang: string): string {
  return lang.toLowerCase().split(/[-_]/)[0] ?? "";
}

/**
 * The voice to read with: the first on-device voice for the language, else the browser's default
 * on-device voice, else the first on-device voice. Network voices are never picked (the text
 * stays on the device).
 */
export function pickOnDeviceVoice<
  V extends { lang: string; localService: boolean; default: boolean },
>(voices: V[], lang: string): V | undefined {
  const local = voices.filter((voice) => voice.localService);
  const primary = primaryTag(lang);
  return (
    local.find((voice) => primary !== "" && primaryTag(voice.lang) === primary) ??
    local.find((voice) => voice.default) ??
    local[0]
  );
}
