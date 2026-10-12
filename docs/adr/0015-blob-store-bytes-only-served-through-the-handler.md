---
Status: accepted
---

# The blob store holds bytes only, and files are served through the handler

The Chat SDK keeps file bytes (Attachments now; Knowledge files and Generated images later) in a `blobStore` passed to `createChat`, as ADR 0005 planned. It defaults to `postgresBlobStore()`, a `chat.blob` table in the same database; `s3BlobStore()` covers R2 in production and RustFS in dev and CI. The store only puts, gets and deletes whole byte arrays under keys the SDK makes up (`attachment/<id>`). Names, types, sizes and owners stay in Postgres tables. Any route that serves bytes goes through `chat.handler`, never a redirect to a presigned URL, so the owner check and Shared-link rules live in one place and both stores behave the same.

## Considered Options

- **Presigned uploads and downloads**: the Postgres store can't presign, R2 can't presign on a custom domain or take presigned POST, and files are at most 5 MB and are read whole anyway to send to the Provider as base64.
- **Streams instead of byte arrays**: nothing reads a file in pieces yet.
- **`@aws-sdk/client-s3`**: about 8–9 MB in every Host's install (the SDK is copied) and checksum defaults R2 rejects. `aws4fetch` signs single PUT, GET and DELETE requests, which is all a 5 MB file needs.

## Consequences

- Postgres and S3 can't share a transaction. Upload writes the object before the row; `deleteUser` and the orphan reaper delete objects after their commit, best-effort and logged. A failed delete leaves a stray object; nothing sweeps them.
- Switching a running deployment from one store to the other is not supported: there is no copy tool.
