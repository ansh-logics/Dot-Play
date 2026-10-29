import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Social cards need absolute URLs. On Vercel the production domain comes from
 * VERCEL_PROJECT_PRODUCTION_URL; SITE_URL overrides it (e.g. for a custom domain).
 */
function siteUrl(): Plugin {
  const host = process.env.SITE_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const origin = host ? (host.startsWith("http") ? host : `https://${host}`).replace(/\/$/, "") : "";
  return { name: "site-url", transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", origin) };
}

/**
 * The site itself is plain React with static product shots. Those shots come from two dev-only
 * pages under /embed/ that render the app's real components (from ../src) with a stand-in for
 * the Tauri bridge (src/embed/tauriMock.ts); `npm run capture` screenshots them.
 */
export default defineConfig({
  plugins: [react(), siteUrl()],
  resolve: {
    alias: [
      { find: "@app", replacement: here("../src") },
      { find: /^@tauri-apps\/api\/(core|event)$/, replacement: here("./src/embed/tauriMock.ts") },
    ],
    // App files live outside this project; make every shared package resolve to one copy here.
    dedupe: ["react", "react-dom", "motion", "lucide-react"],
  },
  server: { port: 5810, fs: { allow: [here("..")] } },
});
