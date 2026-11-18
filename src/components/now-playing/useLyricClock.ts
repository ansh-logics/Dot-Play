import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createLyricClock } from "./lyricClock";

/** The playback speed (1 = normal), so drawn time runs as fast as the song does. */
export const PlaybackRateContext = createContext(1);

/**
 * Playback time at animation-frame precision. The app polls the player every ~100ms, which is
 * too coarse for a smooth letter-by-letter sweep; this runs its own clock and steers it toward
 * each reading (see lyricClock.ts), so jitter, stalls and seeks never make the sweep jerk.
 */
export function useLyricClock(currentTime: number, isPlaying: boolean) {
  const rate = useContext(PlaybackRateContext);
  const [clock] = useState(() => createLyricClock(currentTime, performance.now()));

  useEffect(() => {
    clock.update(currentTime, isPlaying, rate, performance.now());
  }, [clock, currentTime, isPlaying, rate]);

  return useCallback(() => clock.now(performance.now()), [clock]);
}

/**
 * Runs `draw` every animation frame while `running`, and once whenever its
 * inputs change otherwise. Pauses automatically while the window is hidden.
 */
export function useFrameLoop(draw: () => void, running: boolean) {
  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
    draw();
  }, [draw]);

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const tick = () => {
      if (!document.hidden) drawRef.current();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);
}
