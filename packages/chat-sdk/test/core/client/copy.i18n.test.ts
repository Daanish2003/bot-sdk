import { describe, expect, it } from "vitest";

import { describeError } from "../../../core/client/chat";
import { missingCredentialsMessage } from "../../../core/client/models";
import { describeSearch, describeSearches, searchToggle } from "../../../core/client/web-search";
import { createI18n } from "../../../core/shared/i18n";
import type { WebSearchPart } from "../../../core/shared/message-parts";
import { reasoningChoiceLabel } from "../../../core/shared/chat/models";
import { wrappedDictionary } from "../../ui/fake-dictionary";

const wrapped = createI18n(wrappedDictionary(), "en");

const search = (fields: Partial<WebSearchPart>): WebSearchPart =>
  ({
    type: "web_search",
    toolCallId: "call-1",
    query: "tanstack ai",
    state: "done",
    results: [],
    ...fields,
  }) as WebSearchPart;

const result = { title: "T", url: "https://a.example/x", snippet: "S" };

describe("core copy through the dictionary", () => {
  it("wraps every message an errored reply shows", () => {
    expect(describeError(wrapped, { error: null, errorReason: "invalid_key" } as never).text).toBe(
      "⟦The Provider rejected your API key.⟧",
    );
    expect(describeError(wrapped, { error: "timed out", errorReason: null } as never).text).toBe(
      "⟦The reply took too long and timed out.⟧",
    );
    expect(describeError(wrapped, { error: null, errorReason: null } as never).text).toBe(
      "⟦Something went wrong.⟧",
    );
  });

  it("wraps every search line, with its plurals", () => {
    expect(describeSearch(wrapped, search({ state: "running" })).text).toBe(
      '⟦Searching the web for "tanstack ai"…⟧',
    );
    expect(describeSearch(wrapped, search({ results: [result] })).text).toBe(
      '⟦Searched "tanstack ai" · 1 source⟧',
    );
    expect(
      describeSearches(wrapped, [search({ results: [result] }), search({ toolCallId: "2" })]).text,
    ).toBe("⟦Searched 2 times · 1 source⟧");
    expect(describeSearches(wrapped, [search({}), search({ toolCallId: "2" })]).text).toBe(
      "⟦Searched 2 times · no sources⟧",
    );
  });

  it("wraps the Web toggle's tooltips", () => {
    expect(searchToggle(wrapped, { hasTavilyKey: true, modelTools: false, on: true }).tooltip).toBe(
      "⟦This Model can't use tools, so it can't use the web⟧",
    );
    expect(searchToggle(wrapped, { hasTavilyKey: true, modelTools: true, on: false }).tooltip).toBe(
      "⟦Web off⟧",
    );
  });

  it("wraps Pick another Model and the reasoning labels", () => {
    expect(missingCredentialsMessage(wrapped, "openai:gpt-2", [], false)).toBe(
      "⟦Pick another Model⟧",
    );
    expect(reasoningChoiceLabel(wrapped, null)).toBe("⟦Model default⟧");
    expect(reasoningChoiceLabel(wrapped, "high")).toBe("⟦High⟧");
  });

  it("falls back to English for a key a partial dictionary leaves out", () => {
    const partial = createI18n({ "chat.pickAnotherModel": "Choisissez un autre modèle" }, "fr");

    expect(missingCredentialsMessage(partial, "openai:gpt-2", [], false)).toBe(
      "Choisissez un autre modèle",
    );
    expect(reasoningChoiceLabel(partial, "low")).toBe("Low");
  });
});
