import type { Plugin } from "vite";

/**
 * Stops the dev server's error responses being cached. Vite sets `max-age=31536000,immutable` on a
 * pre-bundled dependency before sending it, so when the send fails (Varlock's leak check throws in
 * `res.end`) the 500 goes out with that header, and the browser replays the 500 for a year without
 * asking the server again, even after the cause is fixed. The leak check still fails the response.
 */
export function noStoreErrors(): Plugin {
  return {
    name: "no-store-errors",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        const end = res.end;
        res.end = function (this: typeof res, ...args: Parameters<typeof end>) {
          if (res.statusCode >= 400 && !res.headersSent) {
            res.setHeader("Cache-Control", "no-store");
          }
          return end.apply(this, args);
        } as typeof end;
        next();
      });
    },
  };
}
