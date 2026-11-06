import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Social cards need absolute URLs. On Vercel the production domain comes from
 * VERCEL_PROJECT_PRODUCTION_URL; SITE_URL overrides it (e.g. for a custom domain).
 */
const DEFAULT_SITE = "https://dot-music.anshbhatt.space";

function siteUrl(): Plugin {
  // Without an absolute origin, og:image would be "/og.png", which social sites reject.
  const host = process.env.SITE_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL ?? DEFAULT_SITE;
  const origin = (host.startsWith("http") ? host : `https://${host}`).replace(/\/$/, "");
  return { name: "site-url", transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", origin) };
}

/**
 * The site itself is plain React with static product shots. Those shots come from two dev-only
 * pages under /embed/ that render the app's real components (from ../src) with a stand-in for
 * the Tauri bridge (src/embed/tauriMock.ts); `npm run capture` screenshots them.
 */
/**
 * The Phone Remote capture page renders the real remote page (../src/remote) without a relay:
 * its connection hook is swapped for a stand-in with a song, a queue and search results.
 */
function remoteMock(): Plugin {
  const mock = here("./src/embed/remoteMock.ts");
  return {
    name: "remote-mock",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "./useRemoteState" && importer?.includes("/src/remote/")) return mock;
      return null;
    },
  };
}

export default defineConfig({
  plugins: [react(), siteUrl(), remoteMock()],
  resolve: {
    alias: [
      { find: "@app", replacement: here("../src") },
      { find: /^@tauri-apps\/api\/(core|event)$/, replacement: here("./src/embed/tauriMock.ts") },
      { find: /^@tauri-apps\/api\/window$/, replacement: here("./src/embed/tauriWindowMock.ts") },
    ],
    // App files live outside this project; make every shared package resolve to one copy here.
    dedupe: ["react", "react-dom", "motion", "lucide-react"],
  },
  server: { port: 5810, fs: { allow: [here("..")] } },
});
