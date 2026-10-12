import { notFound } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";

import { authMiddleware } from "./auth";

/**
 * The Admin guard (spec #277): every `/admin` server function runs it. A user who isn't an Admin,
 * or isn't signed in, gets a 404, so the page's existence isn't confirmed.
 */
export const adminMiddleware = createMiddleware()
  .middleware([authMiddleware])
  .server(async ({ next, context }) => {
    if (context.session?.user.role !== "admin") throw notFound();
    return next();
  });
