import { os } from "@orpc/server";

import type { Context } from "./context";
import { rpcError } from "./rpc-error";

export const o = os.$context<Context>();

export const publicProcedure = o;

/** Refuses a call without a signed-in user, and narrows `context.user`. */
export const requireAuth = o.middleware(async ({ context, next }) => {
  if (!context.user) {
    throw rpcError("UNAUTHORIZED", "error.unauthorized", "Unauthorized");
  }
  return next({
    context: {
      user: context.user,
    },
  });
});

export const protectedProcedure = publicProcedure.use(requireAuth);
