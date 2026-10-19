import evlog from "evlog/nitro/v3";
import { defineConfig } from "nitro";

export default defineConfig({
  serverDir: "./server",
  // The live view's socket (#597), server/routes/api/screens/[token]/websockify.ts.
  features: {
    websocket: true,
  },
  experimental: {
    asyncContext: true,
  },
  modules: [
    evlog({
      env: { service: "ai-chat-web" },
    }),
  ],
});
