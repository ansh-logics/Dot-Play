import type { RepeatMode } from "./queueManager.ts"

/**
 * User playback preferences. Kept separate from QueueSession because the
 * session is mirrored to a strict Rust struct.
 */
export interface PlaybackModes {
  repeat: RepeatMode
  shuffle: boolean
  /** Fetch recommendations when Upcoming runs out. */
  autoplay: boolean
}

const STORAGE_KEY = "dot_playback_modes"
const VOLUME_KEY = "dot_playback_volume"

export const DEFAULT_PLAYBACK_MODES: PlaybackModes = {
  repeat: "off",
  shuffle: false,
  autoplay: true,
}

const REPEAT_CYCLE: RepeatMode[] = ["off", "all", "one"]

export function nextRepeatMode(mode: RepeatMode): RepeatMode {
  return REPEAT_CYCLE[(REPEAT_CYCLE.indexOf(mode) + 1) % REPEAT_CYCLE.length]
}

export function loadPlaybackModes(): PlaybackModes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_PLAYBACK_MODES }
    const parsed = JSON.parse(raw) as Partial<PlaybackModes>
    return {
      repeat: REPEAT_CYCLE.includes(parsed.repeat as RepeatMode)
        ? (parsed.repeat as RepeatMode)
        : DEFAULT_PLAYBACK_MODES.repeat,
      // The shuffled order itself persists with the queue session; only the
      // pre-shuffle order is in-memory, so un-shuffling after a restart keeps the current order.
      shuffle: Boolean(parsed.shuffle),
      autoplay: typeof parsed.autoplay === "boolean" ? parsed.autoplay : DEFAULT_PLAYBACK_MODES.autoplay,
    }
  } catch {
    return { ...DEFAULT_PLAYBACK_MODES }
  }
}

export function savePlaybackModes(modes: PlaybackModes): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(modes))
  } catch {
    // Storage unavailable; modes simply won't persist.
  }
}

export function loadVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY))
    return Number.isFinite(v) && v > 0 && v <= 100 ? v : 100
  } catch {
    return 100
  }
}

export function saveVolume(volume: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(Math.round(volume)))
  } catch {
    // ignore
  }
}
