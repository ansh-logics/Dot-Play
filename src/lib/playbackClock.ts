import { useSyncExternalStore, type ReactNode } from "react"

/**
 * The playback position, kept outside React state. It changes 10 times a second while a
 * song plays; only the components that show it subscribe, so the rest of the app doesn't
 * re-render on every tick.
 */
export interface PlaybackClock {
  get(): number
  set(seconds: number): void
  subscribe(listener: () => void): () => void
}

export function createPlaybackClock(initial = 0): PlaybackClock {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(seconds) {
      if (seconds === value || !Number.isFinite(seconds)) return
      value = seconds
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function useCurrentTime(clock: PlaybackClock): number {
  return useSyncExternalStore(clock.subscribe, clock.get)
}

/** Renders `children` with the current position, re-rendering only this subtree. */
export function WithCurrentTime({ clock, children }: { clock: PlaybackClock; children: (seconds: number) => ReactNode }) {
  return children(useCurrentTime(clock))
}
