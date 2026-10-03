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
  playlistId?: string
}

function getPlaybackState(stateCode: number): YouTubePlaybackState {
  if (stateCode === 1) return "playing"
  if (stateCode === 2) return "paused"
  if (stateCode === 3) return "buffering"
  if (stateCode === 0) return "ended"
  if (stateCode === 5) return "cued"
  return "unstarted"
}

function isStandardEmbedPlaylist(id?: string): id is string {
  if (!id) return false
  return id.startsWith("PL") || id.startsWith("UU") || id.startsWith("FL") || id.startsWith("OLAK")
}

export function HiddenYouTubePlayer({
  onError,
  onReady,
  onStateChange,
  onTrackChange,
  videoId,
  playlistId,
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

  // Handle external videoId changes within the same mounted instance
  useEffect(() => {
    const instance = playerRef.current
    if (!instance || !videoId) return
    if (videoId === currentVideoIdRef.current) return

    currentVideoIdRef.current = videoId

    if (isStandardEmbedPlaylist(playlistId) && typeof instance.getPlaylist === "function") {
      const list = instance.getPlaylist()
      if (Array.isArray(list)) {
        const idx = list.indexOf(videoId)
        if (idx !== -1 && typeof instance.playVideoAt === "function") {
          instance.playVideoAt(idx)
          return
        }
      }
    }

    if (typeof instance.loadVideoById === "function") {
      instance.loadVideoById(videoId)
    }
  }, [videoId, playlistId])

  useEffect(() => {
    let active = true
    let player: YouTubePlayerInstance | null = null

    if (!containerRef.current) return

    // Create a dedicated child placeholder element for YouTube to replace with an iframe.
    // This protects React's containerRef DOM node from being removed by YouTube's API.
    const placeholder = document.createElement("div")
    containerRef.current.appendChild(placeholder)

    void loadIframeApi()
      .then(() => {
        if (!active || !window.YT?.Player) return

        const playerVars: Record<string, number | string> = {
          autoplay: 0,
          controls: 0,
          enablejsapi: 1,
          playsinline: 1,
          rel: 0,
        }

        if (isStandardEmbedPlaylist(playlistId)) {
          playerVars.listType = "playlist"
          playerVars.list = playlistId
        }

        // Only pass origin if running under http/https protocol (avoids breaking in tauri://)
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

                // If loaded with a playlist and specific videoId, seek to that track index
                if (isStandardEmbedPlaylist(playlistId) && videoId && typeof instance.getPlaylist === "function") {
                  const list = instance.getPlaylist()
                  if (Array.isArray(list) && list.length > 0) {
                    const idx = list.indexOf(videoId)
                    if (idx > 0 && typeof instance.playVideoAt === "function") {
                      instance.playVideoAt(idx)
                    }
                  }
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
  }, [playlistId])

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
