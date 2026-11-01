import { describe, expect, it } from "vitest";

import { mentionedMembers } from "@botsdk/client/bot/mentions";
import { mentionedInMessage } from "@botsdk/client/message-format";

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

describe("mentions in a Markdown Message", () => {
  it("ignores an @name in inline code", () => {
    expect(mentionedInMessage("run `@Scout` to try", members)).toEqual([]);
    expect(mentionedInMessage("``a `@Scout` b``", members)).toEqual([]);
  });

  it("ignores an @name in fenced and indented code, and in a JSON Message", () => {
    expect(mentionedInMessage("```\n@Scout\n```", members)).toEqual([]);
    expect(mentionedInMessage("~~~ts\nconst a = '@Scout';\n~~~", members)).toEqual([]);
    expect(mentionedInMessage("Try:\n\n    @Scout\n", members)).toEqual([]);
    expect(mentionedInMessage('{"to": "@Scout"}', members)).toEqual([]);
  });

  it("wakes a Bot mentioned beside code, and each Bot once", () => {
    expect(mentionedInMessage("`@Scout` is code, but @Writer is not", members)).toEqual(["b2"]);
    expect(mentionedInMessage("`@Scout` then @Scout", members)).toEqual(["b1"]);
  });

  it("wakes a Bot whose @name is wrapped in Markdown", () => {
    expect(mentionedInMessage("_@Scout_ please look", members)).toEqual(["b1"]);
    expect(mentionedInMessage("*@Scout* please", members)).toEqual(["b1"]);
    expect(mentionedInMessage("**@Writer**: go", members)).toEqual(["b2"]);
    expect(mentionedInMessage("~~@Scout~~ and __@Writer__", members)).toEqual(["b1", "b2"]);
    expect(mentionedInMessage("_**@Ops Team Lead**_ now", members)).toEqual(["b4"]);
    expect(mentionedInMessage("[@Scout](https://a.example) look", members)).toEqual(["b1"]);
    expect(mentionedInMessage("> @Writer said\n\n- @Scout", members)).toEqual(["b2", "b1"]);
  });

  it("wakes a Bot whose name is wrapped inside the mention", () => {
    expect(mentionedInMessage("@**Scout** look", members)).toEqual(["b1"]);
  });

  it("keeps a name with spaces whole when part of it is wrapped", () => {
    expect(mentionedInMessage("@Ops _Team_", members)).toEqual(["b3"]);
  });

  it("still treats an @ inside a word as plain text", () => {
    expect(mentionedInMessage("mail bob@scout.com", members)).toEqual([]);
    expect(mentionedInMessage("<bob@scout.com>", members)).toEqual([]);
  });

  it("reads an escaped \\@Name as Markdown does: the text @Name, so it wakes that Bot", () => {
    expect(mentionedInMessage("\\@Scout look", members)).toEqual(["b1"]);
  });
});
