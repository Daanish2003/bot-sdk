// ChatGPT's client is registered with the redirect `http://127.0.0.1:<port>/auth/callback`, but the
// app runs on `BETTER_AUTH_URL` (localhost), where the session and state cookies live. This route
// bounces the redirect back to Better Auth's callback for the `chatgpt` provider on that origin. The
// query string (code, state, scope, client_id) goes across unchanged.
export function chatgptCallbackRedirect(request: Request, baseUrl: string): Response {
  const { search } = new URL(request.url);
  return Response.redirect(new URL(`/api/auth/callback/chatgpt${search}`, baseUrl), 302);
}
