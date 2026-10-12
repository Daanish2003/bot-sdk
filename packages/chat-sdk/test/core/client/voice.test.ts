import { describe, expect, it } from "vitest";

import { appendTranscript } from "../../../core/client/voice";

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
