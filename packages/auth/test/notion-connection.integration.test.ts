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
  NOTION_CLIENT_ID: "notion-client-id",
  NOTION_CLIENT_SECRET: "notion-client-secret",
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

type TokenRequest = { authorization: string | null; body: URLSearchParams };

// Stands in for Notion: its token endpoint answers the code exchange and the refresh, and records
// the requests; `/v1/users/me` names the bot's owner, with no email unless `email` is given.
// Every other request goes to the real fetch.
function fakeNotion(options: { email?: string } = {}) {
  const real = globalThis.fetch;
  const tokenRequests: TokenRequest[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://api.notion.com/v1/oauth/token") {
      const text = await request.text();
      tokenRequests.push({
        authorization: request.headers.get("authorization"),
        body: request.headers.get("content-type")?.includes("json")
          ? new URLSearchParams(JSON.parse(text) as Record<string, string>)
          : new URLSearchParams(text),
      });
      return json({
        access_token: "ntn_notion-access",
        refresh_token: "notion-refresh",
        expires_in: 3600,
        token_type: "bearer",
        bot_id: "bot-1",
        workspace_id: "ws-1",
        workspace_name: "Acme",
        owner: { type: "user", user: { id: "notion-user-77" } },
      });
    }
    if (request.url === "https://api.notion.com/v1/users/me") {
      return json({
        object: "user",
        id: "bot-user",
        bot: {
          owner: {
            type: "user",
            user: {
              id: "notion-user-77",
              name: "Nora",
              ...(options.email ? { person: { email: options.email } } : {}),
            },
          },
          workspace_name: "Acme",
        },
      });
    }
    return real(input, init);
  });
  return { tokenRequests };
}

async function startLink(auth: Auth, cookie: string) {
  const started = await post(
    auth,
    "/link-social",
    { provider: "notion", callbackURL: "/c" },
    cookie,
  );
  const { url } = (await started.json()) as { url: string };
  return { authorize: new URL(url), cookie: `${cookie}; ${cookieOf(started)}` };
}

async function callback(auth: Auth, authorize: URL, cookies: string) {
  const url = new URL(`${BASE}/api/auth/callback/notion`);
  url.searchParams.set("code", "code-1");
  url.searchParams.set("state", authorize.searchParams.get("state") ?? "");
  return auth.handler(new Request(url, { headers: { cookie: cookies } }));
}

describe("the notion provider", () => {
  it.each([
    ["neither Notion variable is set", { ...env, NOTION_CLIENT_ID: "", NOTION_CLIENT_SECRET: "" }],
    ["only the secret is set", { ...env, NOTION_CLIENT_ID: "" }],
    ["both are left out", { ...env, NOTION_CLIENT_ID: undefined, NOTION_CLIENT_SECRET: undefined }],
  ])("does not exist when %s", async (_name, config) => {
    const auth = newAuth(config);
    const { cookie } = await signedIn(auth, `absent-${randomUUID()}@example.com`);

    const response = await post(auth, "/link-social", { provider: "notion" }, cookie);

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("starts the link at Notion with its client, its own callback and owner=user", async () => {
    const auth = newAuth();
    const { cookie } = await signedIn(auth, `start-${randomUUID()}@example.com`);

    const { authorize } = await startLink(auth, cookie);

    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      "https://api.notion.com/v1/oauth/authorize",
    );
    expect(authorize.searchParams.get("client_id")).toBe("notion-client-id");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/notion`);
    expect(authorize.searchParams.get("owner")).toBe("user");
    expect(authorize.searchParams.get("response_type")).toBe("code");
  });

  it("links the Notion user who authorized, with no email Notion gave", async () => {
    const auth = newAuth();
    const { cookie, userId } = await signedIn(auth, `link-${randomUUID()}@example.com`);
    const { authorize, cookie: cookies } = await startLink(auth, cookie);
    const { tokenRequests } = fakeNotion();

    const response = await callback(auth, authorize, cookies);

    expect(response.headers.get("location")).not.toContain("error");
    // Notion wants the client's id and secret as HTTP Basic, not in the body.
    expect(tokenRequests[0]?.authorization).toBe(
      `Basic ${Buffer.from("notion-client-id:notion-client-secret").toString("base64")}`,
    );
    expect(tokenRequests[0]?.body.get("grant_type")).toBe("authorization_code");
    expect(tokenRequests[0]?.body.get("client_secret")).toBeNull();
    const [linked] = await database
      .select()
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, "notion")));
    expect(linked.accountId).toBe("notion-user-77");
    expect(linked.accessToken).not.toBe("ntn_notion-access");
    expect(await linkedAccessToken(auth, database, userId, "notion")).toMatchObject({
      status: "ok",
      accessToken: "ntn_notion-access",
    });
  });

  it("refreshes an expired token with Basic client authentication too", async () => {
    const auth = newAuth();
    const { cookie, userId } = await signedIn(auth, `refresh-${randomUUID()}@example.com`);
    const { authorize, cookie: cookies } = await startLink(auth, cookie);
    const { tokenRequests } = fakeNotion();
    await callback(auth, authorize, cookies);
    await database
      .update(account)
      .set({ accessTokenExpiresAt: new Date(Date.now() - 60_000) })
      .where(and(eq(account.userId, userId), eq(account.providerId, "notion")));

    const token = await linkedAccessToken(auth, database, userId, "notion");

    expect(token).toMatchObject({ status: "ok", accessToken: "ntn_notion-access" });
    const refresh = tokenRequests.at(-1);
    expect(refresh?.body.get("grant_type")).toBe("refresh_token");
    expect(refresh?.authorization).toBe(
      `Basic ${Buffer.from("notion-client-id:notion-client-secret").toString("base64")}`,
    );
  });

  it("refuses to sign anyone in", async () => {
    const auth = newAuth();

    const response = await post(auth, "/sign-in/social", { provider: "notion" });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(cookieOf(response)).not.toContain("session_token");
  });
});
