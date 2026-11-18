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

// Stands in for GitHub: its token endpoint hands out the next token, `/user` is one fixed account.
// Every other request goes to the real fetch.
function fakeGithub(profile: { id: number; email: string | null }, tokens: string[]) {
  const real = globalThis.fetch;
  const tokenRequests: URLSearchParams[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      return json({ access_token: tokens.shift(), token_type: "bearer", scope: "repo" });
    }
    if (url === "https://api.github.com/user") {
      return json({ ...profile, login: "octo", name: "Octo", avatar_url: null });
    }
    if (url === "https://api.github.com/user/emails") {
      return json(profile.email ? [{ email: profile.email, primary: true, verified: true }] : []);
    }
    return real(input, init);
  });
  return tokenRequests;
}

async function authorizeUrl(auth: Auth, path: string, body: unknown, cookie?: string) {
  const started = await post(auth, path, body, cookie);
  const { url } = (await started.json()) as { url: string };
  return {
    authorize: new URL(url),
    cookie: [cookie, cookieOf(started)].filter(Boolean).join("; "),
  };
}

async function finish(auth: Auth, provider: string, authorize: URL, cookie: string) {
  const callback = new URL(`${BASE}/api/auth/callback/${provider}`);
  callback.searchParams.set("code", "code-1");
  callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
  return auth.handler(new Request(callback, { headers: { cookie } }));
}

async function linkConnection(auth: Auth, cookie: string, githubId = 42) {
  const { authorize, cookie: cookies } = await authorizeUrl(
    auth,
    "/link-social",
    { provider: "github-connection", callbackURL: "/c" },
    cookie,
  );
  fakeGithub({ id: githubId, email: null }, ["gho_connection_token"]);
  return finish(auth, "github-connection", authorize, cookies);
}

const connectionRows = (userId: string) =>
  database
    .select()
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github-connection")));

describe("the github-connection provider", () => {
  it.each([
    ["neither GitHub variable is set", { ...env, GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" }],
    ["only the secret is set", { ...env, GITHUB_CLIENT_ID: "" }],
  ])("does not exist when %s", async (_name, config) => {
    const auth = newAuth(config);
    const { cookie } = await signedIn(auth, `absent-${randomUUID()}@example.com`);

    const response = await post(auth, "/link-social", { provider: "github-connection" }, cookie);

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("starts the link at GitHub with the sign-in client, the three scopes and its own callback", async () => {
    const auth = newAuth();
    const { cookie } = await signedIn(auth, `start-${randomUUID()}@example.com`);

    const { authorize } = await authorizeUrl(
      auth,
      "/link-social",
      { provider: "github-connection" },
      cookie,
    );

    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorize.searchParams.get("client_id")).toBe("test-github-client-id");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${BASE}/api/auth/callback/github-connection`,
    );
    expect(authorize.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "notifications",
      "read:org",
      "repo",
    ]);
  });

  it("links a GitHub account with no public email, the token stored encrypted", async () => {
    const auth = newAuth();
    const { cookie, userId } = await signedIn(auth, `link-${randomUUID()}@example.com`);

    const callback = await linkConnection(auth, cookie);

    expect(callback.headers.get("location")).not.toContain("error");
    const [linked] = await connectionRows(userId);
    expect(linked).toBeDefined();
    expect(linked.accountId).toBe("42");
    expect(linked.accessToken).toBeTruthy();
    expect(linked.accessToken).not.toBe("gho_connection_token");
    expect(await linkedAccessToken(auth, database, userId, "github-connection")).toMatchObject({
      status: "ok",
      accessToken: "gho_connection_token",
    });
  });

  it("refuses to sign anyone in, even a user whose email matches", async () => {
    const auth = newAuth();
    await signedIn(auth, `member-${randomUUID()}@example.com`);

    const response = await post(auth, "/sign-in/social", { provider: "github-connection" });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(cookieOf(response)).not.toContain("session_token");
  });

  it("is left as it is when the user signs in with GitHub", async () => {
    const auth = newAuth();
    const email = `both-${randomUUID()}@example.com`;
    const { cookie, userId } = await signedIn(auth, email);
    await linkConnection(auth, cookie);
    const [before] = await connectionRows(userId);

    const { authorize, cookie: cookies } = await authorizeUrl(auth, "/sign-in/social", {
      provider: "github",
      callbackURL: "/c",
    });
    fakeGithub({ id: 42, email }, ["gho_signin_token"]);
    const callback = await finish(auth, "github", authorize, cookies);

    expect(callback.headers.get("location")).not.toContain("error");
    const rows = await database.select().from(account).where(eq(account.userId, userId));
    expect(rows.map((row) => row.providerId).sort()).toEqual([
      "credential",
      "github",
      "github-connection",
    ]);
    const [after] = await connectionRows(userId);
    expect(after).toEqual(before);
  });

  it("is not a sign-in method: unlinking the last real one is refused while it stays", async () => {
    const auth = newAuth();
    const { cookie, userId } = await signedIn(auth, `last-${randomUUID()}@example.com`);
    await linkConnection(auth, cookie);
    const [credential] = await database
      .select()
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, "credential")));

    const response = await post(auth, "/unlink-account", { accountId: credential.id }, cookie);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(
      "FAILED_TO_UNLINK_LAST_ACCOUNT",
    );
  });

  it("can always be unlinked, and only its row goes", async () => {
    const auth = newAuth();
    const { cookie, userId } = await signedIn(auth, `unlink-${randomUUID()}@example.com`);
    await linkConnection(auth, cookie);
    const [linked] = await connectionRows(userId);

    const response = await post(auth, "/unlink-account", { accountId: linked.id }, cookie);

    expect(response.status).toBe(200);
    expect(await connectionRows(userId)).toHaveLength(0);
    expect(await linkedAccessToken(auth, database, userId, "github-connection")).toEqual({
      status: "none",
    });
  });
});
