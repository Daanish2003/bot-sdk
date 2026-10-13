import { describe, expect, it } from "vitest";

import { describeError } from "../../../core/client/chat";
import { renamePromptText } from "../../../core/client/react/conversation-actions";
import { deleteConfirmText } from "../../../core/client/react/delete-conversation";
import { recentConversations } from "../../../core/client/search";
import { missingCredentialsMessage } from "../../../core/client/models";
import { RateLimitedError } from "../../../core/client/rate-limit";
import { lastRowLabel, savedPromptDraftError } from "../../../core/client/saved-prompts-menu";
import { dictationFailureMessage } from "../../../core/client/voice";
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

  it("wraps the delete confirmation and the rename prompt", () => {
    expect(deleteConfirmText(wrapped, { title: "Trip", shared: false })).toBe(
      '⟦Delete "Trip"? This can\'t be undone.⟧',
    );
    expect(deleteConfirmText(wrapped, { title: "Trip", shared: true })).toBe(
      '⟦Delete "Trip"? This also deletes its Shared link. This can\'t be undone.⟧',
    );
    expect(renamePromptText(wrapped)).toBe("⟦Rename Conversation⟧");
  });

  it("reads Untitled from the dictionary, in the delete confirmation and the palette's search", () => {
    const french = createI18n({ "shell.untitled": "Sans titre" }, "fr");

    expect(deleteConfirmText(french, { title: null, shared: false })).toBe(
      'Delete "Sans titre"? This can\'t be undone.',
    );
    expect(
      recentConversations(french, [{ id: "1", title: null }], "sans").map((c) => c.id),
    ).toEqual(["1"]);
  });

  it("wraps every dictation toast, the Quota reset time included", () => {
    expect(dictationFailureMessage({ data: { reason: "invalid_key" } }, wrapped)).toBe(
      "⟦Dictation failed: your key was rejected. Check it in Keys & settings.⟧",
    );
    expect(dictationFailureMessage({ data: { reason: "failed" } }, wrapped)).toBe(
      "⟦Dictation failed. Your message is unchanged.⟧",
    );
    expect(dictationFailureMessage(new RateLimitedError(12), wrapped)).toBe(
      "⟦Too many recordings. Try again in 12 seconds.⟧",
    );
    expect(
      dictationFailureMessage(
        { data: { reason: "quota_exceeded", resetsAt: "2026-10-14T00:00:00.000Z" } },
        wrapped,
      ),
    ).toMatch(/^⟦Dictation is off until .+, when your Quota resets\.⟧$/);
  });

  it("wraps the Saved prompt rows and the draft errors of the / menu", () => {
    const prompts = [{ name: "review" }];

    expect(lastRowLabel(wrapped, "xyz", 0)).toBe("⟦Create /xyz…⟧");
    expect(lastRowLabel(wrapped, "rev", 2)).toBe("⟦New Saved prompt…⟧");
    expect(savedPromptDraftError(wrapped, prompts, { name: "Bad Name", text: "x" })).toBe(
      "⟦Names use lowercase letters, digits and -, up to 32 characters⟧",
    );
    expect(savedPromptDraftError(wrapped, prompts, { name: "review", text: "x" })).toBe(
      '⟦You already have a Saved prompt named "review"⟧',
    );
    expect(savedPromptDraftError(wrapped, prompts, { name: "eli5", text: "   " })).toBe(
      "⟦Text can't be blank⟧",
    );
  });
});
