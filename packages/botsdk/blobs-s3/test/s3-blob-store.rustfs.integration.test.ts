import { describe } from "vitest";

import { s3BlobStore } from "../src";
import { blobStoreContract } from "@ai-chat/test-support/blob.contract";

// The same contract against a real S3-compatible store (RustFS in CI and `docker compose`). The
// suite is skipped without TEST_S3_ENDPOINT, except in CI, where it fails; the bucket must exist
// (the store never creates it).
const endpoint = process.env.TEST_S3_ENDPOINT ?? "";

if (!endpoint && process.env.CI) throw new Error("TEST_S3_ENDPOINT must be set in CI");

describe.skipIf(!endpoint)("s3BlobStore against RustFS", () => {
  blobStoreContract("s3 (RustFS)", () =>
    s3BlobStore({
      endpoint,
      bucket: process.env.TEST_S3_BUCKET ?? "",
      region: process.env.TEST_S3_REGION ?? "us-east-1",
      accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "",
    }),
  );
});
