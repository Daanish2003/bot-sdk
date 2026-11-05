import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createDb } from "@ai-chat/db";

import { e2eDatabaseUrl } from "../database";

const publicFile = (name: string) => new URL(`../../public/${name}`, import.meta.url);

/**
 * A shop's own site, on an origin of its own (not the app's), so the widget's calls to the app are
 * cross-origin as they are on a real page. It serves only the widget's script and the example page,
 * both as the app has them.
 */
export async function startShopSite(): Promise<{ origin: string; server: Server }> {
  const types: Record<string, string> = {
    "/widget.js": "text/javascript",
    "/widget-example.html": "text/html",
  };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://shop.invalid").pathname;
    const type = types[path];
    if (!type) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", `${type}; charset=utf-8`);
    response.end(await readFile(publicFile(path.slice(1))));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return { origin: `http://localhost:${(server.address() as AddressInfo).port}`, server };
}

/** Makes `general` an auto topic with the fact the fake Model's `reply` cites, so a reply goes out unheld. */
export async function seedAutoTopic(userId: string) {
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  const now = new Date();
  try {
    const run = (query: string, values: unknown[]) => db.$client.query(query, values);
    await run(
      "insert into botsdk.representative_topic (id, user_id, name, mode) values ($1, $2, 'general', 'auto')",
      [randomUUID(), userId],
    );
    await run(
      "insert into botsdk.representative_fact (id, user_id, key, type, topic, value, created_at, updated_at) values ($1, $2, 'general.note', 'text', 'general', 'Noted', $3, $3)",
      [randomUUID(), userId, now],
    );
  } finally {
    await db.$client.end();
  }
}
