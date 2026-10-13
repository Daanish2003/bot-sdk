import { createDb } from "@ai-chat/db";
import { session, user } from "@ai-chat/db/schema/auth";
import { createMemorySender } from "@ai-chat/email";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { type AuthConfig, createAuth } from "../src/index";

const BASE = "http://localhost:3000";
const PASSWORD = "passkey-password-1";
const env: AuthConfig = {
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "auth-passkey-integration-secret-0123",
  APP_NAME: "Acme Chat",
  GITHUB_CLIENT_ID: "test-github-client-id",
  GITHUB_CLIENT_SECRET: "test-github-client-secret",
  GOOGLE_CLIENT_ID: "test-google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
};
const database = createDb({ DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" });
const noChatData = { deleteChatData: async () => {} };
const logger = { error: () => {} };

afterAll(async () => {
  await database.$client.end();
});

/** An in-memory fixed-window counter, the same shape the Redis one has. */
function memoryCounter() {
  const counts = new Map<string, number>();
  return {
    async increment(key: string) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
  };
}

function makeAuth(options: {
  rateLimit: boolean;
  rateLimitCounter?: ReturnType<typeof memoryCounter>;
}) {
  return createAuth(env, database, createMemorySender(), logger, noChatData, options);
}

type Auth = ReturnType<typeof makeAuth>;

function call(auth: Auth, path: string, body: unknown, cookie?: string) {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

function get(auth: Auth, path: string, cookie?: string) {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      headers: {
        origin: BASE,
        ...(cookie ? { cookie } : {}),
      },
    }),
  );
}

/** The cookies a response sets, as one `cookie` header value for the next request. */
function cookiesOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

/** A verified user with a password, as an address no other test uses. */
async function verifiedUser(auth: Auth) {
  const email = `passkey-${randomUUID()}@example.com`;
  await call(auth, "/sign-up/email", { name: "Passkey", email, password: PASSWORD });
  await database.update(user).set({ emailVerified: true }).where(eq(user.email, email));
  const [row] = await database.select({ id: user.id }).from(user).where(eq(user.email, email));
  return { id: row!.id, email };
}

/** Signs in and returns the session cookie. */
async function signedInCookie(auth: Auth, email: string) {
  const response = await call(auth, "/sign-in/email", { email, password: PASSWORD });
  return cookiesOf(response);
}

describe("passkey plugin", () => {
  it("sets the relying party id to the BETTER_AUTH_URL hostname", async () => {
    const auth = makeAuth({ rateLimit: false });
    const { email } = await verifiedUser(auth);
    const cookie = await signedInCookie(auth, email);

    const response = await get(auth, "/passkey/generate-register-options", cookie);

    expect(response.status).toBe(200);
    const options = (await response.json()) as { rp: { id: string } };
    expect(options.rp.id).toBe("localhost");
  });

  it("refuses to start adding a passkey from a session older than a day", async () => {
    const auth = makeAuth({ rateLimit: false });
    const { id, email } = await verifiedUser(auth);
    const cookie = await signedInCookie(auth, email);
    // Pushes the session's creation two days back, past the one-day fresh window.
    await database
      .update(session)
      .set({ createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
      .where(eq(session.userId, id));

    const response = await get(auth, "/passkey/generate-register-options", cookie);

    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("SESSION_NOT_FRESH");
  });

  it("limits passkey sign-in to 3 attempts per 10 seconds", async () => {
    const auth = makeAuth({ rateLimit: true, rateLimitCounter: memoryCounter() });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await call(auth, "/passkey/verify-authentication", {
        response: { id: "unknown-credential" },
      });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 3).every((status) => status !== 429)).toBe(true);
    expect(statuses[3]).toBe(429);
  });

  it("limits the passkey sign-in options endpoint too", async () => {
    const auth = makeAuth({ rateLimit: true, rateLimitCounter: memoryCounter() });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await get(auth, "/passkey/generate-authenticate-options")).status);
    }

    expect(statuses[3]).toBe(429);
  });
});
