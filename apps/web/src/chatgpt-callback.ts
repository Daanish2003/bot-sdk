// ChatGPT's client is registered with the redirect `<BETTER_AUTH_URL>/auth/callback`, but Better
// Auth's Generic OAuth callback for the `chatgpt` provider is `/api/auth/callback/chatgpt`. The query
// string (code, state, scope, client_id) goes across unchanged.
export function chatgptCallbackRedirect(request: Request): Response {
  const url = new URL(request.url);
  return Response.redirect(new URL(`/api/auth/callback/chatgpt${url.search}`, url.origin), 302);
}
