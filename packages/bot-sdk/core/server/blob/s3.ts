import { AwsClient } from "aws4fetch";

import type { BlobStore } from "./store";

export type S3BlobStoreOptions = {
  /** The store's origin, such as `https://<account>.r2.cloudflarestorage.com` or `http://127.0.0.1:9000`. */
  endpoint: string;
  /** An existing bucket. The store never creates it. */
  bucket: string;
  /** The signing region: `auto` for R2, any name RustFS was started with. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Puts the bucket in the path (`<endpoint>/<bucket>/<key>`, the default) rather than the host. */
  forcePathStyle?: boolean;
};

/**
 * A `BlobStore` on any S3-compatible object store, such as Cloudflare R2 or RustFS (ADR 0015).
 * Each call is one signed PUT, GET or DELETE; `delete` loops over the keys. A missing object is a
 * `get` of `null` and a no-op delete.
 */
export function s3BlobStore(options: S3BlobStoreOptions): BlobStore {
  const { endpoint, bucket, region, accessKeyId, secretAccessKey } = options;
  const forcePathStyle = options.forcePathStyle ?? true;
  const origin = new URL(endpoint);
  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    region,
    service: "s3",
    retries: 3,
  });

  const objectUrl = (key: string) => {
    const path = key.split("/").map(encodeURIComponent).join("/");
    const url = new URL(origin.toString());
    if (forcePathStyle) {
      url.pathname = `/${encodeURIComponent(bucket)}/${path}`;
    } else {
      url.hostname = `${bucket}.${origin.hostname}`;
      url.pathname = `/${path}`;
    }
    return url.toString();
  };

  return {
    async put(key, bytes, { contentType }) {
      const response = await client.fetch(objectUrl(key), {
        method: "PUT",
        body: bytes as Uint8Array<ArrayBuffer>,
        headers: { "Content-Type": contentType },
      });
      await assertOk(response, "PUT", key);
    },
    async get(key) {
      const response = await client.fetch(objectUrl(key), { method: "GET" });
      // A missing key is a 404 whose code is NoSuchKey; any other 404 (a wrong bucket) is an error.
      if (response.status === 404 && (await response.clone().text()).includes("NoSuchKey")) {
        return null;
      }
      await assertOk(response, "GET", key);
      return new Uint8Array(await response.arrayBuffer());
    },
    async delete(keys) {
      for (const key of keys) {
        const response = await client.fetch(objectUrl(key), { method: "DELETE" });
        await assertOk(response, "DELETE", key);
      }
    },
  };
}

async function assertOk(response: Response, action: string, key: string) {
  if (response.ok) return;
  const detail = await response.text().catch(() => "");
  throw new Error(`S3 ${action} of ${key} failed with ${response.status}: ${detail.slice(0, 200)}`);
}
