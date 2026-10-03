import { useEffect, useRef } from "react"

export interface YouTubePlayerInstance {
  destroy: () => void
  getCurrentTime: () => number
  getDuration: () => number
  pauseVideo: () => void
  playVideo: () => void
  seekTo: (seconds: number, allowSeekAhead: boolean) => void
  nextVideo: () => void
  previousVideo: () => void
  loadVideoById?: (videoId: string | { videoId: string; startSeconds?: number }) => void
  playVideoAt?: (index: number) => void
  getVideoData: () => { video_id?: string; title?: string; author?: string }
  getPlaylist?: () => string[]
  getPlaylistIndex?: () => number
  mute?: () => void
  unMute?: () => void
  isMuted?: () => boolean
  setVolume?: (volume: number) => void
  getVolume?: () => number
}

export type YouTubePlaybackState =
  | "buffering"
  | "cued"
  | "ended"
  | "paused"
  | "playing"
  | "unstarted"

declare global {
  interface Window {
    YT?: {
      Player: new (
        element: HTMLElement,
        options: {
          events: {
            onError: (event: { data: number }) => void
            onReady: (event: { target: YouTubePlayerInstance }) => void
            onStateChange: (event: { data: number; target: YouTubePlayerInstance }) => void
          }
          playerVars: Record<string, number | string>
          videoId?: string
        },
      ) => YouTubePlayerInstance
    }
    onYouTubeIframeAPIReady?: () => void
  }
}

let iframeApiPromise: Promise<void> | null = null

function loadIframeApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve()
  if (window.YT?.Player) return Promise.resolve()
  if (iframeApiPromise) return iframeApiPromise

  iframeApiPromise = new Promise((resolve, reject) => {
    const checkReady = () => {
      if (window.YT?.Player) {
        resolve()
        return true
      }
      return false
    }

    if (checkReady()) return

    const previousReady = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.()
      resolve()
    }

    const existingScript = document.querySelector(
      'script[src*="youtube.com/iframe_api"]',
    )
    if (!existingScript) {
      const script = document.createElement("script")
      script.src = "https://www.youtube.com/iframe_api"
      script.async = true
      script.onerror = () => reject(new Error("Unable to load the YouTube player API."))
      document.head.appendChild(script)
    }

    // Safety polling in case onYouTubeIframeAPIReady fired before listener attached
    const interval = setInterval(() => {
      if (checkReady()) {
        clearInterval(interval)
      }
    }, 100)

    setTimeout(() => {
      clearInterval(interval)
      if (!window.YT?.Player) {
        reject(new Error("YouTube Player API timed out."))
      }
    }, 10000)
  })

  return iframeApiPromise
}

interface HiddenYouTubePlayerProps {
  onError: (code: number) => void
  onReady: (player: YouTubePlayerInstance) => void
  onStateChange: (state: YouTubePlaybackState) => void
  onTrackChange?: (trackInfo: { videoId: string; title?: string; artist?: string }) => void
  videoId?: string
}

function getPlaybackState(stateCode: number): YouTubePlaybackState {
  if (stateCode === 1) return "playing"
  if (stateCode === 2) return "paused"
  if (stateCode === 3) return "buffering"
  if (stateCode === 0) return "ended"
  if (stateCode === 5) return "cued"
  return "unstarted"
}

export function HiddenYouTubePlayer({
  onError,
  onReady,
  onStateChange,
  onTrackChange,
  videoId,
}: HiddenYouTubePlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<YouTubePlayerInstance | null>(null)
  const currentVideoIdRef = useRef<string | undefined>(videoId)

  const callbacksRef = useRef({ onError, onReady, onStateChange, onTrackChange })
  useEffect(() => {
    callbacksRef.current = { onError, onReady, onStateChange, onTrackChange }
  })

  const checkTrackChange = (instance: YouTubePlayerInstance) => {
    if (typeof instance.getVideoData === "function") {
      const data = instance.getVideoData()
      if (data && data.video_id && data.video_id !== currentVideoIdRef.current) {
        currentVideoIdRef.current = data.video_id
        callbacksRef.current.onTrackChange?.({
          videoId: data.video_id,
          title: data.title,
          artist: data.author,
        })
      }
    }
  }

  // 1. Dedicated track watcher: seamlessly load and play when videoId changes on live instance
  useEffect(() => {
    const instance = playerRef.current
    if (!instance || !videoId) return
    if (videoId === currentVideoIdRef.current) return

    currentVideoIdRef.current = videoId

    if (typeof instance.loadVideoById === "function") {
      instance.loadVideoById({ videoId, startSeconds: 0 })
      instance.playVideo?.()
    }
  }, [videoId])

  // 2. Watchdog: ensure track doesn't freeze in unstarted/paused state when auto-advancing
  useEffect(() => {
    if (!videoId) return
    const timer = setTimeout(() => {
      const instance = playerRef.current
      if (instance && typeof instance.playVideo === "function") {
        instance.playVideo()
      }
    }, 2000)
    return () => clearTimeout(timer)
  }, [videoId])

  useEffect(() => {
    let active = true
    let player: YouTubePlayerInstance | null = null

    if (!containerRef.current) return

    const placeholder = document.createElement("div")
    containerRef.current.appendChild(placeholder)

    void loadIframeApi()
      .then(() => {
        if (!active || !window.YT?.Player) return

        const playerVars: Record<string, number | string> = {
          autoplay: 1,
          controls: 0,
          enablejsapi: 1,
          playsinline: 1,
          rel: 0,
        }

        if (window.location.protocol.startsWith("http")) {
          playerVars.origin = window.location.origin
        }

        const applyIframeReferrerPolicy = () => {
          const iframe = containerRef.current?.querySelector("iframe")
          if (iframe) {
            iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin")
          }
        }

        player = new window.YT.Player(placeholder, {
          videoId: videoId || undefined,
          playerVars,
          events: {
            onError: (event) => {
              if (active) callbacksRef.current.onError(event.data)
            },
            onReady: (event) => {
              applyIframeReferrerPolicy()
              const instance = event.target || player
              if (active && instance) {
                playerRef.current = instance
                callbacksRef.current.onReady(instance)

                if (videoId) {
                  currentVideoIdRef.current = videoId
                  if (typeof instance.loadVideoById === "function") {
                    instance.loadVideoById({ videoId, startSeconds: 0 })
                  }
                  instance.playVideo?.()
                }

                checkTrackChange(instance)
              }
            },
            onStateChange: (event) => {
              if (active) {
                callbacksRef.current.onStateChange(getPlaybackState(event.data))
                const instance = event.target || player || playerRef.current
                if (instance) {
                  checkTrackChange(instance)
                }
              }
            },
          },
        })
      })
      .catch((err) => {
        if (active) callbacksRef.current.onError(-1)
        console.error("Failed to load YouTube iframe API:", err)
      })

    return () => {
      active = false
      playerRef.current = null
      try {
        player?.destroy()
      } catch {
        // ignore cleanup error
      }
      placeholder.remove()
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="hidden-youtube-player"
      aria-hidden="true"
      style={{
        position: "fixed",
        top: -9999,
        left: -9999,
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: -999,
      }}
    />
  )
}
