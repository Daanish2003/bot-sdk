import { execFileSync } from "node:child_process";

/**
 * `E2E_DATABASE_URL`, else `ai-chat_e2e` on the server of the app's `DATABASE_URL`. That one is
 * read in a child process: loading Varlock in the calling process would hand its resolved `.env`
 * (and its `NODE_ENV`) on to the server.
 */
export function e2eDatabaseUrl() {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  const appUrl = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "await import('varlock/auto-load'); process.stdout.write(process.env.DATABASE_URL ?? '')",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (!appUrl) throw new Error("Set DATABASE_URL or E2E_DATABASE_URL");
  const url = new URL(appUrl);
  url.pathname = "/ai-chat_e2e";
  return url.toString();
}
