import { useCallback, useEffect, useRef } from "react";

/**
 * Playback time at animation-frame precision. The app polls the player every
 * ~100ms, which is too coarse for a smooth letter-by-letter sweep, so this
 * interpolates between polls and rebases whenever a new reading arrives
 * (which also absorbs seeks and buffering stalls).
 */
export function useLyricClock(currentTime: number, isPlaying: boolean) {
  // Real timestamp is taken in the effect below (it runs on mount too).
  const anchor = useRef({ base: currentTime, at: 0, playing: false });

  useEffect(() => {
    const prev = anchor.current;
    const predicted = prev.playing ? prev.base + (performance.now() - prev.at) / 1000 : prev.base;
    // The interpolated clock runs slightly ahead of the ~100ms polls, so a new reading (or a
    // pause, which freezes on the last poll) can be a little behind it. Stepping back would make
    // the sweep flick backwards; only accept going back on a real seek (> 0.35s).
    const smallStepBack = currentTime < predicted && predicted - currentTime < 0.35;
    const base = prev.playing && smallStepBack ? predicted : currentTime;
    anchor.current = { base, at: performance.now(), playing: isPlaying };
  }, [currentTime, isPlaying]);

  const now = useCallback(() => {
    const a = anchor.current;
    return a.playing ? a.base + (performance.now() - a.at) / 1000 : a.base;
  }, []);

  return now;
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
