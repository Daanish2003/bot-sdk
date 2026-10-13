// The passkey client plugin (spec #277), re-exported so `apps/web` gets it from `@ai-chat/auth`
// and needs no dependency of its own on the passkey package. The server plugin is in `createAuth`.
export { passkeyClient } from "@better-auth/passkey/client";
