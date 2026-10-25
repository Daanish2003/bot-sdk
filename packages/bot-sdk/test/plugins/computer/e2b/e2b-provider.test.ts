import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { e2bProvider } from "../../../../plugins/computer/e2b";
import { keptEndCharacters } from "../../../../plugins/computer/e2b/bounded-output";
import { SandboxGoneError } from "../../../../plugins/computer/server/internal";

const sdkRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (name === "node_modules") return [];
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe("the E2B adapter's subpath", () => {
  it("is the only SDK module that imports e2b", () => {
    const importers = [
      ...sourceFiles(join(sdkRoot, "core")),
      ...sourceFiles(join(sdkRoot, "plugins")),
    ]
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) => /from\s+["']e2b["']/.test(readFileSync(file, "utf8")))
      .map((file) => relative(sdkRoot, file).replaceAll("\\", "/"));
    expect(importers).toEqual(["plugins/computer/e2b/index.ts"]);
  });
});

// Against a real self-hosted E2B: set the three variables (SDK README) and build the template.
const apiKey = process.env.E2B_API_KEY;
const apiUrl = process.env.E2B_API_URL;
const sandboxUrl = process.env.E2B_SANDBOX_URL;

describe.skipIf(!apiKey || !apiUrl || !sandboxUrl)("e2bProvider on a real E2B", () => {
  const provider = e2bProvider({
    apiKey: apiKey!,
    apiUrl: apiUrl!,
    sandboxUrl: sandboxUrl!,
    template: "ai-chat-computer-v3",
  });
  // One sandbox at a time, killed when its test ends: the local E2B Embed has room for a few.
  const created: string[] = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map((id) => provider.kill(id)));
  });
  const text = (bytes: Uint8Array | null) => new TextDecoder().decode(bytes ?? new Uint8Array());

  it("runs commands and files, then pauses and resumes with the file and process intact", async () => {
    const { sandboxId } = await provider.create({ timeoutMs: 60_000 });
    created.push(sandboxId);

    expect(await provider.run(sandboxId, "echo hi; echo oops >&2", { timeoutMs: 20_000 })).toEqual({
      exitCode: 0,
      stdout: "hi\n",
      stderr: "oops\n",
    });
    expect(await provider.run(sandboxId, "exit 3", { timeoutMs: 20_000 })).toMatchObject({
      exitCode: 3,
    });
    expect(
      await provider.run(sandboxId, "pwd", { cwd: "/home/user/bots/a", timeoutMs: 20_000 }),
    ).toMatchObject({ exitCode: 0, stdout: "/home/user/bots/a\n" });

    await provider.writeFile(sandboxId, "/home/user/notes/a.txt", "hello");
    await provider.writeFile(sandboxId, "/home/user/notes/b.bin", new Uint8Array([1, 2, 3]));
    expect(text(await provider.readFile(sandboxId, "/home/user/notes/a.txt"))).toBe("hello");
    expect([...(await provider.readFile(sandboxId, "/home/user/notes/b.bin"))!]).toEqual([1, 2, 3]);
    expect(await provider.readFile(sandboxId, "/home/user/notes/none")).toBeNull();
    expect(await provider.list(sandboxId, "/home/user/notes")).toEqual(
      expect.arrayContaining([
        { name: "a.txt", kind: "file", size: 5 },
        { name: "b.bin", kind: "file", size: 3 },
      ]),
    );
    expect(await provider.list(sandboxId, "/home/user/nowhere")).toBeNull();

    await provider.run(
      sandboxId,
      "nohup sh -c 'while true; do date +%s >> /home/user/tick; sleep 1; done' >/dev/null 2>&1 &",
      { timeoutMs: 20_000 },
    );
    await provider.pause(sandboxId);
    await provider.pause(sandboxId);
    expect(await provider.resume(sandboxId, { timeoutMs: 60_000 })).toBe("resumed");
    expect(text(await provider.readFile(sandboxId, "/home/user/notes/a.txt"))).toBe("hello");
    const before = await provider.run(sandboxId, "wc -l < /home/user/tick", { timeoutMs: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const after = await provider.run(sandboxId, "wc -l < /home/user/tick", { timeoutMs: 20_000 });
    expect(Number((after as { stdout: string }).stdout)).toBeGreaterThan(
      Number((before as { stdout: string }).stdout),
    );
    await provider.setTimeout(sandboxId, 120_000);

    await provider.kill(sandboxId);
    await provider.kill(sandboxId);
    expect(await provider.resume(sandboxId, { timeoutMs: 60_000 })).toBe("gone");
    await expect(provider.run(sandboxId, "true", { timeoutMs: 20_000 })).rejects.toBeInstanceOf(
      SandboxGoneError,
    );
    await expect(provider.pause(sandboxId)).rejects.toBeInstanceOf(SandboxGoneError);
    await expect(provider.setTimeout(sandboxId, 60_000)).rejects.toBeInstanceOf(SandboxGoneError);
  }, 120_000);

  it("keeps only the ends of an output too long to hold", async () => {
    const { sandboxId } = await provider.create({ timeoutMs: 60_000 });
    created.push(sandboxId);
    const result = await provider.run(sandboxId, "echo first; yes | head -c 8000000; echo last", {
      timeoutMs: 30_000,
    });
    expect(result.stdout.startsWith("first\ny\n")).toBe(true);
    expect(result.stdout.endsWith("y\nlast\n")).toBe(true);
    expect(result.stdout).toContain("characters left out by the computer");
    expect(result.stdout.length).toBeLessThan(2 * keptEndCharacters + 100);
  }, 60_000);

  it("kills a command at its time limit and keeps what it printed", async () => {
    const { sandboxId } = await provider.create({ timeoutMs: 60_000 });
    created.push(sandboxId);
    const result = await provider.run(sandboxId, "echo started; sleep 30", { timeoutMs: 1500 });
    expect(result).toEqual({ timedOut: true, stdout: "started\n", stderr: "" });
    // The killed command is gone: the next one is not queued behind it.
    expect(
      await provider.run(sandboxId, "pgrep -c sleep || true", { timeoutMs: 20_000 }),
    ).toMatchObject({
      stdout: "0\n",
    });
  }, 60_000);

  it("kills a command once its signal aborts, and throws the reason", async () => {
    const { sandboxId } = await provider.create({ timeoutMs: 60_000 });
    created.push(sandboxId);
    const controller = new AbortController();
    const running = provider.run(sandboxId, "sleep 30", {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("stopped")), 1000);
    await expect(running).rejects.toThrow("stopped");
    expect(
      await provider.run(sandboxId, "pgrep -c sleep || true", { timeoutMs: 20_000 }),
    ).toMatchObject({
      stdout: "0\n",
    });
  }, 60_000);

  it("kills the whole process group of a command, background children included", async () => {
    const { sandboxId } = await provider.create({ timeoutMs: 60_000 });
    created.push(sandboxId);
    const left = () => provider.run(sandboxId, "pgrep -c sleep || true", { timeoutMs: 20_000 });
    const timedOut = await provider.run(sandboxId, "sleep 300 & wait", { timeoutMs: 1500 });
    expect(timedOut).toMatchObject({ timedOut: true });
    expect(await left()).toMatchObject({ stdout: "0\n" });

    const controller = new AbortController();
    const running = provider.run(sandboxId, "sleep 300 & wait", {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("stopped")), 1000);
    await expect(running).rejects.toThrow("stopped");
    expect(await left()).toMatchObject({ stdout: "0\n" });
  }, 60_000);

  it("reports a sandbox killed behind its back as gone, though it is connected", async () => {
    const { sandboxId } = await provider.create({ timeoutMs: 60_000 });
    created.push(sandboxId);
    await provider.writeFile(sandboxId, "/home/user/a.txt", "a");
    // Another adapter instance kills it, so this one still holds the connection it cached.
    await e2bProvider({
      apiKey: apiKey!,
      apiUrl: apiUrl!,
      sandboxUrl: sandboxUrl!,
      template: "ai-chat-computer-v3",
    }).kill(sandboxId);
    await expect(provider.readFile(sandboxId, "/home/user/a.txt")).rejects.toBeInstanceOf(
      SandboxGoneError,
    );
    await expect(provider.run(sandboxId, "true", { timeoutMs: 20_000 })).rejects.toBeInstanceOf(
      SandboxGoneError,
    );
  }, 60_000);
});
