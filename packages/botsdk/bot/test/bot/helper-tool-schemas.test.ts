import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { BrowserSession, browserTools, askUserTool } from "../../src/bot/helpers";

/** The keywords a JSON Schema draft 2020-12 validator (Anthropic's) rejects from earlier drafts. */
const draft7Only = ["additionalItems"];

/** Every place the schema uses a pre-2020-12 form: `items` as an array, or `additionalItems`. */
function oldForms(schema: unknown, path = "$"): string[] {
  if (Array.isArray(schema)) return schema.flatMap((item, i) => oldForms(item, `${path}[${i}]`));
  if (typeof schema !== "object" || schema === null) return [];
  return Object.entries(schema).flatMap(([key, value]) => {
    const here = `${path}.${key}`;
    const own = (key === "items" && Array.isArray(value)) || draft7Only.includes(key) ? [here] : [];
    return [...own, ...oldForms(value, here)];
  });
}

describe("the Computer-use Helper's tool schemas", () => {
  it("are JSON Schema draft 2020-12, as Anthropic's API requires", () => {
    const stub = (async () => ({})) as never;
    const tools = [
      ...browserTools(new BrowserSession(1, "bot") as never, "bot", stub),
      askUserTool(() => "reason"),
    ];
    expect(tools.length).toBeGreaterThan(5);
    for (const tool of tools) {
      expect(oldForms(convertSchemaToJsonSchema(tool.inputSchema!)), tool.name).toEqual([]);
    }
  });
});
