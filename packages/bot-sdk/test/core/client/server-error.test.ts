import { describe, expect, it } from "vitest";

import { serverErrorText } from "@botsdk/react/rpc-error";
import { createI18n } from "@botsdk/client/i18n";
import { wrappedDictionary } from "../../ui/fake-dictionary";

const wrapped = createI18n(wrappedDictionary(), "en");

/** An oRPC error as the client sees it: the standard code, the English message and `data`. */
const rpcFailure = (data: unknown, message = "English for the logs") =>
  Object.assign(new Error(message), { code: "BAD_REQUEST", data });

describe("serverErrorText", () => {
  it("shows the dictionary's text for the error's code", () => {
    const error = rpcFailure({ code: "error.conversationNotFound" }, "Conversation not found");

    expect(serverErrorText(wrapped, error)).toBe("⟦Conversation not found⟧");
  });

  it("passes the params to the dictionary's function", () => {
    const error = rpcFailure({ code: "error.modelNotAvailable", params: { model: "openai:x" } });

    expect(serverErrorText(wrapped, error)).toBe('⟦"openai:x" is not an available Model⟧');
  });

  it("formats a number param in the locale", () => {
    const error = rpcFailure({ code: "error.botFilesTooMany", params: { max: 4000 } });

    expect(serverErrorText(createI18n({}, "en"), error)).toBe(
      "A message can carry at most 4,000 files",
    );
    expect(serverErrorText(createI18n({}, "de"), error)).toBe(
      "A message can carry at most 4.000 files",
    );
  });

  it("never shows the server's English message", () => {
    expect(serverErrorText(wrapped, rpcFailure(undefined, "Input validation failed"))).toBe(
      "⟦Something went wrong. Try again.⟧",
    );
  });

  it("shows the given fallback when the error carries no code", () => {
    expect(serverErrorText(wrapped, new Error("Failed to fetch"), "bots.liveViewFailed")).toBe(
      "⟦The live view couldn't open.⟧",
    );
  });

  it("shows the fallback for a code the dictionary doesn't have", () => {
    expect(serverErrorText(wrapped, rpcFailure({ code: "error.nope" }))).toBe(
      "⟦Something went wrong. Try again.⟧",
    );
  });

  it("ignores a code that isn't an error key", () => {
    expect(serverErrorText(wrapped, rpcFailure({ code: "bots.newBot" }))).toBe(
      "⟦Something went wrong. Try again.⟧",
    );
  });
});
