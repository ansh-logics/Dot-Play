import { useSyncExternalStore } from "react";

/**
 * Crossfade between songs: the setting, and the timing and volume maths usePlayback uses.
 *
 * The rules a transition follows (the way BitChord, Spotify and Apple Music do it):
 *  1. A little before the fade, the next song is loaded on the second hidden player, silently,
 *     and buffered at its start, so it can sound the moment it's asked to.
 *  2. The fade starts only once that song is ready. Its volume rises from 0 while the current
 *     song's falls, on an equal-power curve, so the two overlap with no dip in the middle.
 *  3. The fade's progress follows how far the incoming song has actually played, so a slow
 *     start holds the blend instead of fading the current song out over silence. It is pushed
 *     on only when the current song is about to run out.
 *  4. Halfway, where both are equally loud, the incoming song becomes the current one: title,
 *     artwork, lyrics, progress bar. Before that the screen stays on the song still playing.
 *  5. When the fade completes, the old song stops and the two players swap roles.
 */

/** Seconds offered; 0 is off. */
export const CROSSFADE_CHOICES = [0, 3, 6, 9, 12] as const;
export type CrossfadeSeconds = (typeof CROSSFADE_CHOICES)[number];

/** The next song is cued this long before its fade starts, so it can begin at once. */
export const PREPARE_LEAD_S = 15;
/** Where in the fade the incoming song becomes the current one (both equally loud). */
export const HANDOFF_AT = 0.5;
/** Hand over early if the outgoing song has less than this left, before it ends by itself. */
export const HANDOFF_GUARD_S = 0.4;
/** Songs shorter than this play to the end on their own. */
export const MIN_CROSSFADE_TRACK_S = 30;
/** How often the volumes are stepped (the player only takes whole numbers 0–100). */
export const FADE_STEP_MS = 50;

const STORAGE_KEY = "dot_crossfade_s";

export function normalizeCrossfade(value: unknown): CrossfadeSeconds {
  const n = Number(value);
  return (CROSSFADE_CHOICES as readonly number[]).includes(n) ? (n as CrossfadeSeconds) : 0;
}

function load(): CrossfadeSeconds {
  try {
    return normalizeCrossfade(localStorage.getItem(STORAGE_KEY) ?? 0);
  } catch {
    return 0;
  }
}

let current = load();
const listeners = new Set<() => void>();

export function getCrossfadeSeconds(): CrossfadeSeconds {
  return current;
}

export function setCrossfadeSeconds(seconds: CrossfadeSeconds): void {
  current = normalizeCrossfade(seconds);
  try {
    if (current === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(current));
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
  listeners.forEach((fn) => fn());
}

export function useCrossfadeSeconds(): CrossfadeSeconds {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}

/** Volumes for the outgoing and incoming song at `progress` (0→1), scaled to `volume`. */
export function crossfadeVolumes(progress: number, volume: number): { outgoing: number; incoming: number } {
  const p = Math.min(1, Math.max(0, progress));
  return {
    outgoing: Math.round(volume * Math.cos((p * Math.PI) / 2)),
    incoming: Math.round(volume * Math.sin((p * Math.PI) / 2)),
  };
}

/** Real seconds left in the song (playback speed counts: at 2× a minute lasts 30 s). */
export function secondsLeft(position: number, duration: number, rate: number): number {
  if (!(duration > 0)) return Infinity;
  return Math.max(0, duration - position) / (rate > 0 ? rate : 1);
}

export type CrossfadeStep = "wait" | "prepare" | "fade";

/** What to do now: nothing yet, cue the next song, or start fading into it. */
export function crossfadeStep(options: { fade: number; position: number; duration: number; rate: number }): CrossfadeStep {
  const { fade, position, duration, rate } = options;
  if (fade <= 0 || !(duration >= MIN_CROSSFADE_TRACK_S)) return "wait";
  const left = secondsLeft(position, duration, rate);
  if (left <= fade) return "fade";
  if (left <= fade + PREPARE_LEAD_S) return "prepare";
  return "wait";
}

/** The fade's length: the setting, shortened so it never covers more than a third of a short next song. */
export function fadeSpan(fade: number, incomingDuration: number): number {
  const cap = incomingDuration > 0 ? incomingDuration / 3 : Infinity;
  return Math.max(0.5, Math.min(fade, cap));
}

/**
 * How far through the fade (0→1): how long the incoming song has really played, or, if the
 * outgoing song is about to run out first, enough to bring it to silence by its end.
 */
export function fadeProgress(options: { incomingPlayed: number; outgoingLeft: number; span: number }): number {
  const { incomingPlayed, outgoingLeft, span } = options;
  const byIncoming = incomingPlayed / span;
  const byEnd = Number.isFinite(outgoingLeft) ? (span - outgoingLeft) / span : 0;
  return Math.min(1, Math.max(0, byIncoming, byEnd));
}
