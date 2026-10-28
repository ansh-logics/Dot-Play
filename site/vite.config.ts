import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The site itself is plain React with static product shots. Those shots come from two dev-only
 * pages under /embed/ that render the app's real components (from ../src) with a stand-in for
 * the Tauri bridge (src/embed/tauriMock.ts); `npm run capture` screenshots them.
 */
export default defineConfig({
  plugins: [react()],
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
