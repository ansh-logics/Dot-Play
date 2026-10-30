import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const IS_WINDOWS = navigator.userAgent.includes("Windows");

/**
 * Real (OS) full screen for the Now Playing view: no taskbar or menu bar. On Windows the view
 * enters it on open, the way Spotify's does; elsewhere it is the view's button. Full screen
 * this view turned on is turned off again when it closes.
 */
export function useWindowFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** Whether this view put the window into full screen (and so must take it out). */
  const enteredRef = useRef(false);

  const setFullscreen = useCallback(async (on: boolean) => {
    try {
      await getCurrentWindow().setFullscreen(on);
      enteredRef.current = on;
      setIsFullscreen(on);
    } catch {
      // Not running in the app (plain browser) or not permitted: stay windowed.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getCurrentWindow()
      .isFullscreen()
      .then((already) => {
        if (cancelled) return;
        setIsFullscreen(already);
        if (!already && IS_WINDOWS) void setFullscreen(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (enteredRef.current) {
        enteredRef.current = false;
        getCurrentWindow().setFullscreen(false).catch(() => {});
      }
    };
  }, [setFullscreen]);

  const toggleFullscreen = useCallback(() => setFullscreen(!isFullscreen), [isFullscreen, setFullscreen]);

  return { isFullscreen, toggleFullscreen };
}
