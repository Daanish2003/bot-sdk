import { posix } from "node:path";

/** The directory the user's Bots share on their Computer. */
export const sharedDirectory = "/home/user/shared";

/** A Bot's own directory on its user's Computer, where its relative paths and commands start. */
export function botDirectory(botId: string): string {
  return `/home/user/bots/${botId}`;
}

/**
 * Resolves a tool's path, or a `shell` call's cwd: relative to the Bot's directory, or absolute
 * anywhere. With none, it is the Bot's directory itself.
 */
export function resolvePath(botId: string, path: string | undefined): string {
  return posix.resolve(botDirectory(botId), path ?? ".");
}
