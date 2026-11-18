/**
 * Per-song lyrics timing nudges, for songs whose synced lyrics run a little early or late.
 * Positive values show the lyrics sooner. Kept in localStorage by video id.
 */

const STORAGE_KEY = "dot_lyrics_offset_v1";
/** Songs remembered; the oldest nudge is dropped first. */
const MAX_SONGS = 500;
export const OFFSET_STEP_S = 0.1;
export const MAX_OFFSET_S = 5;

type OffsetMap = Record<string, number>;

/** Rounds to the step (no float dust like 0.30000000000000004) and keeps within ±5 s. */
export function clampOffset(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  const stepped = Math.round(seconds / OFFSET_STEP_S) * OFFSET_STEP_S;
  return Math.max(-MAX_OFFSET_S, Math.min(MAX_OFFSET_S, Number(stepped.toFixed(1))));
}

export function readOffsets(storage: Pick<Storage, "getItem"> = localStorage): OffsetMap {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: OffsetMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value !== 0) out[key] = clampOffset(value);
    }
    return out;
  } catch {
    return {};
  }
}

/** The map with `key` set (0 removes it), newest last, trimmed to the newest MAX_SONGS. */
export function withOffset(map: OffsetMap, key: string, seconds: number): OffsetMap {
  const { [key]: _old, ...rest } = map;
  const value = clampOffset(seconds);
  const next = value === 0 ? rest : { ...rest, [key]: value };
  const keys = Object.keys(next);
  if (keys.length <= MAX_SONGS) return next;
  return Object.fromEntries(keys.slice(keys.length - MAX_SONGS).map((k) => [k, next[k]]));
}

export function writeOffsets(map: OffsetMap, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable: the nudge lasts for this session.
  }
}

/** "+0.3 s", "−1.2 s", "0.0 s". */
export function formatOffset(seconds: number): string {
  const v = clampOffset(seconds);
  if (v === 0) return "0.0 s";
  return `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} s`;
}
