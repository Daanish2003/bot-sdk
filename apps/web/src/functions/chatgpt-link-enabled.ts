import { createServerFn } from "@tanstack/react-start";

// Whether the Keys page offers Connect ChatGPT: the settings are the Host's, so the browser asks.
export const getChatgptLinkEnabled = createServerFn({ method: "GET" }).handler(async () => {
  const { chatgptLinkEnabled } = await import("@/chatgpt-link");
  const { ENV } = await import("@/env.server");
  return chatgptLinkEnabled(ENV);
});
