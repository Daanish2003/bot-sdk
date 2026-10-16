import { createHash, randomBytes } from "node:crypto";

/**
 * A fake MCP server's OAuth authorization server, served through an injected `fetch` (never the
 * network). It knows one pre-registered client and checks the PKCE verifier and the redirect URI
 * on the code exchange. `approve` plays the browser's part: it takes the authorize URL the SDK
 * redirected to and returns the callback URL the server would redirect back to.
 */
export type FakeMcpAuth = {
  fetch: typeof globalThis.fetch;
  /** The `resource` the protected-resource metadata names, for tests that check it. */
  resource: string;
  approve: (authorizeUrl: string, options?: { deny?: boolean }) => string;
  /** Every token request the server answered, for checks on what the SDK sent. */
  tokenRequests: Array<Record<string, string>>;
  /** Whether the fake MCP server accepts this access token: one the server issued and has not revoked. */
  accepts: (accessToken: string) => boolean;
  /** Revokes a refresh token, so the next refresh with it is refused. */
  revokeRefresh: (refreshToken: string) => void;
};

export const fakeMcpResource = "https://mcp.test/mcp";
const defaultAuthOrigin = "https://auth.test";

/**
 * `resource` and `authOrigin` default to the unit tests' origins. The end-to-end tests serve the
 * resource and the authorization server from one localhost origin, over real HTTP.
 */
export function createFakeMcpAuth({
  clientId,
  clientSecret,
  scope = "read:issues write:issues",
  resource = fakeMcpResource,
  authOrigin = defaultAuthOrigin,
}: {
  clientId: string;
  clientSecret: string;
  scope?: string;
  resource?: string;
  authOrigin?: string;
}): FakeMcpAuth {
  const resourceOrigin = new URL(resource).origin;
  // code -> what the authorize step bound it to
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const tokenRequests: Array<Record<string, string>> = [];
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  let counter = 0;
  const issue = () => {
    counter += 1;
    const accessToken = `access-token-${counter}-${randomBytes(12).toString("hex")}`;
    const refreshToken = `refresh-token-${counter}`;
    accessTokens.add(accessToken);
    refreshTokens.add(refreshToken);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      refresh_token: refreshToken,
      expires_in: 3600,
      scope,
    };
  };

  const json = (body: unknown, status = 200) => Response.json(body, { status });

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const method = request.method;

    if (url.origin === resourceOrigin && url.pathname === "/.well-known/oauth-protected-resource") {
      return json({ resource, authorization_servers: [authOrigin] });
    }
    if (url.origin === authOrigin && url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: authOrigin,
        authorization_endpoint: `${authOrigin}/authorize`,
        token_endpoint: `${authOrigin}/token`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.origin === authOrigin && url.pathname === "/token" && method === "POST") {
      const form = Object.fromEntries(new URLSearchParams(await request.text())) as Record<
        string,
        string
      >;
      tokenRequests.push(form);
      const basic = request.headers.get("authorization") ?? "";
      const expected = `Basic ${Buffer.from(
        `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
      ).toString("base64")}`;
      if (basic !== expected) return json({ error: "invalid_client" }, 401);
      if (form.grant_type === "refresh_token") {
        if (!refreshTokens.has(form.refresh_token ?? ""))
          return json({ error: "invalid_grant" }, 400);
        return json(issue());
      }
      const bound = codes.get(form.code ?? "");
      codes.delete(form.code ?? "");
      if (!bound) return json({ error: "invalid_grant" }, 400);
      const verifier = form.code_verifier ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (challenge !== bound.challenge || form.redirect_uri !== bound.redirectUri) {
        return json({ error: "invalid_grant" }, 400);
      }
      return json(issue());
    }
    return new Response("Not found", { status: 404 });
  };

  return {
    fetch,
    resource,
    tokenRequests,
    accepts: (accessToken) => accessTokens.has(accessToken),
    revokeRefresh: (refreshToken) => {
      refreshTokens.delete(refreshToken);
    },
    approve: (authorizeUrl, options) => {
      const url = new URL(authorizeUrl);
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const callback = new URL(redirectUri);
      if (options?.deny) {
        callback.searchParams.set("error", "access_denied");
      } else {
        const code = randomBytes(16).toString("hex");
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge") ?? "",
          redirectUri,
        });
        callback.searchParams.set("code", code);
      }
      callback.searchParams.set("state", state);
      return callback.toString();
    },
  };
}
