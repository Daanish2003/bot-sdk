import { posix } from "node:path";

import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import type { BotSdkContext } from "../../../core/server/plugin";
import type { ComputerHandle } from "../../computer/server/plugin";

/** The Computer tool that runs a shell command. */
export const shellToolName = "shell";

/** The user's Computer. Call it only with `computer` on (`hasPlugin("computer")`). */
export function computerOf(deps: BotSdkContext, userId: string): ComputerHandle {
  return deps.plugin("computer").forUser(userId);
}

/** The directory the user's Bots share on their Computer. */
export const sharedDirectory = "/home/user/shared";

/** A Bot's own directory on its user's Computer, where its relative paths and commands start. */
export function botDirectory(botId: string): string {
  return `/home/user/bots/${botId}`;
}

/** Where a `shell` call runs: `cwd` against the Bot's directory, or that directory itself. */
export function shellCwd(botId: string, cwd: string | undefined): string {
  return posix.resolve(botDirectory(botId), cwd ?? ".");
}

/** What the system prompt says about the Computer, with the Bot's own directory in it. */
export function computerPrompt(botId: string): string {
  return (
    "You have a computer: a Linux machine you share with the user's other Bots. Run commands on " +
    `it with the ${shellToolName} tool. Your own directory is ${botDirectory(botId)}: commands run ` +
    "there unless you give another cwd, so keep your files there. The user's Bots share " +
    `${sharedDirectory}, to hand files to each other. Keep to your own directory and the shared ` +
    "one, and don't change other Bots' files. The user never sees the computer: tell them what " +
    "you did through your messages."
  );
}

export const shellDefinition = toolDefinition({
  name: shellToolName,
  description:
    "Run a shell command on your computer with bash, and get its exit code, stdout and stderr. A " +
    "non-zero exit code is a normal result. It runs in your own directory unless you give a cwd.",
  inputSchema: z.object({
    command: z.string().meta({ description: "The command line, run with bash -l -c." }),
    cwd: z.string().optional().meta({
      description: "Where to run it: absolute, or relative to your own directory.",
    }),
  }),
});
