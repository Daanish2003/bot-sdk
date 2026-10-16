import type { BlobStore } from "@ai-chat/bot-sdk/core/server";
import { s3BlobStore } from "@ai-chat/bot-sdk/core/server";

/**
 * The file store `apps/web` offers, from its `S3_*` variables (`.env.schema`). Set all five or none:
 * with none, `createBotSdk` keeps file bytes in Postgres.
 */
const variables = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

type S3Env = Partial<Record<(typeof variables)[number], string | undefined>>;

export function blobStoreOf(env: S3Env): BlobStore | undefined {
  const missing = variables.filter((name) => !env[name]?.trim());
  if (missing.length === variables.length) return undefined;
  if (missing.length > 0) {
    throw new Error(
      `An S3 file store needs ${variables.join(", ")}; missing ${missing.join(", ")}`,
    );
  }
  return s3BlobStore({
    endpoint: env.S3_ENDPOINT ?? "",
    bucket: env.S3_BUCKET ?? "",
    region: env.S3_REGION ?? "",
    accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
  });
}
