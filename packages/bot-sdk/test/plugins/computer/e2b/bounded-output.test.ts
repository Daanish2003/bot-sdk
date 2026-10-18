import { describe, expect, it } from "vitest";

import { capOutput, spillThreshold } from "../../../../plugins/bot/server/computer-tools";
import { boundedOutput, keptEndCharacters } from "../../../../plugins/computer/e2b/bounded-output";

describe("boundedOutput", () => {
  it("keeps a short output whole, however it arrives", () => {
    const output = boundedOutput();
    for (const chunk of ["hel", "lo\n", "", "world\n"]) output.add(chunk);

    expect(output.text()).toBe("hello\nworld\n");
  });

  it("keeps an output of exactly both ends whole", () => {
    const output = boundedOutput();
    const whole = "a".repeat(keptEndCharacters) + "b".repeat(keptEndCharacters);
    output.add(whole);

    expect(output.text()).toBe(whole);
  });

  it("keeps the ends of an endless output and says how much it left out, in bounded memory", () => {
    const output = boundedOutput();
    const chunk = "y\n".repeat(32 * 1024);
    let printed = 0;
    output.add("first line\n");
    printed += 11;
    for (let index = 0; index < 200; index += 1) {
      output.add(chunk);
      printed += chunk.length;
      expect(output.held()).toBeLessThanOrEqual(3 * keptEndCharacters);
    }
    output.add("last line\n");
    printed += 10;

    const text = output.text();
    const left = printed - 2 * keptEndCharacters;
    expect(text.startsWith("first line\ny\n")).toBe(true);
    expect(text.endsWith("y\nlast line\n")).toBe(true);
    expect(text).toContain(`[... ${left} characters left out by the computer ...]`);
    expect(text.length).toBeLessThan(2 * keptEndCharacters + 100);
  });

  it("never splits a character outside the Basic Multilingual Plane at either cut", () => {
    const output = boundedOutput();
    // Each emoji is two UTF-16 code units, so an odd prefix puts a pair across every boundary.
    output.add("a" + "😀".repeat(2 * keptEndCharacters));

    const text = output.text();
    expect(text).toBe(new TextDecoder().decode(new TextEncoder().encode(text)));
    expect(text.endsWith("😀")).toBe(true);
  });

  it("still spills to a file in shell, with the real first and last characters in the result", async () => {
    const output = boundedOutput();
    output.add("start ");
    output.add("x".repeat(3 * keptEndCharacters));
    output.add(" end");
    let saved = "";

    const capped = await capOutput(
      { exitCode: 0, stdout: output.text(), stderr: "" },
      "/home/user/bots/b1/.outputs/call.txt",
      async (_path, content) => {
        saved = content;
      },
    );

    expect(saved.length).toBeGreaterThan(spillThreshold);
    expect(saved).toBe(output.text());
    expect(capped.outputPath).toBe("/home/user/bots/b1/.outputs/call.txt");
    expect(capped.stdout.startsWith("start x")).toBe(true);
    expect(capped.stdout.endsWith("x end")).toBe(true);
  });
});
