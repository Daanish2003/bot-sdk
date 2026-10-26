import evlog from "evlog/nitro/v3";
import { defineConfig } from "nitro";

export default defineConfig({
  serverDir: "./server",
  // The live view's socket (#597), server/routes/api/chat/screens/[token]/websockify.ts.
  features: {
    websocket: true,
  },
  // playwright-core is external (vite.config.ts); copy it into .output so the built server loads it.
  // nf3 finds it through @ai-chat/bot-sdk/package.json, which the SDK exports for this.
  traceDeps: ["playwright-core"],
  experimental: {
    asyncContext: true,
  },
  modules: [
    evlog({
      env: { service: "ai-chat-web" },
    }),
  ],
});
