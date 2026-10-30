import { describe, expect, it } from "vitest";

import { mentionedMembers } from "@botsdk/client/bot/mentions";

const scout = { botId: "b1", name: "Scout" };
const writer = { botId: "b2", name: "Writer" };
const ops = { botId: "b3", name: "Ops Team" };
const opsLead = { botId: "b4", name: "Ops Team Lead" };
const members = [scout, writer, ops, opsLead];

describe("mentions in a Room Message", () => {
  it("names each member mentioned by @ and their full name, case-insensitive, once each in order", () => {
    expect(mentionedMembers("@writer and @SCOUT, then @Writer again", members)).toEqual([
      "b2",
      "b1",
    ]);
  });

  it("matches the longest name first, so names with spaces work", () => {
    expect(mentionedMembers("@Ops Team Lead please", members)).toEqual(["b4"]);
    expect(mentionedMembers("ask @ops team now", members)).toEqual(["b3"]);
  });

  it("leaves an @ that matches no member as plain text", () => {
    expect(mentionedMembers("mail bob@scout.com or @Nobody", members)).toEqual([]);
    expect(mentionedMembers("@Scouting is not @Scout2", members)).toEqual([]);
    expect(mentionedMembers("@", members)).toEqual([]);
  });

  it("ends a name at punctuation or the end of the text", () => {
    expect(mentionedMembers("(@Scout) @Writer.", members)).toEqual(["b1", "b2"]);
    // A character whose lower case is longer, before the mention, moves nothing.
    expect(mentionedMembers("İİ @Scout", members)).toEqual(["b1"]);
    expect(mentionedMembers("İİ @Scoutİİ", members)).toEqual([]);
  });
});
