import type {
  CommandResult,
  ComputerProvider,
  FileEntry,
} from "../../../../plugins/computer/server/provider";

/** One command the fake ran: where, and on which sandbox. */
export type FakeCommand = { sandboxId: string; command: string; cwd: string | undefined };

type Lifecycle = "create" | "resume";

/** What the fake was asked to do, in order. */
export type FakeCall =
  | { [Type in Lifecycle]: { type: Type; sandboxId: string } }[Lifecycle]
  | ({ type: "run" } & FakeCommand);

/**
 * A Computer provider for tests: no sandbox, only a record of what it was asked to do. Each
 * command is answered by `onCommand`, which the test supplies (exit 0 with no output by default).
 */
export function fakeComputerProvider({
  template = "fake-computer-v1",
  onCommand = () => ({ exitCode: 0, stdout: "", stderr: "" }),
}: {
  template?: string;
  onCommand?: (command: FakeCommand) => CommandResult | Promise<CommandResult>;
} = {}) {
  const calls: FakeCall[] = [];
  /** The files of the fake Computer, by absolute path. */
  const files = new Map<string, Uint8Array>();
  let created = 0;
  const provider: ComputerProvider = {
    template,
    create: async () => {
      // A sandbox takes a moment to start, so operations that race a wake overlap it.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const sandboxId = `fake-sandbox-${++created}`;
      calls.push({ type: "create", sandboxId });
      return { sandboxId };
    },
    resume: async (sandboxId) => {
      calls.push({ type: "resume", sandboxId });
    },
    run: async (sandboxId, command, { cwd }) => {
      calls.push({ type: "run", sandboxId, command, cwd });
      return onCommand({ sandboxId, command, cwd });
    },
    readFile: async (_sandboxId, path) => files.get(path) ?? null,
    writeFile: async (_sandboxId, path, content) => {
      files.set(path, new TextEncoder().encode(content));
    },
    list: async (_sandboxId, path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = new Map<string, FileEntry>();
      for (const [file, bytes] of files) {
        if (!file.startsWith(prefix)) continue;
        const [name, ...rest] = file.slice(prefix.length).split("/");
        if (!name) continue;
        entries.set(
          name,
          rest.length > 0
            ? { name, kind: "directory", size: 0 }
            : { name, kind: "file", size: bytes.length },
        );
      }
      return entries.size > 0 ? [...entries.values()] : null;
    },
  };
  /** The calls of one type. */
  const callsOf = <Type extends FakeCall["type"]>(type: Type) =>
    calls.filter((call): call is Extract<FakeCall, { type: Type }> => call.type === type);
  return { provider, calls, callsOf, files };
}
