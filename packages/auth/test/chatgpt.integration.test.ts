import { createDb } from "@ai-chat/db";
import { account, user } from "@ai-chat/db/schema/auth";
import { createMemorySender } from "@ai-chat/email";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { chatgptAccessToken } from "../src/chatgpt";
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
const chatgptEnv: AuthConfig = {
  ...env,
  CHATGPT_CLIENT_ID: "oaiapp_test",
  CHATGPT_HOST_ID: "urn:uuid:test-host",
};
const database = createDb({ DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" });
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";

afterAll(async () => {
  await database.$client.end();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function newAuth(config: AuthConfig = chatgptEnv) {
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

function jwt(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

// Stands in for ChatGPT's token endpoint; every other request goes to the real fetch.
function fakeTokenEndpoint(reply: () => Response) {
  const calls: URLSearchParams[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(TOKEN_URL)) return real(input, init);
    calls.push(new URLSearchParams(String(init?.body)));
    return reply();
  });
  return calls;
}

const tokenReply = (body: Record<string, unknown>) => () =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

async function startLink(auth: Auth, cookie: string) {
  const started = await post(
    auth,
    "/link-social",
    { provider: "chatgpt", callbackURL: "/c" },
    cookie,
  );
  const { url } = (await started.json()) as { url: string };
  return { authorize: new URL(url), cookie: [cookie, cookieOf(started)].join("; ") };
}

async function linkChatgpt(auth: Auth, cookie: string, chatgptEmail: string) {
  const { authorize, cookie: cookies } = await startLink(auth, cookie);
  const calls = fakeTokenEndpoint(
    tokenReply({
      access_token: "chatgpt-access-1",
      refresh_token: "chatgpt-refresh-1",
      expires_in: 3600,
      id_token: jwt({ sub: `chatgpt-${randomUUID()}`, email: chatgptEmail, email_verified: true }),
    }),
  );
  const callback = new URL(`${BASE}/api/auth/callback/chatgpt`);
  callback.searchParams.set("code", "code-1");
  callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
  const response = await auth.handler(new Request(callback, { headers: { cookie: cookies } }));
  return { response, tokenRequest: calls[0] };
}

function chatgptRows(userId: string) {
  return database
    .select()
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "chatgpt")));
}

describe("the chatgpt provider", () => {
  it.each([
    ["neither id is set", env],
    ["only the client id is set", { ...env, CHATGPT_CLIENT_ID: "oaiapp_test" }],
    ["only the host id is set", { ...env, CHATGPT_HOST_ID: "urn:uuid:test-host" }],
  ])("does not exist when %s", async (_name, config) => {
    const auth = newAuth(config);
    const { cookie } = await signedIn(auth, `absent-${randomUUID()}@example.com`);

    const response = await post(auth, "/link-social", { provider: "chatgpt" }, cookie);

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("starts the link at ChatGPT with PKCE, the scopes, the resource and the host id", async () => {
    const auth = newAuth();
    const { cookie } = await signedIn(auth, `start-${randomUUID()}@example.com`);

    const { authorize } = await startLink(auth, cookie);

    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      "https://auth.openai.com/api/accounts/authorize",
    );
    expect(authorize.searchParams.get("client_id")).toBe("oaiapp_test");
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3000/auth/callback");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(authorize.searchParams.get("ext_agent_host_id")).toBe("urn:uuid:test-host");
    expect(authorize.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining([
        "openid",
        "profile",
        "email",
        "offline_access",
        "resource.invoke",
        "chatgpt.tokens.use.direct",
      ]),
    );
  });

  it("links a ChatGPT account whose email differs from the user's, tokens stored encrypted", async () => {
    const auth = newAuth();
    const { cookie, userId } = await signedIn(auth, `link-${randomUUID()}@example.com`);

    const { response: callback, tokenRequest } = await linkChatgpt(
      auth,
      cookie,
      `other-${randomUUID()}@openai.test`,
    );

    expect(callback.headers.get("location")).not.toContain("error");
    expect(tokenRequest.get("redirect_uri")).toBe("http://127.0.0.1:3000/auth/callback");
    expect(tokenRequest.get("resource")).toBe("https://api.openai.com/v1");
    expect(tokenRequest.get("code_verifier")).toBeTruthy();
    const [linked] = await chatgptRows(userId);
    expect(linked).toBeDefined();
    expect(linked.accessToken).toBeTruthy();
    expect(linked.accessToken).not.toBe("chatgpt-access-1");
    expect(linked.refreshToken).toBeTruthy();
    expect(linked.refreshToken).not.toBe("chatgpt-refresh-1");
  });

  it("refuses to sign anyone in, even a user whose email matches", async () => {
    const auth = newAuth();
    const email = `member-${randomUUID()}@example.com`;
    await signedIn(auth, email);

    const byRedirect = await post(auth, "/sign-in/social", { provider: "chatgpt" });
    const byIdToken = await post(auth, "/sign-in/social", {
      provider: "chatgpt",
      idToken: { token: jwt({ sub: "s", email, email_verified: true }) },
    });

    for (const response of [byRedirect, byIdToken]) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(cookieOf(response)).not.toContain("session_token");
    }
  });
});

describe("the ChatGPT access token", () => {
  async function withLinkedAccount(expiresAt: Date) {
    const auth = newAuth();
    const { userId } = await signedIn(auth, `token-${randomUUID()}@example.com`);
    const now = new Date();
    await database.insert(account).values({
      id: randomUUID(),
      accountId: `chatgpt-${randomUUID()}`,
      providerId: "chatgpt",
      userId,
      accessToken: "stale-access",
      refreshToken: "refresh-old",
      accessTokenExpiresAt: expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    return { auth, userId };
  }

  it("is refreshed with the resource, and the new tokens are stored encrypted", async () => {
    const { auth, userId } = await withLinkedAccount(new Date(Date.now() - 60_000));
    const calls = fakeTokenEndpoint(
      tokenReply({ access_token: "fresh-access", refresh_token: "refresh-new", expires_in: 3600 }),
    );

    const result = await chatgptAccessToken(auth, database, userId);

    expect(result).toEqual({ status: "ok", accessToken: "fresh-access" });
    expect(calls).toHaveLength(1);
    expect(calls[0].get("grant_type")).toBe("refresh_token");
    expect(calls[0].get("refresh_token")).toBe("refresh-old");
    expect(calls[0].get("resource")).toBe("https://api.openai.com/v1");
    const [row] = await chatgptRows(userId);
    expect(row.accessToken).not.toBe("fresh-access");
    expect(row.refreshToken).not.toBe("refresh-new");
  });

  it("is returned as stored while it has time left", async () => {
    const { auth, userId } = await withLinkedAccount(new Date(Date.now() + 3_600_000));
    const calls = fakeTokenEndpoint(tokenReply({ access_token: "never" }));

    expect(await chatgptAccessToken(auth, database, userId)).toEqual({
      status: "ok",
      accessToken: "stale-access",
    });
    expect(calls).toHaveLength(0);
  });

  it("asks to reconnect when ChatGPT rejects the refresh", async () => {
    const { auth, userId } = await withLinkedAccount(new Date(Date.now() - 60_000));
    fakeTokenEndpoint(
      () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    expect(await chatgptAccessToken(auth, database, userId)).toEqual({ status: "needs-reconnect" });
  });

  it("is none for a user who has not linked ChatGPT", async () => {
    const auth = newAuth();
    const { userId } = await signedIn(auth, `unlinked-${randomUUID()}@example.com`);

    expect(await chatgptAccessToken(auth, database, userId)).toEqual({ status: "none" });
  });
});

describe("token encryption", () => {
  it("still reads a GitHub token stored in plaintext before encryption was on", async () => {
    const auth = newAuth();
    const { userId } = await signedIn(auth, `plain-${randomUUID()}@example.com`);
    const now = new Date();
    const id = randomUUID();
    await database.insert(account).values({
      id,
      accountId: `github-${randomUUID()}`,
      providerId: "github",
      userId,
      accessToken: "gho_plaintext",
      createdAt: now,
      updatedAt: now,
    });

    const { accessToken } = await auth.api.getAccessToken({ body: { accountId: id, userId } });

    expect(accessToken).toBe("gho_plaintext");
  });
});
