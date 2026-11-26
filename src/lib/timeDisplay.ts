import { useSyncExternalStore } from "react";
import { formatTime } from "./formatTime";

/** What a seek bar shows on the right: the song's length, or the time left. */
export type TimeDisplay = "total" | "remaining";

const STORAGE_KEY = "dot_time_display_v1";
export const DEFAULT_TIME_DISPLAY: TimeDisplay = "total";

function loadTimeDisplay(): TimeDisplay {
  try {
    return localStorage.getItem(STORAGE_KEY) === "remaining" ? "remaining" : DEFAULT_TIME_DISPLAY;
  } catch {
    return DEFAULT_TIME_DISPLAY;
  }
}

const listeners = new Set<() => void>();
let current: TimeDisplay | null = null;

/** The chosen display, read from storage once and then kept in memory. */
export function getTimeDisplay(): TimeDisplay {
  current ??= loadTimeDisplay();
  return current;
}

export function saveTimeDisplay(display: TimeDisplay): void {
  current = display;
  try {
    localStorage.setItem(STORAGE_KEY, display);
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
  listeners.forEach((fn) => fn());
}

/** Flips between the length and the time left, and remembers the choice. */
export function toggleTimeDisplay(): void {
  saveTimeDisplay(getTimeDisplay() === "total" ? "remaining" : "total");
}

/** Notifies when the display is changed in this window (every seek bar follows it). */
export function subscribeTimeDisplay(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The shared display choice, so every seek bar flips together. */
export function useTimeDisplay(): [TimeDisplay, () => void] {
  const display = useSyncExternalStore(subscribeTimeDisplay, getTimeDisplay);
  return [display, toggleTimeDisplay];
}

/** "-2:31": the time left, never counting below zero. */
export function formatRemaining(duration: number, current: number): string {
  return `-${formatTime(Math.max(0, duration - current))}`;
}
