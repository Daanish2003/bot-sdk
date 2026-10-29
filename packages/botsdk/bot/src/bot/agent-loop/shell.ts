import { isReservedSecretName, reservedSecretNameMessage } from "@botsdk/client/bot/secret";
import type { z } from "zod";

import type { BotSdkContext } from "../../plugin";
import { uuidv7 } from "../../lib/uuidv7";
import type { ComputerHandle } from "../../computer/internal";
import {
  capOutput,
  defaultShellTimeoutSeconds,
  type FileToolOptions,
  type shellDefinition,
  spillPath,
  timedOutHint,
} from "./computer-tools";
import { resolvePath } from "../conversation";
import {
  type DecryptedSecrets,
  loadSecretValues,
  maskedFormsOf,
  secretMasker,
  unknownSecretError,
} from "../safety";

/** A `shell` call's input, as the Model gives it. */
export type ShellInput = z.infer<NonNullable<(typeof shellDefinition)["inputSchema"]>>;

/**
 * Runs one `shell` call of Bot `botId` (tool call `toolCallId`) on the user's Computer, which
 * `onComputer` lends with its live options: a Turn's (or a Helper's) loop, or the approved-call
 * job (ADR 0030). The command gets only the Secrets it names; its output is masked of all of
 * them, then cut, with the rest saved on the Computer. An unknown or reserved Secret name is the
 * result, and the command never runs.
 */
export async function runShell(
  deps: BotSdkContext,
  { userId, botId, toolCallId }: { userId: string; botId: string; toolCallId: string | undefined },
  { command, cwd, timeoutSeconds, secrets }: ShellInput,
  decrypted: DecryptedSecrets,
  onComputer: <T extends object>(
    operate: (computer: ComputerHandle, live: FileToolOptions) => Promise<T>,
  ) => Promise<T | { error: string }>,
) {
  // The user's Secrets, read for this one command: it gets only the ones it names, and the
  // result is masked of all of them.
  const values = await loadSecretValues(deps, userId, decrypted);
  const unknown = (secrets ?? []).filter((name) => !values.has(name));
  if (unknown.length > 0) return { error: unknownSecretError(unknown, values.keys()) };
  // Defence in depth: a reserved name can't be saved, but one that was would not be set.
  const reserved = (secrets ?? []).filter(isReservedSecretName);
  if (reserved.length > 0) return { error: reservedSecretNameMessage(reserved.join(", ")) };
  const secretValues = [...values.values()];
  const mask = secretMasker(secretValues);
  const envs = Object.fromEntries((secrets ?? []).map((name) => [name, values.get(name)!]));
  return onComputer(async (computer, live) => {
    const output = await computer.run(command, {
      ...live,
      cwd: resolvePath(botId, cwd),
      timeoutMs: (timeoutSeconds ?? defaultShellTimeoutSeconds) * 1000,
      ...(secrets?.length && { envs }),
      ...(secretValues.length > 0 && { redact: maskedFormsOf(secretValues) }),
    });
    // Masked before the output is cut down to its ends, so a value is never half kept by the cut.
    const result = {
      ...output,
      stdout: mask(output.stdout),
      stderr: mask(output.stderr),
    };
    // The cap is applied here, so the Checkpoint holds only the truncated form.
    const capped = await capOutput(
      result,
      spillPath(botId, toolCallId ?? uuidv7()),
      computer.writeFile,
    );
    return "timedOut" in capped ? { ...capped, hint: timedOutHint } : capped;
  });
}
