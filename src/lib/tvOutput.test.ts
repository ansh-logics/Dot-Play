import { beforeEach, describe, expect, it, vi } from "vitest"

const sent: Array<{ id: string; message: Record<string, unknown> }> = []
vi.mock("./tvs", () => ({
  sendToTv: (id: string, message: Record<string, unknown>) => {
    sent.push({ id, message })
    return Promise.resolve()
  },
}))

const { createTvPlayer } = await import("./tvOutput")

function setup() {
  const states: string[] = []
  const errors: number[] = []
  const keys: string[] = []
  const tv = createTvPlayer("tv-1", {
    onStateChange: (state) => states.push(state),
    onError: (code) => errors.push(code),
    onKey: (key) => keys.push(key),
  })
  return { tv, states, errors, keys }
}

describe("a TV as the playback engine", () => {
  beforeEach(() => {
    sent.length = 0
  })

  it("turns player calls into messages for that TV", () => {
    const { tv } = setup()
    tv.player.loadVideoById?.({ videoId: "abc", startSeconds: 42 })
    tv.player.pauseVideo()
    tv.player.seekTo(90, true)
    tv.player.setVolume?.(30)
    expect(sent.map((s) => s.message)).toEqual([
      { t: "load", videoId: "abc", start: 42, autoplay: true },
      { t: "pause" },
      { t: "seek", seconds: 90 },
      { t: "volume", volume: 30 },
    ])
    expect(sent.every((s) => s.id === "tv-1")).toBe(true)
    expect(tv.player.getCurrentTime()).toBe(90)
  })

  it("cues without playing when asked to", () => {
    const { tv } = setup()
    tv.player.cueVideoById?.({ videoId: "abc", startSeconds: 5 })
    expect(sent[0].message).toEqual({ t: "load", videoId: "abc", start: 5, autoplay: false })
  })

  it("reports each change of state once, with the TV's position and duration", () => {
    const { tv, states } = setup()
    tv.player.loadVideoById?.("abc")
    tv.handleMessage({ t: "state", videoId: "abc", state: "buffering", time: 0, duration: 0 })
    tv.handleMessage({ t: "state", videoId: "abc", state: "paused", time: 12, duration: 200 })
    tv.handleMessage({ t: "state", videoId: "abc", state: "paused", time: 12, duration: 200 })
    expect(states).toEqual(["buffering", "paused"])
    expect(tv.player.getCurrentTime()).toBe(12)
    expect(tv.player.getDuration()).toBe(200)
  })

  it("ignores reports about a song it has moved on from", () => {
    const { tv, states, errors } = setup()
    tv.player.loadVideoById?.("old")
    tv.player.loadVideoById?.("new")
    tv.handleMessage({ t: "state", videoId: "old", state: "ended", time: 180, duration: 180 })
    tv.handleMessage({ t: "error", videoId: "old", code: 150 })
    expect(states).toEqual([])
    expect(errors).toEqual([])
  })

  it("reports the same song ending again after it is reloaded", () => {
    const { tv, states } = setup()
    tv.player.loadVideoById?.("abc")
    tv.handleMessage({ t: "state", videoId: "abc", state: "ended", time: 100, duration: 100 })
    tv.player.loadVideoById?.("abc")
    tv.handleMessage({ t: "state", videoId: "abc", state: "ended", time: 100, duration: 100 })
    expect(states).toEqual(["ended", "ended"])
  })

  it("passes on errors and the TV remote's next and previous", () => {
    const { tv, errors, keys } = setup()
    tv.player.loadVideoById?.("abc")
    tv.handleMessage({ t: "error", videoId: "abc", code: 150 })
    tv.handleMessage({ t: "key", key: "next" })
    tv.handleMessage({ t: "key", key: "volume-up" })
    tv.handleMessage(null)
    tv.handleMessage({ t: "state", videoId: "abc", state: "dancing", time: 1, duration: 1 })
    expect(errors).toEqual([150])
    expect(keys).toEqual(["next"])
  })
})
