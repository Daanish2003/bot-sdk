import { createHash, randomBytes } from "node:crypto";

import type { AppDeps } from "../deps";
import { isAllowListed } from "../lib/guarded-fetch";
import type { McpServerConfig } from "./servers";

/** A sign-in that failed for a reason the user can read. The routes answer it as text. */
export class SignInError extends Error {}

export type Endpoints = { authorizationEndpoint: string; tokenEndpoint: string };

/** The token set an exchange returns, as the SDK stores it (encrypted). */
export type TokenSet = {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  expiresAt?: string;
  scope: string;
};

type Fetch = AppDeps["fetch"];

const random = (bytes: number) => randomBytes(bytes).toString("base64url");

/** A fresh `state` for one sign-in. */
export const newState = () => random(24);

/** A PKCE pair (RFC 7636, S256). */
export function newPkce() {
  const verifier = random(32);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function readJson(fetch: Fetch, url: URL): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) return null;
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** An endpoint must be HTTPS, or plain HTTP on a host the test allowance lists (`allowHosts`). */
function secureEndpoint(value: unknown, allowHosts: readonly string[]): string {
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (url.protocol === "https:") return value;
      if (url.protocol === "http:" && isAllowListed(url, allowHosts)) return value;
    } catch {
      // Not a URL: refused below.
    }
  }
  throw new SignInError("The server's sign-in endpoints aren't HTTPS URLs");
}

/**
 * Finds the authorize and token endpoints of an MCP server: its protected-resource metadata names
 * the authorization server (RFC 9728), whose metadata gives the endpoints (RFC 8414). Both requests
 * go through the guarded `fetch` (ADR, spec #91).
 */
export async function discoverEndpoints(
  server: McpServerConfig,
  fetch: Fetch,
  allowHosts: readonly string[] = [],
): Promise<Endpoints> {
  const resource = new URL(server.url);
  const protectedResource = await readJson(
    fetch,
    new URL("/.well-known/oauth-protected-resource", resource.origin),
  );
  const issuer = new URL(
    (Array.isArray(protectedResource?.authorization_servers) &&
      typeof protectedResource.authorization_servers[0] === "string" &&
      protectedResource.authorization_servers[0]) ||
      resource.origin,
  );
  // The guarded fetch also allows HTTP, and the issuer comes from the server's own metadata.
  secureEndpoint(issuer.href, allowHosts);
  const path = issuer.pathname.replace(/\/+$/, "");
  const metadata =
    (await readJson(
      fetch,
      new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin),
    )) ??
    (await readJson(fetch, new URL(`/.well-known/openid-configuration${path}`, issuer.origin)));
  if (!metadata) throw new SignInError("The server doesn't publish its sign-in details");
  return {
    authorizationEndpoint: secureEndpoint(metadata.authorization_endpoint, allowHosts),
    tokenEndpoint: secureEndpoint(metadata.token_endpoint, allowHosts),
  };
}

/** The authorize URL for one sign-in, with the Host's pre-registered client and PKCE (RFC 7636). */
export function authorizeUrl({
  endpoints,
  server,
  redirectUri,
  state,
  challenge,
}: {
  endpoints: Endpoints;
  server: McpServerConfig;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", server.oauth.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", server.url);
  return url.toString();
}

/** Trades the authorization code for tokens, with the client secret in Basic auth (RFC 6749 §2.3.1). */
export async function exchangeCode({
  fetch,
  server,
  tokenEndpoint,
  code,
  redirectUri,
  verifier,
}: {
  fetch: Fetch;
  server: McpServerConfig;
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<TokenSet> {
  const basic = Buffer.from(
    `${encodeURIComponent(server.oauth.clientId)}:${encodeURIComponent(server.oauth.clientSecret)}`,
  ).toString("base64");
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: server.url,
    }),
  });
  const body = response.ok ? await response.json().catch(() => null) : null;
  if (typeof body?.access_token !== "string" || body.access_token === "") {
    throw new SignInError("The server refused the sign-in");
  }
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
      : {}),
    scope: typeof body.scope === "string" ? body.scope : "",
  };
}

/**
 * Trades a refresh token for a new access token (RFC 6749 §6), with the same client as the
 * sign-in. The server may omit a new refresh token, which keeps the old one (the caller's job).
 * Throws `SignInError` when the server refuses, so the Connection can be marked for reconnection.
 */
export async function refreshAccess({
  fetch,
  server,
  tokenEndpoint,
  refreshToken,
  scope,
}: {
  fetch: Fetch;
  server: McpServerConfig;
  tokenEndpoint: string;
  refreshToken: string;
  scope: string;
}): Promise<TokenSet> {
  const basic = Buffer.from(
    `${encodeURIComponent(server.oauth.clientId)}:${encodeURIComponent(server.oauth.clientSecret)}`,
  ).toString("base64");
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      resource: server.url,
    }),
  });
  const body = response.ok ? await response.json().catch(() => null) : null;
  if (typeof body?.access_token !== "string" || body.access_token === "") {
    throw new SignInError("The server refused the refresh");
  }
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : refreshToken,
    ...(Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
      : {}),
    scope: typeof body.scope === "string" ? body.scope : scope,
  };
}
