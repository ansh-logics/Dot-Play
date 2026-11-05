/**
 * A browser stand-in for `@tauri-apps/api/window` (aliased in vite.config.ts): the website's
 * player is never full screen, and the window calls Now Playing makes just do nothing.
 */
const appWindow = {
  isFullscreen: async () => false,
  setFullscreen: async (_on: boolean) => {},
  minimize: async () => {},
  onResized: async (_handler: () => void) => () => {},
};

export function getCurrentWindow() {
  return appWindow;
}
