import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseReply, parseWholeReply } from "../../src/lib/parse-reply";

const schema = z.object({ ops: z.array(z.string()) });
const json = '{"ops": ["a"]}';

describe("parseReply", () => {
  it.each([
    ["alone", json],
    ["with whitespace around it", `\n ${json} \n`],
    ["in a fence", `\`\`\`\n${json}\n\`\`\``],
    ["in a json fence", `\`\`\`json\n${json}\n\`\`\``],
  ])("reads JSON %s", (_shape, reply) => {
    expect(parseReply(schema, reply)).toEqual({ ops: ["a"] });
  });

  it.each([
    ["on the next line", `${json}\nI saved that.`],
    ["on the same line", `${json} I saved that.`],
    ["after a blank line", `${json}\n\nNote: nothing else to add.`],
    ["holding braces", `${json}\n{not json} and ]`],
    ["after a closing fence with no opening one", `${json}\n\`\`\`\nDone.`],
    ["after a fence", `\`\`\`\n${json}\n\`\`\`\nI saved that.`],
    ["after a json fence", `\`\`\`json\n${json}\n\`\`\`\n\nI saved that.`],
    ["ending in its own fence", `\`\`\`json\n${json}\n\`\`\`\nFor example:\n\`\`\`\nx\n\`\`\``],
  ])("ignores text %s", (_shape, reply) => {
    expect(parseReply(schema, reply)).toEqual({ ops: ["a"] });
  });

  it.each([
    ["a closing brace", '{"ops": ["a}b"]}'],
    ["an opening brace", '{"ops": ["{"]}'],
    ["a closing bracket", '{"ops": ["]"]}'],
    ["an escaped quote then a brace", '{"ops": ["\\"}"]}'],
    ["an escaped backslash at its end", '{"ops": ["\\\\"]}'],
  ])("doesn't end the value at %s in a string", (_shape, value) => {
    const whole = JSON.parse(value) as unknown;
    expect(parseReply(schema, `${value}\nDone {really}.`)).toEqual(whole);
    expect(parseReply(schema, `\`\`\`json\n${value}\n\`\`\`\nDone.`)).toEqual(whole);
  });

  it("reads an array and its nesting to the end of the value", () => {
    expect(parseReply(z.array(z.array(z.number())), "[[1], [2]]\nDone.")).toEqual([[1], [2]]);
    expect(parseReply(z.object({ a: z.object({ b: z.number() }) }), '{"a":{"b":1}} ok')).toEqual({
      a: { b: 1 },
    });
  });

  it("still reads a reply that is only a string, number or literal", () => {
    expect(parseReply(z.string(), '"a}b"')).toBe("a}b");
    expect(parseReply(z.number(), "12")).toBe(12);
    expect(parseReply(z.null(), "null")).toBe(null);
  });

  it.each([
    ["only prose", "Sure! I'll remember that."],
    ["nothing", ""],
    ["a value cut off", '{"ops": ["a"'],
    ["a string cut off", '{"ops": ["a'],
    ["brackets that don't match", '{"ops": ["a"}]'],
    ["a closing bracket first", '} {"ops": []}'],
    ["text before the JSON", `Here you go: ${json}`],
    ["text before a fence", `Here you go:\n\`\`\`json\n${json}\n\`\`\``],
  ])("throws on %s", (_shape, reply) => {
    expect(() => parseReply(schema, reply)).toThrow(SyntaxError);
  });

  it("validates the first value with the schema, whatever follows it", () => {
    expect(() => parseReply(schema, `{"ops": 1}\n${json}`)).toThrow(z.ZodError);
  });
});

describe("parseWholeReply", () => {
  it("reads JSON alone or in a fence", () => {
    expect(parseWholeReply(schema, ` ${json} `)).toEqual({ ops: ["a"] });
    expect(parseWholeReply(schema, `\`\`\`json\n${json}\n\`\`\``)).toEqual({ ops: ["a"] });
  });

  it.each([
    ["text", `${json}\nI saved that.`],
    ["text after a fence", `\`\`\`json\n${json}\n\`\`\`\nI saved that.`],
    ["a second value", `${json}\n${json}`],
  ])("throws on JSON followed by %s", (_shape, reply) => {
    expect(() => parseWholeReply(schema, reply)).toThrow(SyntaxError);
  });
});
