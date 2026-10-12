import type { AppDeps } from "../deps";
import { beginSignIn, claimSignIn, saveTokens } from "./connections";
import {
  authorizeUrl,
  discoverEndpoints,
  exchangeCode,
  newPkce,
  newState,
  SignInError,
} from "./oauth";

type Deps = Pick<
  AppDeps,
  "db" | "keyEncryptionSecrets" | "mcpServers" | "fetch" | "fetchAllowHosts"
>;

const text = (message: string, status: number) =>
  new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** Only a path on this app: an absolute or protocol-relative URL would send the user elsewhere. */
function safeReturnTo(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")
    ? value
    : "/";
}

/**
 * Starts a sign-in to one of the Host's MCP servers: discovers its endpoints, records the PKCE
 * verifier and `state`, and redirects the user agent to the authorize endpoint (spec #91).
 */
export async function connectRoute(
  request: Request,
  userId: string,
  deps: Deps,
  redirectUri: string,
) {
  const url = new URL(request.url);
  const server = deps.mcpServers.find(
    (candidate) => candidate.key === url.searchParams.get("server"),
  );
  if (!server) return text("Unknown MCP server", 404);
  let endpoints;
  try {
    endpoints = await discoverEndpoints(server, deps.fetch, deps.fetchAllowHosts);
  } catch (caught) {
    const message =
      caught instanceof SignInError ? caught.message : "Couldn't reach the server to sign in";
    return text(message, 502);
  }
  const { verifier, challenge } = newPkce();
  const state = newState();
  await beginSignIn(deps, userId, server.key, {
    state,
    verifier,
    returnTo: safeReturnTo(url.searchParams.get("returnTo")),
    tokenEndpoint: endpoints.tokenEndpoint,
  });
  return Response.redirect(authorizeUrl({ endpoints, server, redirectUri, state, challenge }), 302);
}

/**
 * Finishes a sign-in: takes the pending one whose `state` came back, exchanges the code for tokens,
 * stores the Connection and redirects to the page the sign-in began on.
 */
export async function callbackRoute(
  request: Request,
  userId: string,
  deps: Deps,
  redirectUri: string,
) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state) return text("This sign-in link is incomplete", 400);
  const pending = await claimSignIn(deps, userId, state);
  if (!pending) {
    return text(
      "This sign-in has expired or was already used. Start it again from Keys & settings.",
      400,
    );
  }
  const server = deps.mcpServers.find((candidate) => candidate.key === pending.serverKey);
  if (!server) return text("Unknown MCP server", 404);
  if (url.searchParams.has("error") || !code) {
    return text("The server didn't complete the sign-in", 400);
  }
  try {
    const tokens = await exchangeCode({
      fetch: deps.fetch,
      server,
      tokenEndpoint: pending.tokenEndpoint,
      code,
      redirectUri,
      verifier: pending.verifier,
    });
    await saveTokens(deps, userId, server.key, tokens);
  } catch (caught) {
    const message =
      caught instanceof SignInError
        ? caught.message
        : "Couldn't reach the server to finish the sign-in";
    return text(message, 502);
  }
  // A relative Location: the page is on this app, and the request's origin may be an internal one.
  return new Response(null, { status: 302, headers: { location: pending.returnTo } });
}
