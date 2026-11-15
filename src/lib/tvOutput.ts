import type { YouTubePlaybackState, YouTubePlayerInstance } from "../components/HiddenYouTubePlayer"
import { sendToTv } from "./tvs"

/**
 * A linked TV as a playback engine. It has the same shape as the hidden YouTube player, so
 * the queue, the phone remote and the menu bar drive it without knowing the sound comes out
 * of a TV: commands go to the TV, and what the TV reports comes back through the same
 * callbacks the local player uses.
 */

interface TvPlayerCallbacks {
  onStateChange: (state: YouTubePlaybackState) => void
  onError: (code: number) => void
  /** Next / Previous pressed on the TV's remote. */
  onKey: (key: "next" | "previous") => void
}

/** Mirrors what the TV app sends (src/tv/useReceiver.ts). */
type TvMessage =
  | { t: "state"; videoId: string; state: YouTubePlaybackState; time: number; duration: number }
  | { t: "error"; videoId: string; code: number }
  | { t: "key"; key: "next" | "previous" }

const STATES = new Set<YouTubePlaybackState>(["buffering", "cued", "ended", "paused", "playing", "unstarted"])

export interface TvPlayer {
  player: YouTubePlayerInstance
  /** Feed it every message that arrives from this TV. */
  handleMessage: (message: unknown) => void
}

export function createTvPlayer(tvId: string, callbacks: TvPlayerCallbacks): TvPlayer {
  let videoId = ""
  // The TV reports its position about once a second; in between, the clock runs here.
  let time = 0
  let at = performance.now()
  let playing = false
  let duration = 0
  let volume = 100
  let muted = false
  let lastState: YouTubePlaybackState | null = null

  const send = (message: Record<string, unknown>) => void sendToTv(tvId, message)
  const mark = (seconds: number) => {
    time = seconds
    at = performance.now()
  }
  const load = (opts: string | { videoId: string; startSeconds?: number }, autoplay: boolean) => {
    videoId = typeof opts === "string" ? opts : opts.videoId
    const start = typeof opts === "string" ? 0 : (opts.startSeconds ?? 0)
    mark(start)
    playing = false
    duration = 0
    lastState = null
    send({ t: "load", videoId, start, autoplay })
  }

  const player: YouTubePlayerInstance = {
    loadVideoById: (opts) => load(opts, true),
    cueVideoById: (opts) => load(opts, false),
    playVideo: () => send({ t: "play" }),
    pauseVideo: () => send({ t: "pause" }),
    seekTo: (seconds) => {
      mark(seconds)
      send({ t: "seek", seconds })
    },
    getCurrentTime: () => {
      const now = playing ? time + (performance.now() - at) / 1000 : time
      return duration > 0 ? Math.min(now, duration) : now
    },
    getDuration: () => duration,
    setVolume: (next) => {
      volume = next
      send({ t: "volume", volume: next })
    },
    getVolume: () => volume,
    mute: () => {
      muted = true
      send({ t: "mute", muted: true })
    },
    unMute: () => {
      muted = false
      send({ t: "mute", muted: false })
    },
    isMuted: () => muted,
    getVideoData: () => ({ video_id: videoId }),
    nextVideo: () => {},
    previousVideo: () => {},
    destroy: () => send({ t: "stop" }),
  }

  const handleMessage = (raw: unknown) => {
    const message = raw as TvMessage | null
    if (!message || typeof message !== "object") return
    if (message.t === "key") {
      if (message.key === "next" || message.key === "previous") callbacks.onKey(message.key)
      return
    }
    // A report about a song the queue has already moved on from.
    if (message.videoId !== videoId) return
    if (message.t === "error") {
      if (Number.isFinite(message.code)) callbacks.onError(message.code)
      return
    }
    if (message.t !== "state" || !STATES.has(message.state)) return
    if (Number.isFinite(message.time)) mark(message.time)
    if (Number.isFinite(message.duration) && message.duration > 0) duration = message.duration
    playing = message.state === "playing"
    if (message.state !== lastState) {
      lastState = message.state
      callbacks.onStateChange(message.state)
    }
  }

  return { player, handleMessage }
}
