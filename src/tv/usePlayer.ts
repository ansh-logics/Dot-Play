import { useCallback, useEffect, useRef, useState } from "react"

/**
 * The TV's playback engine: the YouTube IFrame player, embedded straight in this page.
 *
 * Not through the desktop's bridge page on 127.0.0.1: YouTube refuses to play music for an
 * embedder at a numeric address ("This video is unavailable"), while this page's own origin
 * (http://tauri.localhost) is accepted.
 */

export type PlayerState = "loading" | "ready" | "unstarted" | "buffering" | "playing" | "paused" | "ended" | "cued" | "error"

export interface PlayerSnapshot {
  state: PlayerState
  videoId: string
  currentTime: number
  duration: number
  volume: number
  errorCode: number | null
}

interface YouTubePlayer {
  loadVideoById(options: { videoId: string; startSeconds?: number }): void
  cueVideoById(options: { videoId: string; startSeconds?: number }): void
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  setVolume(volume: number): void
  getVolume(): number
  mute(): void
  unMute(): void
  getCurrentTime(): number
  getDuration(): number
}

interface YouTubeApi {
  Player: new (
    element: HTMLElement,
    options: {
      width: string
      height: string
      playerVars: Record<string, number | string>
      events: {
        onReady: () => void
        onStateChange: (event: { data: number }) => void
        onError: (event: { data: number }) => void
      }
    },
  ) => YouTubePlayer
}

/** The page's YouTube API object, with the slice of its shape this file uses. */
const youtube = () => (window as unknown as { YT?: YouTubeApi }).YT

const STATES: Record<number, PlayerState> = { [-1]: "unstarted", 0: "ended", 1: "playing", 2: "paused", 3: "buffering", 5: "cued" }

let apiLoading: Promise<YouTubeApi> | null = null

function loadApi(): Promise<YouTubeApi> {
  apiLoading ??= new Promise((resolve, reject) => {
    const ready = youtube()
    if (ready?.Player) {
      resolve(ready)
      return
    }
    window.onYouTubeIframeAPIReady = () => {
      const api = youtube()
      if (api) resolve(api)
    }
    const script = document.createElement("script")
    script.src = "https://www.youtube.com/iframe_api"
    script.onerror = () => {
      apiLoading = null
      reject(new Error("The YouTube player couldn't be loaded."))
    }
    document.head.appendChild(script)
  })
  return apiLoading
}

export function usePlayer() {
  /** Put this on an element that is laid out (the player won't run in a hidden one). */
  const containerRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<YouTubePlayer | null>(null)
  /** Commands given before the player is ready, run in order once it is. */
  const pendingRef = useRef<Array<(player: YouTubePlayer) => void>>([])
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>({
    state: "loading",
    videoId: "",
    currentTime: 0,
    duration: 0,
    volume: 100,
    errorCode: null,
  })
  const playing = snapshot.state === "playing"

  useEffect(() => {
    let cancelled = false
    loadApi().then(
      (api) => {
        const container = containerRef.current
        if (cancelled || !container) return
        const mount = document.createElement("div")
        container.appendChild(mount)
        const player = new api.Player(mount, {
          width: "200",
          height: "200",
          playerVars: { autoplay: 0, controls: 0, enablejsapi: 1, playsinline: 1, rel: 0, origin: window.location.origin },
          events: {
            onReady: () => {
              playerRef.current = player
              setSnapshot((s) => (s.state === "loading" ? { ...s, state: "ready" } : s))
              for (const command of pendingRef.current.splice(0)) command(player)
            },
            onStateChange: (event) => {
              const state = STATES[event.data] ?? "unstarted"
              setSnapshot((s) => ({
                ...s,
                state,
                errorCode: null,
                duration: player.getDuration() || s.duration,
                // A song that ended is at its end, whatever the last progress tick said.
                currentTime: state === "ended" && s.duration > 0 ? s.duration : (player.getCurrentTime() ?? s.currentTime),
              }))
            },
            onError: (event) => setSnapshot((s) => ({ ...s, state: "error", errorCode: event.data })),
          },
        })
      },
      () => setSnapshot((s) => ({ ...s, state: "error", errorCode: -1 })),
    )
    return () => {
      cancelled = true
    }
  }, [])

  // The position, twice a second while something plays.
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      const player = playerRef.current
      if (!player) return
      setSnapshot((s) => ({
        ...s,
        currentTime: player.getCurrentTime() ?? s.currentTime,
        duration: player.getDuration() || s.duration,
        volume: player.getVolume() ?? s.volume,
      }))
    }, 500)
    return () => clearInterval(timer)
  }, [playing])

  const run = useCallback((command: (player: YouTubePlayer) => void) => {
    if (playerRef.current) command(playerRef.current)
    else pendingRef.current.push(command)
  }, [])

  const load = useCallback(
    (videoId: string, startSeconds = 0, autoplay = true) => {
      setSnapshot((s) => ({ ...s, state: "unstarted", videoId, currentTime: startSeconds, duration: 0, errorCode: null }))
      run((player) => {
        if (autoplay) player.loadVideoById({ videoId, startSeconds })
        else player.cueVideoById({ videoId, startSeconds })
      })
    },
    [run],
  )
  const play = useCallback(() => run((player) => player.playVideo()), [run])
  const pause = useCallback(() => run((player) => player.pauseVideo()), [run])
  const seek = useCallback(
    (seconds: number) => {
      const target = Math.max(0, seconds)
      setSnapshot((s) => ({ ...s, currentTime: target }))
      run((player) => player.seekTo(target, true))
    },
    [run],
  )
  const setVolume = useCallback((volume: number) => run((player) => player.setVolume(volume)), [run])
  const setMuted = useCallback((muted: boolean) => run((player) => (muted ? player.mute() : player.unMute())), [run])

  return { containerRef, snapshot, load, play, pause, seek, setVolume, setMuted }
}
