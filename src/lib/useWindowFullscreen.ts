import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const IS_WINDOWS = navigator.userAgent.includes("Windows");
/** False when the view runs in a plain browser (the website's embedded player). */
const IN_APP = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/** macOS animates into and out of full screen, resizing the window many times on the way and
 *  reporting "not full screen" partway through; ask only once the resizing has stopped. */
const SETTLE_MS = 450;

/**
 * Real (OS) full screen for the Now Playing view: no taskbar or menu bar. On Windows the view
 * enters it on open, the way Spotify's does; elsewhere it is the view's button. Full screen
 * this view turned on is turned off again when it closes.
 *
 * The state follows the window, not just this hook: full screen can also end through the
 * system (the green button, ⌃⌘F, minimising and restoring), and the button must not then
 * need two clicks.
 */
export function useWindowFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** Whether this view put the window into full screen, and so takes it out on close. Never
   *  cleared by the resize sync: leaving full screen on close is harmless when it already ended. */
  const enteredRef = useRef(false);

  const setFullscreen = useCallback(async (on: boolean) => {
    if (!IN_APP) return;
    try {
      await getCurrentWindow().setFullscreen(on);
      enteredRef.current = on;
      setIsFullscreen(on);
    } catch {
      // Not running in the app (plain browser) or not permitted: stay windowed.
    }
  }, []);

  useEffect(() => {
    if (!IN_APP) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let settleTimer: number | undefined;
    const win = getCurrentWindow();

    const sync = () => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        win
          .isFullscreen()
          .then((on) => !cancelled && setIsFullscreen(on))
          .catch(() => {});
      }, SETTLE_MS);
    };

    win
      .isFullscreen()
      .then((already) => {
        if (cancelled) return;
        setIsFullscreen(already);
        if (!already && IS_WINDOWS) void setFullscreen(true);
      })
      .catch(() => {});
    // Entering or leaving full screen always resizes the window.
    win
      .onResized(sync)
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch(() => {});

    return () => {
      cancelled = true;
      window.clearTimeout(settleTimer);
      unlisten?.();
      if (enteredRef.current) {
        enteredRef.current = false;
        win.setFullscreen(false).catch(() => {});
      }
    };
  }, [setFullscreen]);

  /** Asks the window, so a stale state can never turn a click into a no-op. */
  const toggleFullscreen = useCallback(async () => {
    if (!IN_APP) return;
    const on = await getCurrentWindow().isFullscreen().catch(() => isFullscreen);
    await setFullscreen(!on);
  }, [isFullscreen, setFullscreen]);

  const exitFullscreen = useCallback(() => setFullscreen(false), [setFullscreen]);

  return { isFullscreen, toggleFullscreen, exitFullscreen };
}
