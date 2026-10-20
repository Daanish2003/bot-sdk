import { describe, expect, it } from "vitest";

import { chatgptCallbackRedirect } from "./chatgpt-callback";

describe("chatgptCallbackRedirect", () => {
  it("sends ChatGPT's redirect to Better Auth's chatgpt callback with the query string unchanged", () => {
    const query = "?code=abc%2F123&scope=openid+profile&state=s%3D1&client_id=oaiapp_x";

    const response = chatgptCallbackRedirect(
      new Request(`http://127.0.0.1:3001/auth/callback${query}`),
      "http://localhost:3001",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `http://localhost:3001/api/auth/callback/chatgpt${query}`,
    );
  });

  it("sends a callback with no query as it is", () => {
    const response = chatgptCallbackRedirect(
      new Request("http://127.0.0.1:3001/auth/callback"),
      "http://localhost:3001",
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3001/api/auth/callback/chatgpt",
    );
  });
});
