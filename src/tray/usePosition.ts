import { useEffect, useState } from "react";
import type { NowPlaying } from "./types";

/**
 * Elapsed time, extrapolated from the last sample while playing (as macOS does), so the
 * main window never has to stream the position. Re-renders ~4×/s only while playing;
 * requestAnimationFrame stops on its own while the popover is hidden.
 */
export function usePosition(np: NowPlaying | null): number {
  const [now, setNow] = useState(() => Date.now());
  const playing = np?.isPlaying ?? false;

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = 0;
    const tick = (t: number) => {
      if (t - last > 250) {
        last = t;
        setNow(Date.now());
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  if (!np) return 0;
  const elapsed = np.isPlaying ? (Math.max(now, np.updatedAtMs) - np.updatedAtMs) / 1000 : 0;
  const t = np.position + elapsed;
  return np.duration > 0 ? Math.min(t, np.duration) : t;
}
