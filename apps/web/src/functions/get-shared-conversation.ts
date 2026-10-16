import { createServerFn } from "@tanstack/react-start";

import { sdk } from "@/services";

/**
 * A Shared link's snapshot, read on the server so the Host's route renders it (ADR 0005). The
 * snapshot is JSON-safe, but `@tanstack/ai` types part metadata as `unknown`, which TanStack's
 * serialization check rejects, so the route types the result itself.
 */
export const getSharedConversation = createServerFn({ method: "GET" })
  .inputValidator((token: string) => token)
  .handler(async ({ data: token }) => (await sdk.getSharedConversation(token)) as never);
