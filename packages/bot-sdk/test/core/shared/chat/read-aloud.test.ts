import type { MessagePart } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import {
  maxUtteranceLength,
  markdownToProse,
  pickOnDeviceVoice,
  readAloudUtterances,
  utterancesOf,
} from "../../../../plugins/assistant/shared/chat/read-aloud";

const textPart = (content: string): MessagePart => ({ type: "text", content });

describe("markdownToProse", () => {
  it("drops fenced code blocks, closed or cut off", () => {
    expect(markdownToProse("Run this:\n```ts\nconst x = 1;\n```\nThen stop.")).toBe(
      "Run this:\nThen stop.",
    );
    expect(markdownToProse("Start.\n```ts\nconst x = 1;")).toBe("Start.");
  });

  it("drops inline code", () => {
    expect(markdownToProse("Call `fetchUser` first.")).toBe("Call first.");
  });

  it("keeps a link's text and drops its URL", () => {
    expect(markdownToProse("See [the spec](https://example.com/spec) now.")).toBe(
      "See the spec now.",
    );
  });

  it("keeps a reference-style link's text and drops its label and definition", () => {
    expect(markdownToProse("See [the spec][spec] now.\n\n[spec]: https://example.com/spec")).toBe(
      "See the spec now.",
    );
  });

  it("drops bare URLs and autolinks", () => {
    expect(markdownToProse("Visit https://example.com/a or <https://example.com/b>.")).toBe(
      "Visit or .",
    );
  });

  it("drops images", () => {
    expect(markdownToProse("A chart: ![sales](https://example.com/c.png) above.")).toBe(
      "A chart: above.",
    );
  });

  it("removes emphasis, heading, quote and list markers", () => {
    expect(markdownToProse("## Plan\n\n- **Bold** and _soft_ and ~~gone~~\n> quoted")).toBe(
      "Plan\nBold and soft and gone\nquoted",
    );
    expect(markdownToProse("1. first\n2. second")).toBe("first\nsecond");
  });

  it("drops rules and table separators, and reads table cells", () => {
    expect(markdownToProse("Before\n---\n| a | b |\n|---|:-:|\n| 1 | 2 |")).toBe(
      "Before\na b\n1 2",
    );
  });

  it("keeps plain snake_case words intact", () => {
    expect(markdownToProse("Set max_tokens to 4.")).toBe("Set max_tokens to 4.");
  });
});

describe("readAloudUtterances", () => {
  it("reads only text parts, not reasoning or tool calls", () => {
    const parts = [
      { type: "thinking", content: "Hidden thought." },
      textPart("The answer is 4."),
      {
        type: "tool-call",
        id: "call-1",
        name: "server_time",
        arguments: "{}",
        input: {},
        state: "complete",
        output: { now: "noon" },
        metadata: { source: "host", status: "done" },
      },
      textPart("Done."),
    ] as MessagePart[];

    expect(readAloudUtterances(parts)).toEqual(["The answer is 4.", "Done."]);
  });

  it("gives nothing for a Message with no readable text", () => {
    expect(readAloudUtterances([textPart("```\nonly code\n```")])).toEqual([]);
  });
});

describe("utterancesOf", () => {
  it("splits at sentence ends and at line breaks", () => {
    expect(utterancesOf("First one. Second one! Third?\nA new line.")).toEqual([
      "First one.",
      "Second one!",
      "Third?",
      "A new line.",
    ]);
  });

  it("keeps each utterance within the browser's length limit, cutting at a space", () => {
    const word = "lorem ";
    const long = word.repeat(Math.ceil((maxUtteranceLength * 2.5) / word.length)).trim();

    const utterances = utterancesOf(long);

    expect(utterances.length).toBeGreaterThan(2);
    for (const utterance of utterances) {
      expect(utterance.length).toBeLessThanOrEqual(maxUtteranceLength);
      expect(utterance.startsWith("lorem")).toBe(true);
    }
    expect(utterances.join(" ")).toBe(long);
  });

  it("cuts a word longer than the limit when there is no space to cut at", () => {
    const token = "x".repeat(maxUtteranceLength + 10);

    expect(utterancesOf(token)).toEqual([
      token.slice(0, maxUtteranceLength),
      token.slice(maxUtteranceLength),
    ]);
  });
});

describe("pickOnDeviceVoice", () => {
  const voice = (name: string, lang: string, localService: boolean, isDefault = false) => ({
    name,
    lang,
    localService,
    default: isDefault,
  });

  it("picks the first on-device voice for the document's language", () => {
    const voices = [
      voice("Network German", "de-DE", false),
      voice("English", "en-US", true),
      voice("Local German", "de-DE", true),
      voice("Other German", "de-AT", true),
    ];

    expect(pickOnDeviceVoice(voices, "de")?.name).toBe("Local German");
  });

  it("matches the language by its primary tag", () => {
    expect(pickOnDeviceVoice([voice("English", "en-GB", true)], "en-US")?.name).toBe("English");
  });

  it("falls back to the default on-device voice, then the first on-device voice", () => {
    const voices = [
      voice("Network", "fr-FR", false, true),
      voice("Local A", "es-ES", true),
      voice("Local B", "it-IT", true, true),
    ];

    expect(pickOnDeviceVoice(voices, "de")?.name).toBe("Local B");
    expect(pickOnDeviceVoice([voice("Local A", "es-ES", true)], "de")?.name).toBe("Local A");
  });

  it("never picks a voice that is not on the device", () => {
    expect(pickOnDeviceVoice([voice("Network", "en-US", false)], "en")).toBeUndefined();
  });
});
