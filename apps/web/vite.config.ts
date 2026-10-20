import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { varlockVitePlugin } from "@varlock/vite-integration";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3001,
    // IPv4: ChatGPT's sign-in redirects to 127.0.0.1 (ADR 0023), and on Windows `localhost` alone
    // binds only ::1. Browsers reach `localhost` through it too.
    host: "127.0.0.1",
  },
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    // The Browser tool (#594) imports playwright-core, which cannot be bundled (chromium-bidi). The
    // client graph reaches it through services.ts but never runs it; Nitro traces it for the server.
    rolldownOptions: { external: ["playwright-core"] },
  },
  plugins: [
    varlockVitePlugin({ ssrInjectMode: "auto-load" }),
    tailwindcss(),
    tanstackStart(),
    nitro({ preset: "node-server" }),
    viteReact(),
  ],
});
