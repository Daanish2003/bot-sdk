import type { RichControl } from "@botsdk/client/bot/rich-control";
import { describe, expect, it } from "vitest";

import {
  emailBody,
  headerText,
  maxAttachedBytes,
  namedAddress,
  replySubject,
} from "@botsdk/bot/channel/internal";

const botUrl = "https://app.example/bots/b1";
const file = (id: string, name: string, size: number) => ({
  id: `0199d3a0-0000-7000-8000-00000000000${id}`,
  name,
  size,
  mediaType: "text/csv",
});

const lastLineOf = (control: RichControl) =>
  emailBody({ text: "Hi.", control }, { botUrl }).text.split("\n").at(-1);

describe("emailBody", () => {
  it("sends text as plain text plus simple, escaped HTML", () => {
    const body = emailBody({ text: '1 < 2 & "so"\nnext line' }, { botUrl });

    expect(body.text).toBe('1 < 2 & "so"\nnext line');
    expect(body.html).toBe("<p>1 &lt; 2 &amp; &quot;so&quot;<br>next line</p>");
    expect(body).not.toHaveProperty("attachments");
  });

  it("attaches files that fit in 10 MB in total", () => {
    const report = file("1", "report.csv", 8);
    const bytes = new TextEncoder().encode("a,b\n1,2\n");

    const body = emailBody(
      { text: "Here it is.", control: { kind: "files", files: [report] } },
      { botUrl, files: [{ file: report, bytes }] },
    );

    expect(body.attachments).toEqual([
      { name: "report.csv", contentType: "text/csv", content: bytes },
    ]);
    expect(body.text).toBe("Here it is.");
  });

  it("links files over 10 MB in total, or gone from storage, instead of attaching them", () => {
    const big = file("1", "big.csv", maxAttachedBytes);
    const small = file("2", "small.csv", 1);
    const control: RichControl = { kind: "files", files: [big, small] };

    for (const files of [
      [
        { file: big, bytes: null },
        { file: small, bytes: null },
      ],
      [{ file: small, bytes: null }],
    ]) {
      const body = emailBody({ text: "Here.", control }, { botUrl, files });
      expect(body).not.toHaveProperty("attachments");
      expect(body.text).toBe(
        ["Here.", "", "- big.csv\n- small.csv", "", `Download them in the app: ${botUrl}`].join(
          "\n",
        ),
      );
      expect(body.html).toContain("<ul><li>big.csv</li><li>small.csv</li></ul>");
    }
  });

  it("reduces each card to one line and a link", () => {
    expect(
      lastLineOf({
        kind: "computer",
        helperId: "h1",
        reason: "Log in",
        state: "open",
      } as RichControl),
    ).toBe(`Take over the Computer in the app: ${botUrl}`);
    expect(
      lastLineOf({
        kind: "demonstration",
        demonstrationId: "d1",
        goal: "File it",
        state: "recording",
        startedAt: "2026-10-22T09:00:00.000Z",
        endedAt: null,
        steps: 0,
      } as RichControl),
    ).toBe(`Show me in the app: ${botUrl}`);
    expect(lastLineOf({ kind: "routine_approval", routineId: "r1" } as RichControl)).toBe(
      `Approve or decline in the app: ${botUrl}`,
    );
    expect(lastLineOf({ kind: "review_approval", reviewId: "v1" } as RichControl)).toBe(
      `Approve or decline in the app: ${botUrl}`,
    );
    expect(
      emailBody(
        { text: "Hi.", control: { kind: "routine_approval", routineId: "r1" } as RichControl },
        { botUrl },
      ).text.split("\n"),
    ).toHaveLength(3);
  });

  it("sends a Secret request as a link only, naming no field to answer in", () => {
    const body = emailBody(
      {
        text: "I need your token.",
        control: { kind: "secret", name: "GITHUB_TOKEN", why: "To push." },
      },
      { botUrl },
    );

    expect(body.text).toBe(`I need your token.\n\nEnter it securely in the app: ${botUrl}`);
  });
});

describe("replySubject", () => {
  it("answers with one Re:, and the fallback for an empty subject", () => {
    expect(replySubject("Plans", "Ada")).toBe("Re: Plans");
    expect(replySubject("RE: re:Plans", "Ada")).toBe("Re: Plans");
    expect(replySubject("Two\r\nlines", "Ada")).toBe("Re: Two lines");
    expect(replySubject("  ", "Ada")).toBe("Re: Ada");
    expect(replySubject("", "Ada\r\nBcc: x@example.com")).toBe("Re: Ada Bcc: x@example.com");
    expect(headerText("Ada\r\nBcc: x@example.com")).toBe("Ada Bcc: x@example.com");
  });
});

describe("namedAddress", () => {
  it("quotes the Bot's name so it can't break the header", () => {
    expect(namedAddress('Ada "the" Bot\r\nBcc: x', "a.b@bots.example")).toBe(
      '"Ada \\"the\\" Bot Bcc: x" <a.b@bots.example>',
    );
  });
});
