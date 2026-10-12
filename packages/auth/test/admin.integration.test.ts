import { createDb } from "@ai-chat/db";
import { user } from "@ai-chat/db/schema/auth";
import { createMemorySender } from "@ai-chat/email";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { type AuthConfig, createAuth } from "../src/index";
import { setUserRole } from "../src/roles";

const BASE = "http://localhost:3000";
const env: AuthConfig = {
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "auth-admin-integration-secret-0123456789",
  APP_NAME: "Acme Chat",
  GITHUB_CLIENT_ID: "test-github-client-id",
  GITHUB_CLIENT_SECRET: "test-github-client-secret",
  GOOGLE_CLIENT_ID: "test-google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
};
const database = createDb({ DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" });
const noChatData = { deleteChatData: async () => {} };
const noLimits = { rateLimit: false };
const logger = { error: () => {} };

afterAll(async () => {
  await database.$client.end();
});

function makeAuth() {
  return createAuth(env, database, createMemorySender(), logger, noChatData, noLimits);
}

/** A verified user with a password, as an address no other test uses. */
async function verifiedUser(auth: ReturnType<typeof makeAuth>, label: string) {
  const email = `${label}-${randomUUID()}@example.com`;
  await auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ name: label, email, password: "admin-password-1" }),
    }),
  );
  await database.update(user).set({ emailVerified: true }).where(eq(user.email, email));
  const [row] = await database.select({ id: user.id }).from(user).where(eq(user.email, email));
  return { id: row!.id, email };
}

async function signedInCookie(auth: ReturnType<typeof makeAuth>, email: string) {
  const response = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: "admin-password-1" }),
    }),
  );
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

describe("setUserRole (admin:grant and admin:revoke)", () => {
  it("grants the admin role by email, revokes it again, and reports an unknown email", async () => {
    const auth = makeAuth();
    const person = await verifiedUser(auth, "grantee");

    const granted = await setUserRole(database, person.email.toUpperCase(), "admin");
    expect(granted).toEqual({ id: person.id, email: person.email, role: "admin" });
    const [asAdmin] = await database
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, person.id));
    expect(asAdmin?.role).toBe("admin");

    const revoked = await setUserRole(database, person.email, "user");
    expect(revoked?.role).toBe("user");
    const [asUser] = await database
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, person.id));
    expect(asUser?.role).toBe("user");

    expect(await setUserRole(database, `nobody-${randomUUID()}@example.com`, "admin")).toBeNull();
  });
});

describe("impersonation", () => {
  it("refuses an Admin who asks to impersonate another user", async () => {
    const auth = makeAuth();
    const admin = await verifiedUser(auth, "impersonator");
    const target = await verifiedUser(auth, "target");
    await setUserRole(database, admin.email, "admin");
    const cookie = await signedInCookie(auth, admin.email);

    const response = await auth.handler(
      new Request(`${BASE}/api/auth/admin/impersonate-user`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie },
        body: JSON.stringify({ userId: target.id }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS",
    });
  });
});
