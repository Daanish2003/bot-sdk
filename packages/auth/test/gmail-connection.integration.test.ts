import { createDb } from "@ai-chat/db";
import { account, user } from "@ai-chat/db/schema/auth";
import { createMemorySender } from "@ai-chat/email";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { linkedAccessToken } from "../src/linked-token";
import { type AuthConfig, createAuth } from "../src/index";

const BASE = "http://localhost:3000";
const env: AuthConfig = {
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "auth-integration-secret-0123456789abcdef",
  APP_NAME: "Acme Chat",
  GITHUB_CLIENT_ID: "test-github-client-id",
  GITHUB_CLIENT_SECRET: "test-github-client-secret",
  GOOGLE_CLIENT_ID: "test-google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
};
const database = createDb({ DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" });

afterAll(async () => {
  await database.$client.end();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function newAuth(config: AuthConfig = env) {
  return createAuth(
    config,
    database,
    createMemorySender(),
    { error: vi.fn() },
    { deleteChatData: async () => {} },
    { rateLimit: false },
  );
}

type Auth = ReturnType<typeof createAuth>;

function post(auth: Auth, path: string, body: unknown, cookie?: string) {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, ...(cookie && { cookie }) },
      body: JSON.stringify(body),
    }),
  );
}

function cookieOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

async function signedIn(auth: Auth, email: string) {
  await post(auth, "/sign-up/email", { name: "Someone", email, password: "linker-password-1" });
  await database.update(user).set({ emailVerified: true }).where(eq(user.email, email));
  const [owner] = await database.select({ id: user.id }).from(user).where(eq(user.email, email));
  const response = await post(auth, "/sign-in/email", { email, password: "linker-password-1" });
  return { cookie: cookieOf(response), userId: owner.id };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

// Stands in for Google: its token endpoint hands out an access and a refresh token, its userinfo
// endpoint is one fixed account. Every other request goes to the real fetch.
function fakeGoogle() {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return json({
        access_token: "ya29.gmail-token",
        refresh_token: "1//gmail-refresh",
        expires_in: 3599,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.modify",
      });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return json({ sub: "1077", email: "me@gmail.example", email_verified: true, name: "Me" });
    }
    return real(input, init);
  });
}

async function startLink(auth: Auth, cookie: string, provider = "gmail") {
  const started = await post(auth, "/link-social", { provider, callbackURL: "/c" }, cookie);
  const { url } = (await started.json()) as { url: string };
  return { authorize: new URL(url), cookie: `${cookie}; ${cookieOf(started)}` };
}

describe("the gmail provider", () => {
  it.each([
    ["neither Google variable is set", { ...env, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" }],
    ["only the secret is set", { ...env, GOOGLE_CLIENT_ID: "" }],
  ])("does not exist when %s", async (_name, config) => {
    const auth = newAuth(config);
    const { cookie } = await signedIn(auth, `absent-${randomUUID()}@example.com`);

    const response = await post(auth, "/link-social", { provider: "gmail" }, cookie);

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("starts the link at Google with the sign-in client, the Gmail scope, its own callback and a refresh token asked for", async () => {
    const auth = newAuth();
    const { cookie } = await signedIn(auth, `start-${randomUUID()}@example.com`);

    const { authorize } = await startLink(auth, cookie);

    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(authorize.searchParams.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/gmail`);
    expect(authorize.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["https://www.googleapis.com/auth/gmail.modify"]),
    );
    expect(authorize.searchParams.get("scope")).not.toContain("calendar");
    expect(authorize.searchParams.get("access_type")).toBe("offline");
    expect(authorize.searchParams.get("prompt")).toBe("consent");
  });

  it("links a Google account, keeping its refresh token, both stored encrypted", async () => {
    const auth = newAuth();
    const { cookie, userId } = await signedIn(auth, `link-${randomUUID()}@example.com`);
    const { authorize, cookie: cookies } = await startLink(auth, cookie);
    fakeGoogle();

    const callback = new URL(`${BASE}/api/auth/callback/gmail`);
    callback.searchParams.set("code", "code-1");
    callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    const response = await auth.handler(new Request(callback, { headers: { cookie: cookies } }));

    expect(response.headers.get("location")).not.toContain("error");
    const [linked] = await database
      .select()
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, "gmail")));
    expect(linked.accountId).toBe("1077");
    expect(linked.refreshToken).toBeTruthy();
    expect(linked.refreshToken).not.toBe("1//gmail-refresh");
    expect(await linkedAccessToken(auth, database, userId, "gmail")).toMatchObject({
      status: "ok",
      accessToken: "ya29.gmail-token",
    });
  });

  it("refuses to sign anyone in", async () => {
    const auth = newAuth();

    const response = await post(auth, "/sign-in/social", { provider: "gmail" });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(cookieOf(response)).not.toContain("session_token");
  });

  it("connects and disconnects apart from Google Calendar, each with its own account row", async () => {
    const auth = newAuth();
    const { cookie, userId } = await signedIn(auth, `apart-${randomUUID()}@example.com`);
    fakeGoogle();
    for (const provider of ["google-calendar", "gmail"]) {
      const { authorize, cookie: cookies } = await startLink(auth, cookie, provider);
      const callback = new URL(`${BASE}/api/auth/callback/${provider}`);
      callback.searchParams.set("code", "code-1");
      callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
      await auth.handler(new Request(callback, { headers: { cookie: cookies } }));
    }
    const rows = () =>
      database
        .select()
        .from(account)
        .where(eq(account.userId, userId))
        .then((all) => all.filter((row) => ["gmail", "google-calendar"].includes(row.providerId)));
    expect((await rows()).map((row) => row.providerId).sort()).toEqual([
      "gmail",
      "google-calendar",
    ]);
    const gmail = (await rows()).find((row) => row.providerId === "gmail");

    const response = await post(auth, "/unlink-account", { accountId: gmail?.id }, cookie);

    expect(response.status).toBe(200);
    expect((await rows()).map((row) => row.providerId)).toEqual(["google-calendar"]);
    expect(await linkedAccessToken(auth, database, userId, "google-calendar")).toMatchObject({
      status: "ok",
    });
    expect(await linkedAccessToken(auth, database, userId, "gmail")).toEqual({ status: "none" });
  });
});
