/**
 * Playback speed and the sleep timer: the pure parts, kept out of usePlayback so they can be
 * tested on their own.
 */

/** Speeds offered. YouTube's player accepts 0.25–2; below 0.5 music is rarely useful. */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

const RATE_KEY = "dot_playback_rate";

/** The nearest offered speed, so a stored or remote value can't set something odd. */
export function normalizeRate(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return PLAYBACK_RATES.reduce((best, r) => (Math.abs(r - n) < Math.abs(best - n) ? r : best), 1);
}

export function loadPlaybackRate(): number {
  try {
    const raw = localStorage.getItem(RATE_KEY);
    return raw === null ? 1 : normalizeRate(Number(raw));
  } catch {
    return 1;
  }
}

export function savePlaybackRate(rate: number): void {
  try {
    if (rate === 1) localStorage.removeItem(RATE_KEY);
    else localStorage.setItem(RATE_KEY, String(rate));
  } catch {
    // Storage unavailable: the speed lasts for this session.
  }
}

/** "1×", "1.25×", "0.5×". */
export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

/**
 * The sleep timer: stop at a moment on the wall clock, or when the current song ends.
 * A deadline (not a countdown) so a Mac that sleeps or a throttled timer can't stretch it.
 */
export type SleepTimer = { kind: "at"; deadline: number; minutes: number } | { kind: "endOfTrack" } | null;

export const SLEEP_PRESETS_MIN = [15, 30, 45, 60] as const;
/** The volume fades out over the last stretch before the timer stops playback. */
export const SLEEP_FADE_MS = 30_000;

export function sleepAfter(minutes: number, now = Date.now()): SleepTimer {
  const m = Math.max(1, Math.min(12 * 60, Math.round(minutes)));
  return { kind: "at", deadline: now + m * 60_000, minutes: m };
}

/** Milliseconds left on a timed sleep timer; null for none or "end of song". */
export function sleepRemainingMs(timer: SleepTimer, now = Date.now()): number | null {
  return timer?.kind === "at" ? Math.max(0, timer.deadline - now) : null;
}

/**
 * Volume multiplier for the fade before a timed stop: 1 until the last SLEEP_FADE_MS, then
 * an ease down to 0 (equal-power, so it sounds even rather than dropping off at the end).
 */
export function sleepFadeGain(remainingMs: number | null): number {
  if (remainingMs === null || remainingMs >= SLEEP_FADE_MS) return 1;
  if (remainingMs <= 0) return 0;
  return Math.sin((remainingMs / SLEEP_FADE_MS) * (Math.PI / 2));
}

/** "28 min", "4:05", "0:09": minutes while long, then minutes and seconds. */
export function formatSleepRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  if (total >= 10 * 60) return `${Math.ceil(total / 60)} min`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
