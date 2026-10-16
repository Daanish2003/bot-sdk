import { describe, expect, it } from "vitest";

import { awaitingTitle } from "../../../core/client/title";

const reply = (status: "streaming" | "complete" | "stopped" | "error") => ({
  role: "assistant" as const,
  status,
});
const question = { role: "user" as const, status: "complete" as const };

describe("awaitingTitle", () => {
  it("waits for the automatic title once a reply has completed", () => {
    expect(awaitingTitle({ title: null, messages: [question, reply("complete")] })).toBe(true);
  });

  it("doesn't wait once there is a title", () => {
    expect(awaitingTitle({ title: "Trip", messages: [question, reply("complete")] })).toBe(false);
  });

  it("doesn't wait while a reply streams or when no reply completed", () => {
    expect(awaitingTitle({ title: null, messages: [question, reply("streaming")] })).toBe(false);
    expect(awaitingTitle({ title: null, messages: [question, reply("error")] })).toBe(false);
    expect(awaitingTitle({ title: null, messages: [] })).toBe(false);
  });

  it("doesn't wait before the Conversation has loaded", () => {
    expect(awaitingTitle(undefined)).toBe(false);
  });
});
