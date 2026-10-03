import { useCallback, useEffect, useRef } from "react"

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
  const currentVideoIdRef = useRef<string | undefined>(undefined)
  const isInitializingRef = useRef(false)

  const callbacksRef = useRef({ onError, onReady, onStateChange, onTrackChange })
  useEffect(() => {
    callbacksRef.current = { onError, onReady, onStateChange, onTrackChange }
  })

  const checkTrackChange = useCallback((instance: YouTubePlayerInstance) => {
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
  }, [])

  const initPlayer = useCallback((targetVideoId: string) => {
    if (playerRef.current || isInitializingRef.current || !containerRef.current) return
    isInitializingRef.current = true

    const placeholder = document.createElement("div")
    containerRef.current.appendChild(placeholder)

    void loadIframeApi()
      .then(() => {
        if (!window.YT?.Player) return

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

        const player = new window.YT.Player(placeholder, {
          videoId: targetVideoId,
          playerVars,
          events: {
            onError: (event) => {
              callbacksRef.current.onError(event.data)
            },
            onReady: (event) => {
              applyIframeReferrerPolicy()
              const instance = event.target || player
              if (instance) {
                playerRef.current = instance
                currentVideoIdRef.current = targetVideoId
                callbacksRef.current.onReady(instance)

                if (typeof instance.loadVideoById === "function") {
                  instance.loadVideoById({ videoId: targetVideoId, startSeconds: 0 })
                }
                instance.playVideo?.()

                checkTrackChange(instance)
              }
            },
            onStateChange: (event) => {
              callbacksRef.current.onStateChange(getPlaybackState(event.data))
              const instance = event.target || player || playerRef.current
              if (instance) {
                checkTrackChange(instance)
              }
            },
          },
        })
      })
      .catch((err) => {
        isInitializingRef.current = false
        callbacksRef.current.onError(-1)
        console.error("Failed to load YouTube iframe API:", err)
      })
  }, [checkTrackChange])

  // Track watcher: initialize persistent player on first track, or smoothly load next tracks
  useEffect(() => {
    const cleanId = videoId?.trim()
    if (!cleanId) return

    if (!playerRef.current) {
      initPlayer(cleanId)
    } else {
      if (cleanId === currentVideoIdRef.current) return
      currentVideoIdRef.current = cleanId

      const instance = playerRef.current
      if (typeof instance.loadVideoById === "function") {
        instance.loadVideoById({ videoId: cleanId, startSeconds: 0 })
        instance.playVideo?.()
      }
    }
  }, [videoId, initPlayer])

  // Watchdog: ensure track doesn't freeze in unstarted/paused state when auto-advancing
  useEffect(() => {
    if (!videoId) return
    const timer = setTimeout(() => {
      const instance = playerRef.current
      if (instance && typeof instance.playVideo === "function") {
        instance.playVideo()
      }
    }, 1500)
    return () => clearTimeout(timer)
  }, [videoId])

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      try {
        playerRef.current?.destroy()
      } catch {}
      playerRef.current = null
      isInitializingRef.current = false
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
