import { describe, expect, it, vi } from "vitest"
import { createPlaybackClock } from "./playbackClock"

describe("playback clock", () => {
  it("notifies only on a real change", () => {
    const clock = createPlaybackClock()
    const listener = vi.fn()
    const unsubscribe = clock.subscribe(listener)
    clock.set(1.5)
    clock.set(1.5)
    clock.set(Number.NaN)
    expect(clock.get()).toBe(1.5)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    clock.set(2)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
