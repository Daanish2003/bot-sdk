import type { ModelMessage } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { knowledgeChangesOf } from "../../src/server/turn-changes";

const call = (id: string, name: string): ModelMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, type: "function", function: { name, arguments: "{}" } }],
});
const result = (id: string, body: object): ModelMessage => ({
  role: "tool",
  toolCallId: id,
  content: JSON.stringify(body),
});

describe("knowledgeChangesOf", () => {
  it("lists the files a Turn's write and edit saved under shared/knowledge, once each, with the Bot", () => {
    const transcript = [
      call("a", "write"),
      result("a", { path: "/home/user/shared/knowledge/reports/q3.md", created: true }),
      call("b", "edit"),
      result("b", { path: "/home/user/shared/knowledge/reports/q3.md" }),
      call("g", "edit"),
      result("g", { path: "/home/user/shared/knowledge/old.md" }),
      call("c", "write"),
      result("c", { path: "/home/user/shared/knowledge/handbook.md", created: true }),
    ];
    expect(knowledgeChangesOf("ada", transcript)).toEqual([
      { botId: "ada", path: "reports/q3.md" },
      { botId: "ada", path: "old.md" },
      { botId: "ada", path: "handbook.md" },
    ]);
  });

  it("records nothing for writes elsewhere, failed writes, or other tools", () => {
    const transcript = [
      call("a", "write"),
      result("a", { path: "/home/user/bots/ada/notes.md", created: true }),
      call("b", "write"),
      result("b", { path: "/home/user/bots/ada/skills/x/SKILL.md", created: true }),
      call("c", "write"),
      result("c", { path: "/home/user/shared/memory/profile.md" }),
      call("d", "write"),
      result("d", { path: "/home/user/shared/knowledge/x.md", error: "denied" }),
      call("e", "read"),
      result("e", { path: "/home/user/shared/knowledge/x.md" }),
      call("f", "write"),
      result("f", { path: "/home/user/shared/knowledge-old/x.md" }),
    ];
    expect(knowledgeChangesOf("ada", transcript)).toBeNull();
  });
});
