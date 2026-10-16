/**
 * A stand-in for an S3 endpoint, served through a fake `fetch`: path-style PUT, GET and DELETE on
 * one bucket, in memory. It rejects requests that aren't SigV4-signed for the expected key and
 * region, so the store's signing is exercised too. Real RustFS runs in its own suite.
 */
export type FakeS3 = {
  fetch: typeof fetch;
  /** The objects the fake holds, by key, with their content types. */
  objects: Map<string, { bytes: Uint8Array<ArrayBuffer>; contentType: string }>;
};

export function fakeS3({
  bucket,
  region,
  accessKeyId,
}: {
  bucket: string;
  region: string;
  accessKeyId: string;
}): FakeS3 {
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; contentType: string }>();
  const signedPrefix = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/`;
  const signedSuffix = `/${region}/s3/aws4_request`;

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith(signedPrefix) || !authorization.includes(signedSuffix)) {
      return new Response("unsigned", { status: 403 });
    }
    const [, requestBucket, ...rest] = url.pathname.split("/");
    if (requestBucket !== bucket) return new Response("no such bucket", { status: 404 });
    const key = decodeURIComponent(rest.join("/"));

    if (request.method === "PUT") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      objects.set(key, {
        bytes,
        contentType: request.headers.get("content-type") ?? "application/octet-stream",
      });
      return new Response(null, { status: 200 });
    }
    if (request.method === "GET") {
      const object = objects.get(key);
      if (!object) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      return new Response(object.bytes, {
        status: 200,
        headers: { "content-type": object.contentType },
      });
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response("method not allowed", { status: 405 });
  };

  return { fetch: fakeFetch as typeof fetch, objects };
}
