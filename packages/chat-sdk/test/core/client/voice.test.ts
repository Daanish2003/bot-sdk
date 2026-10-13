import { describe, expect, it } from "vitest";

import { quotaResetsAt } from "../../../core/client/quota";
import { appendTranscript, dictationFailureMessage } from "../../../core/client/voice";

describe("appendTranscript", () => {
  it("puts the transcript into an empty composer as it is", () => {
    expect(appendTranscript("", "Plan the trip")).toBe("Plan the trip");
  });

  it("appends after the text already there, with a space between", () => {
    expect(appendTranscript("Please", "plan the trip")).toBe("Please plan the trip");
  });

  it("doesn't double the space when the text already ends in one", () => {
    expect(appendTranscript("Please ", "plan the trip")).toBe("Please plan the trip");
  });

  it("trims the transcript and leaves the composer alone when it is blank", () => {
    expect(appendTranscript("Hi", "  ")).toBe("Hi");
    expect(appendTranscript("Hi", "  there  ")).toBe("Hi there");
  });
});

describe("dictationFailureMessage", () => {
  it("says when the Quota resets, for a quota_exceeded refusal", () => {
    const caught = {
      message: "You've used this window's Quota",
      data: { reason: "quota_exceeded", resetsAt: "2026-10-14T00:00:00.000Z" },
    };

    expect(dictationFailureMessage(caught, "en")).toBe(
      `Dictation is off until ${quotaResetsAt("2026-10-14T00:00:00.000Z", "en")}, when your Quota resets.`,
    );
  });

  it("falls back to the generic failure for an unknown reason", () => {
    expect(dictationFailureMessage({ data: { reason: "nonsense" } }, "en")).toBe(
      "Dictation failed. Your message is unchanged.",
    );
  });
});
