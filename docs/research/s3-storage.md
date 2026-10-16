# Research: S3-compatible storage (clients, Cloudflare R2, RustFS)

Ticket: [#175 S3-compatible storage: clients, R2 and RustFS](https://github.com/Daanish2003/ai-chat/issues/175) (child of map [#166](https://github.com/Daanish2003/ai-chat/issues/166), blocking [#170](https://github.com/Daanish2003/ai-chat/issues/170)).
Researched: 2026-10-12. Versions, prices and counts were read that day.

## Question

What should the Chat SDK (`packages/chat-sdk`, copied and stack-agnostic, ADR 0005) use to talk to S3-compatible storage, and which store backs it in dev, CI and production? This note covers three things: the client libraries, RustFS as a `docker compose` store, and Cloudflare R2.

This note gives facts and implications only. The choice belongs to #170 and the owner: new dependencies and infrastructure are human decisions (AGENTS.md §6).

## Summary

- **Clients.** `@aws-sdk/client-s3` is complete: multipart through `@aws-sdk/lib-storage`, presigning through `@aws-sdk/s3-request-presigner`, and streams. It is also about 8–9 MB unpacked across roughly 26–40 packages. Against non-AWS stores, its default CRC32 checksums are a known source of failures, and `requestChecksumCalculation: "WHEN_REQUIRED"` is the usual opt-out. `aws4fetch` is a single 65 KB MIT package with no dependencies. It is only a SigV4 signer around `fetch`: presigned URLs come from `signQuery`, and you build multipart and XML parsing yourself. Its last release was in August 2024. `s3mini` sits in between: no dependencies, Node, Bun and Workers support, multipart and presigning built in, but a small user base.
- **RustFS** went **GA at 1.0.0 on 2026-09-16** (1.0.1 on 2026-10-03), after alpha from July 2025, beta from April 2026 and RCs from August 2026. It is **Apache-2.0**. Its own test lists cover presigned GET/PUT, multipart and bucket CORS. It documents its gaps (no ACLs, POST-object checksums, bucket logging, ownership controls). The official image `rustfs/rustfs` runs single-node with no arguments. That fits a compose service and a GitHub Actions service container in place of MinIO. For production it is young: 35 security advisories were published between 2025-12-30 and 2026-09-08 (4 critical, 14 high), one of them about presigned uploads.
- **R2.** Egress is free. Storage costs $0.015/GB-month. The free tier is 10 GB-month, 1M Class A and 10M Class B operations. Presigned URLs allow GET/HEAD/PUT/DELETE, but **not POST form uploads**, last 1 s to 7 days, and work only on the S3 API domain, **not on custom domains**. Bucket CORS is needed for browser uploads. Public buckets run through a custom domain on a Cloudflare zone, with caching and WAF. `r2.dev` URLs are rate-limited and meant for development only.

## 1. Clients

|                   | `@aws-sdk/client-s3` (+ presigner, lib-storage)                                                                                                                                                       | `aws4fetch`                                                                                                                                                                                                                                                                                          | `s3mini`                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Latest version    | 3.1149.0, 2026-10-09 [npm1]                                                                                                                                                                           | 1.0.20, **2024-08-28** [npm2]                                                                                                                                                                                                                                                                        | 1.0.2, 2026-09-15 [npm3]                            |
| Licence           | Apache-2.0                                                                                                                                                                                            | MIT                                                                                                                                                                                                                                                                                                  | MIT                                                 |
| Size              | client-s3 alone is 3.3 MB unpacked. With its dependency tree, about **8.4 MB in 26 packages**, or **9.4 MB in 40 packages** with presigner and lib-storage (my registry walk, approximate)            | 65 KB unpacked, 0 deps. "6.4kb minified, 2.5kb gzipped" [a4f]                                                                                                                                                                                                                                        | 282 KB unpacked, 0 deps; "~20 KB minified" [s3m]    |
| ESM               | Yes (`module: ./dist-es/index.js`), plus CJS                                                                                                                                                          | Yes (`dist/aws4fetch.esm.js`) and CJS                                                                                                                                                                                                                                                                | ESM-only (`type: module`)                           |
| Runtimes          | Node `>=20`, browser builds, React Native [awsjs]. Workers is not stated in the SDK README, and I didn't verify it                                                                                    | Anything with `fetch` and `SubtleCrypto`: browsers and Workers [a4f]. Node 18+ has both globals                                                                                                                                                                                                      | Node, Bun, Workers; "No Browser support!" [s3m]     |
| Multipart         | Raw commands (`CreateMultipartUpload`, `UploadPart`...). `lib-storage` `Upload` handles buffers, blobs and streams of unknown length, with concurrency, `partSize` ≥ 5 MB, and abort on error [libst] | DIY: you sign each REST call and parse the XML responses yourself                                                                                                                                                                                                                                    | Built in [s3m]                                      |
| Presigned GET/PUT | `getSignedUrl(client, command, { expiresIn })` [r2aws]                                                                                                                                                | `aws.sign(url, { aws: { signQuery: true } })`. `X-Amz-Expires` defaults to 86400 s (source, `src/main.js`) [r2a4f]                                                                                                                                                                                   | Built in [s3m]                                      |
| Streaming         | Request bodies can be streams. `GetObject` returns a stream with helper methods [awsjs]                                                                                                               | Bodies are passed to `fetch` with `duplex: 'half'`, so a `ReadableStream` body works. S3 requests default to `X-Amz-Content-Sha256: UNSIGNED-PAYLOAD`. Its retry loop (10 retries by default on 5xx/429) re-sends the same body, so a one-shot stream can't be retried (my reading of `src/main.js`) | Not checked                                         |
| Popularity        | 50.0M downloads/week                                                                                                                                                                                  | 9.6M/week                                                                                                                                                                                                                                                                                            | 43k/week                                            |
| Upkeep            | Released several times a week                                                                                                                                                                         | Repo last pushed 2024-12-06, 24 open issues, not archived                                                                                                                                                                                                                                            | Active (Sept 2026 release); hosted on code.nolog.cz |

### Gotcha: AWS SDK checksum defaults against non-AWS stores

The SDKs now calculate a CRC checksum on uploads by default. JS v3 uses CRC32, and `request_checksum_calculation` and `response_checksum_validation` both default to `WHEN_SUPPORTED`. `WHEN_REQUIRED` opts out, set either in code (`requestChecksumCalculation`) or with `AWS_REQUEST_CHECKSUM_CALCULATION` / `AWS_RESPONSE_CHECKSUM_VALIDATION` [awsdi]. Third-party stores have broken on this default. GitLab Runner set both settings back to `WhenRequired` for custom endpoints in [MR 6691](https://gitlab.com/gitlab-org/gitlab-runner/-/merge_requests/6691) (a Go SDK case, but the same defaults). R2 accepts CRC32 only as a `COMPOSITE` checksum and CRC64NVME only as `FULL_OBJECT` [r2api]. RustFS gates SHA256 and CRC64NVME validation on PutObject [rfimpl]. Whichever store is picked, test PutObject, multipart and DeleteObjects with the SDK's defaults before relying on them.

### Implications for the Chat SDK

- ADR 0005 has hosts copy the SDK into their app, so every dependency the storage adapter brings lands in the host's install. The AWS SDK adds about 8–9 MB. `aws4fetch` and `s3mini` add almost nothing.
- If the SDK only needs `put`, `get` (stream), `delete` and presigned GET/PUT, `aws4fetch` covers all of it, plus a little XML for errors and lists. Large uploads that need multipart push toward the AWS SDK's `Upload` or `s3mini`.
- Browser-direct uploads use presigned **PUT** on any of these clients, which matters because R2 has no presigned POST (below).

## 2. RustFS

### Maturity and release status

- **GA**: `1.0.0` was published 2026-09-16 as the first non-prerelease. `1.0.1` followed on 2026-10-03 [rfrel]. Before that: `1.0.0-alpha.1` on 2025-07-02, `1.0.0-beta.1` on 2026-04-29, `1.0.0-rc.1` on 2026-08-08. There have been 122 releases in all [rfrel].
- The repo dates from 2023-11-23 and has about 34.8k stars. It was pushed to the day this was written, with 45 open issues and PRs [rfgh].
- The README marks each feature ✅ Available ("shipped and covered by CI gates") or 🧪 Preview. S3 core, upload/download, versioning, IAM/policies, single-node mode, lifecycle and replication are all Available. Preview covers S3 Tables and MinIO on-disk compatibility, the latter behind the non-default `rio-v2` feature. RustFS can't read objects that MinIO encrypted [rfreadme].
- **Security track record**: 35 GitHub security advisories were published between 2025-12-30 and 2026-09-08: 4 critical, 14 high, 13 medium, 4 low [rfsec]. They include IAM and policy bypasses, a stored XSS in the console that led to admin takeover, and privilege escalation through service accounts. One concerns our use case: [GHSA-g8w9-qw9q-fghr](https://github.com/rustfs/rustfs/security/advisories/GHSA-g8w9-qw9q-fghr), "Unsigned `x-amz-*` request headers are honoured on presigned uploads". It affects `<= 1.0.0-rc.5` and is patched in `1.0.0`. For dev and CI this barely matters. For production it means RustFS is very new GA software with a recent stream of serious advisories.

### Licence

Apache-2.0 (the GitHub licence field and README) [rfgh] [rfreadme]. The README presents this against MinIO's AGPL v3.

### S3 API compatibility

The source of truth is the Ceph s3-tests lists in `scripts/s3-tests/`. On `main` that was 556 lines implemented, 37 unimplemented and 317 excluded, counting comments [rfmatrix]. The project claims "broad S3 API compatibility for supported features" and not full coverage [rfmatrix].

- **Presigned URLs**: "Presigned GET and PUT URLs: Supported" [rfmatrix]. `test_cors_presigned_get_object` is in the implemented list. The `*_v2` presigned CORS variants, which use the old SigV2 signature, are excluded [rfimpl] [rfexcl].
- **Multipart**: create, upload, complete and abort are supported [rfmatrix]. Some edge cases sit outside the default gate: listing uploads, part lookup, and the generic `test_multipart_upload` / `_small` cases, filed under "vendor-specific / non-portable". `test_multipart_upload_complete_without_create` and `test_multipart_reupload_checksum_and_etag` are not yet passing [rfexcl] [rfunimpl].
- **CORS**: "Bucket-level CORS configuration, preflight, origin matching" is in the implemented set (`test_set_cors`, `test_cors_header_option`) [rfimpl]. `test_cors_origin_response` and `test_cors_origin_wildcard` sit under "Intentionally unsupported by design: ACL-related tests" [rfexcl]. Separately, the image sets `RUSTFS_CONSOLE_CORS_ALLOWED_ORIGINS="*"` for the console [rfdocker].
- **POST object (HTML form upload)**: the main cases are implemented, but "POST Object form upload checksum handling" is not yet passing [rfmatrix].
- **Not supported, or not yet passing**: ACL authorization (unsupported by design), bucket access logging, bucket ownership controls, and some tenanted bucket-policy cases [rfmatrix].
- **Deviations from AWS**: keys with `.`, `..` or empty (`//`) path segments get `400 InvalidArgument`. Directory markers in versioned buckets are stored as the null version. `CopyObject` with `MetadataDirective=REPLACE` drops `Content-Type` unless you send it again [rfmatrix].
- **Addressing**: without `RUSTFS_SERVER_DOMAINS`, "only path-style addressing is supported (configure clients with ... `force_path_style=true`)" [rfcli]. With the AWS SDK that means `forcePathStyle: true`.

### Official Docker image and config

- The image is `rustfs/rustfs` on Docker Hub. Tags include `latest`, `1.0.1` and `-glibc` variants, built for amd64 and arm64, about 111 MB (musl/alpine) or 161 MB (glibc) [rfhub].
- Dockerfile defaults: `RUSTFS_VOLUMES="/data"`, `VOLUME ["/data"]`, `EXPOSE 9000 9001`, `USER rustfs` (UID/GID **10001**), `CMD ["rustfs"]`, logs in `/logs` [rfdocker]. So **one node on one drive starts with no arguments**.
- The S3 API is on **9000** and the console on **9001**. Health checks are `GET http://localhost:9000/health` and `http://localhost:9001/rustfs/console/health`. The image ships `curl` [rfdocs] [rfcompose].
- Main env vars: `RUSTFS_ACCESS_KEY` and `RUSTFS_SECRET_KEY` (or `*_FILE`), `RUSTFS_ADDRESS`, `RUSTFS_CONSOLE_ADDRESS`, `RUSTFS_CONSOLE_ENABLE`, `RUSTFS_VOLUMES`, `RUSTFS_TLS_PATH` and `RUSTFS_OBS_LOGGER_LEVEL` [rfdocs]. The default credentials are `rustfsadmin`/`rustfsadmin`. The entrypoint only **warns** when they are left unset or default, and the docs say to change them before any network exposure [rfentry] [rfdocs].
- Bind mounts must be writable by `10001:10001`. Named volumes are fine: the upstream `docker-compose-simple.yml` adds an alpine `volume-permission-helper` that runs `chown`. That file uses four volumes (`/data/rustfs{0...3}`) [rfreadme] [rfcompose].
- **Buckets aren't created automatically.** Create them from the console, any S3 client, or a `CreateBucket` call at app start or in test setup.

A minimal compose service for this repo, with ports chosen to dodge 9000/9001 clashes. It is shown for illustration only and isn't added here, since infrastructure is a human decision:

```yaml
rustfs:
  image: rustfs/rustfs:1.0.1
  ports:
    - "${RUSTFS_PORT:-9000}:9000"
    - "${RUSTFS_CONSOLE_PORT:-9001}:9001"
  environment:
    RUSTFS_ACCESS_KEY: ${RUSTFS_ACCESS_KEY:-rustfsadmin}
    RUSTFS_SECRET_KEY: ${RUSTFS_SECRET_KEY:-rustfsadmin}
  volumes:
    - ai-chat_rustfs_data:/data # named volume: owned by 10001 from the image
  healthcheck:
    test: ["CMD", "curl", "-fsS", "http://127.0.0.1:9000/health"]
    interval: 10s
    timeout: 5s
    retries: 5
  restart: unless-stopped
```

Whether a fresh named volume inherits the image's `chown rustfs /data` is standard Docker behaviour for named volumes, but I didn't test it here. Upstream ships the permission helper anyway.

### Fit for local dev and CI e2e (in place of MinIO)

- Nothing in the repo uses MinIO today: `docker-compose.yml` has postgres, redis, migrate and web, and the CI `web-e2e` job has postgres and redis service containers. Earlier research ([attachments.md](./attachments.md)) ruled MinIO out, because its repo is archived and the community edition ships no images.
- RustFS fits both setups. It is one image that needs no command arguments, so it works as a GitHub Actions `services:` container, which takes no `command:`. It has an HTTP health endpoint for `--health-cmd`, the Apache-2.0 licence, and amd64 and arm64 images. CI would need a step to create the bucket and, for browser e2e, a bucket CORS rule.
- Caveat: it differs from R2 in places. R2 has no presigned POST, accepts no presigned URLs on custom domains, and has its own checksum and ACL gaps. Passing e2e against RustFS doesn't prove the R2 path works.

## 3. Cloudflare R2

- **Pricing** [r2price]. Standard storage is $0.015/GB-month (Infrequent Access $0.01). Class A operations cost $4.50 per million, Class B $0.36 per million. "There are no charges for egress bandwidth for any storage class." DeleteObject, DeleteBucket and AbortMultipartUpload are free.
- **Free tier per month** [r2price]: 10 GB-month, 1M Class A, 10M Class B, egress free. "The free tier only applies to Standard storage."
- **Presigned URLs** [r2presign]:
  - Methods GET, HEAD, PUT and DELETE. "`POST` (multipart form uploads via HTML forms) is not currently supported."
  - Expiry from 1 s to 7 days (604,800 s).
  - They work only on the S3 API domain `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` and "cannot be used with custom domains".
  - A signed `Content-Type` must match on upload, or the request fails with 403 `SignatureDoesNotMatch`. That gives a way to pin the MIME type.
- **CORS for direct browser uploads** [r2cors]: set it in the dashboard, with `wrangler r2 bucket cors set`, or through `PutBucketCors` (implemented [r2api]). The example rule allows `PUT` with header `Content-Type` and exposes `ETag`. Rules can take up to 30 s to propagate. Expired presigned URLs return 403 `ExpiredRequest` **without CORS headers**, so browser JS can't read the error.
- **Public buckets vs signed URLs** [r2public]:
  - Buckets are private by default.
  - Public access goes through a custom domain (the zone must be in the same Cloudflare account; non-Cloudflare domains can use a partial CNAME setup), which brings Cloudflare Cache, WAF, Access and WAF token authentication.
  - `r2.dev` URLs are "rate-limited and should only be used for development purposes", with no caching or WAF.
  - Presigned URLs give per-object, time-limited access on the S3 domain, without the CDN cache.
  - For private Attachments, the trade-off is presigned GET URLs (no cache, short expiry) against a custom domain plus token authentication.
- **Limits** [r2limits] [r2mpu]:
  - Objects up to 5 TiB. Single-part uploads up to 5 GiB.
  - Multipart parts must be 5 MiB to 5 GiB and all the same size except the last, with at most 10,000 parts. Incomplete uploads abort after 7 days by default.
  - Keys up to 1,024 bytes, metadata up to 8,192 bytes.
  - **1 write per second to the same key**, above which R2 returns 429.
- **API specifics** [r2api]:
  - Region `auto` (`us-east-1` and empty map to it).
  - No ACLs, Object Lock, KMS SSE, object tagging, bucket policy or versioning.
  - Checksums: CRC32, CRC32C, SHA-1 and SHA-256 `COMPOSITE` only; CRC64NVME `FULL_OBJECT` only.
- **Local dev**: "you cannot use AWS S3-compatible API while developing locally via `wrangler dev`" [r2aws]. In other words, R2 has no local emulator for the S3 API, which is a reason to run RustFS (or similar) locally.

## Implications for #170 (facts, not a decision)

1. One S3 adapter can cover R2 in production and RustFS in dev and CI. It needs a configurable endpoint, path-style addressing (RustFS without `RUSTFS_SERVER_DOMAINS`), region `auto`, and AWS SDK checksum settings that both stores accept.
2. Design browser uploads around **presigned PUT**. R2 has no presigned POST, so a `content-length-range` policy isn't available. Size limits must then be enforced another way, for example by signing `Content-Length` or checking with HEAD after the upload.
3. R2 presigned URLs can't use a custom domain. Downloads served through a CDN would need a public custom-domain bucket with token auth. Otherwise the app streams or redirects to a presigned GET.

## Not verified

- AWS SDK v3 on Cloudflare Workers (not stated in the SDK README).
- Total dependency sizes are an approximation from walking the npm registry (latest version of each dep), not a real install.
- Behaviour of RustFS 1.0.1 against R2-specific quirks. No interop test was run.
- s3mini's streaming support.

## Sources

- [npm1] <https://www.npmjs.com/package/@aws-sdk/client-s3> (registry metadata, 2026-10-12)
- [npm2] <https://www.npmjs.com/package/aws4fetch>
- [npm3] <https://www.npmjs.com/package/s3mini>
- [a4f] aws4fetch README and source: <https://github.com/mhart/aws4fetch>, <https://github.com/mhart/aws4fetch/blob/master/src/main.js>
- [s3m] s3mini README: <https://code.nolog.cz/thinking.tools/s3mini>
- [awsjs] AWS SDK for JavaScript v3 README: <https://github.com/aws/aws-sdk-js-v3>
- [libst] `@aws-sdk/lib-storage` README: <https://github.com/aws/aws-sdk-js-v3/tree/main/lib/lib-storage>
- [awsdi] AWS SDKs data integrity protections: <https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html>
- [rfgh] <https://github.com/rustfs/rustfs> (GitHub API: licence, stars, created, open issues)
- [rfrel] <https://github.com/rustfs/rustfs/releases> (`1.0.0`: <https://github.com/rustfs/rustfs/releases/tag/1.0.0>)
- [rfreadme] <https://github.com/rustfs/rustfs/blob/main/README.md>
- [rfmatrix] <https://github.com/rustfs/rustfs/blob/main/docs/architecture/s3-compatibility-matrix.md>
- [rfimpl] <https://github.com/rustfs/rustfs/blob/main/scripts/s3-tests/implemented_tests.txt>
- [rfunimpl] <https://github.com/rustfs/rustfs/blob/main/scripts/s3-tests/unimplemented_tests.txt>
- [rfexcl] <https://github.com/rustfs/rustfs/blob/main/scripts/s3-tests/excluded_tests.txt>
- [rfcli] <https://github.com/rustfs/rustfs/blob/main/rustfs/src/config/cli.rs> (`RUSTFS_SERVER_DOMAINS`)
- [rfdocker] <https://github.com/rustfs/rustfs/blob/main/Dockerfile>
- [rfentry] <https://github.com/rustfs/rustfs/blob/main/entrypoint.sh>
- [rfcompose] <https://github.com/rustfs/rustfs/blob/main/docker-compose-simple.yml>
- [rfdocs] <https://docs.rustfs.com/installation/docker/>
- [rfhub] <https://hub.docker.com/r/rustfs/rustfs/tags>
- [rfsec] <https://github.com/rustfs/rustfs/security/advisories>
- [r2price] <https://developers.cloudflare.com/r2/pricing/>
- [r2presign] <https://developers.cloudflare.com/r2/api/s3/presigned-urls/>
- [r2cors] <https://developers.cloudflare.com/r2/buckets/cors/>
- [r2public] <https://developers.cloudflare.com/r2/buckets/public-buckets/>
- [r2limits] <https://developers.cloudflare.com/r2/platform/limits/>
- [r2mpu] <https://developers.cloudflare.com/r2/objects/multipart-objects/>
- [r2api] <https://developers.cloudflare.com/r2/api/s3/api/>
- [r2aws] <https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/>
- [r2a4f] <https://developers.cloudflare.com/r2/examples/aws/aws4fetch/>
