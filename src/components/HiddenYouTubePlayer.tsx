import { useCallback, useEffect, useRef, useState } from "react"
import { getPlayerServerUrl } from "../lib/search"

export interface YouTubePlayerInstance {
  destroy: () => void
  getCurrentTime: () => number
  getDuration: () => number
  pauseVideo: () => void
  playVideo: () => void
  seekTo: (seconds: number, allowSeekAhead: boolean) => void
  nextVideo: () => void
  previousVideo: () => void
  cueVideoById?: (videoId: string | { videoId: string; startSeconds?: number }) => void
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

export interface HiddenYouTubePlayerProps {
  onError: (code: number) => void
  onReady: (player: YouTubePlayerInstance) => void
  onStateChange: (state: YouTubePlaybackState) => void
  onTrackChange?: (trackInfo: { videoId: string; title?: string; artist?: string }) => void
  videoId?: string
  initialSeconds?: number
  autoPlayOnMount?: boolean
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
  initialSeconds = 0,
  autoPlayOnMount = true,
}: HiddenYouTubePlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const playerRef = useRef<YouTubePlayerInstance | null>(null)
  const currentVideoIdRef = useRef<string | undefined>(undefined)
  const isInitializingRef = useRef(false)
  const isFirstMountPlaybackHandled = useRef(false)
  const isBridgeReadyRef = useRef(false)
  const pendingActionsRef = useRef<Array<Record<string, unknown>>>([])

  const currentTimeRef = useRef(0)
  const durationRef = useRef(0)
  const volumeRef = useRef(100)
  const isMutedRef = useRef(false)
  const videoDataRef = useRef<{ video_id?: string; title?: string; author?: string }>({})

  const [bridgeUrl, setBridgeUrl] = useState<string | null>(null)
  const [useFallbackDirect, setUseFallbackDirect] = useState(false)

  const callbacksRef = useRef({ onError, onReady, onStateChange, onTrackChange })
  useEffect(() => {
    callbacksRef.current = { onError, onReady, onStateChange, onTrackChange }
  })

  // Detect loopback server in Tauri environment
  useEffect(() => {
    let isMounted = true
    getPlayerServerUrl().then((url) => {
      if (!isMounted) return
      if (url) {
        setBridgeUrl(url)
      } else {
        setUseFallbackDirect(true)
      }
    })
    return () => {
      isMounted = false
    }
  }, [])

  const postToBridge = useCallback((actionObj: Record<string, unknown>) => {
    if (isBridgeReadyRef.current && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(actionObj, "*")
    } else {
      pendingActionsRef.current.push(actionObj)
    }
  }, [])

  // Create bridge player instance
  const bridgePlayerInstance = useRef<YouTubePlayerInstance>({
    playVideo: () => postToBridge({ action: "play" }),
    pauseVideo: () => postToBridge({ action: "pause" }),
    seekTo: (seconds, allowSeekAhead) => {
      currentTimeRef.current = seconds
      postToBridge({ action: "seekTo", seconds, allowSeekAhead })
    },
    getCurrentTime: () => currentTimeRef.current,
    getDuration: () => durationRef.current,
    loadVideoById: (opts) => {
      const vid = typeof opts === "string" ? opts : opts.videoId
      const start = typeof opts === "string" ? 0 : (opts.startSeconds ?? 0)
      currentTimeRef.current = start
      currentVideoIdRef.current = vid
      postToBridge({ action: "loadVideo", videoId: vid, startSeconds: start, autoplay: true })
    },
    cueVideoById: (opts) => {
      const vid = typeof opts === "string" ? opts : opts.videoId
      const start = typeof opts === "string" ? 0 : (opts.startSeconds ?? 0)
      currentTimeRef.current = start
      currentVideoIdRef.current = vid
      postToBridge({ action: "cueVideo", videoId: vid, startSeconds: start })
    },
    nextVideo: () => {},
    previousVideo: () => {},
    getVideoData: () => videoDataRef.current,
    setVolume: (vol) => {
      volumeRef.current = vol
      postToBridge({ action: "setVolume", volume: vol })
    },
    getVolume: () => volumeRef.current,
    isMuted: () => isMutedRef.current,
    mute: () => {
      isMutedRef.current = true
      postToBridge({ action: "mute" })
    },
    unMute: () => {
      isMutedRef.current = false
      postToBridge({ action: "unMute" })
    },
    destroy: () => {},
  }).current

  // Listen to messages from bridge iframe
  useEffect(() => {
    if (!bridgeUrl) return

    const handleMessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== "object" || !data.type) return

      switch (data.type) {
        case "ready": {
          isBridgeReadyRef.current = true
          playerRef.current = bridgePlayerInstance
          callbacksRef.current.onReady(bridgePlayerInstance)

          // Flush queued actions
          while (pendingActionsRef.current.length > 0) {
            const act = pendingActionsRef.current.shift()
            if (act && iframeRef.current?.contentWindow) {
              iframeRef.current.contentWindow.postMessage(act, "*")
            }
          }

          // Initial track playback if available
          const cleanId = videoId?.trim()
          if (cleanId) {
            currentVideoIdRef.current = cleanId
            if (autoPlayOnMount) {
              bridgePlayerInstance.loadVideoById?.({ videoId: cleanId, startSeconds: initialSeconds })
            } else {
              bridgePlayerInstance.cueVideoById?.({ videoId: cleanId, startSeconds: initialSeconds })
            }
            isFirstMountPlaybackHandled.current = true
          }
          break
        }

        case "stateChange":
          callbacksRef.current.onStateChange(getPlaybackState(data.stateCode))
          break

        case "timeUpdate":
          if (typeof data.currentTime === "number") {
            currentTimeRef.current = data.currentTime
          }
          if (typeof data.duration === "number" && data.duration > 0) {
            durationRef.current = data.duration
          }
          if (typeof data.volume === "number") {
            volumeRef.current = data.volume
          }
          if (typeof data.isMuted === "boolean") {
            isMutedRef.current = data.isMuted
          }
          break

        case "trackChange":
          videoDataRef.current = {
            video_id: data.videoId,
            title: data.title,
            author: data.artist,
          }
          currentVideoIdRef.current = data.videoId
          callbacksRef.current.onTrackChange?.({
            videoId: data.videoId,
            title: data.title,
            artist: data.artist,
          })
          break

        case "error":
          callbacksRef.current.onError(data.code)
          break
      }
    }

    window.addEventListener("message", handleMessage)
    return () => {
      window.removeEventListener("message", handleMessage)
    }
  }, [bridgeUrl, videoId, initialSeconds, autoPlayOnMount, bridgePlayerInstance])

  // Track watcher for bridge mode
  useEffect(() => {
    if (!bridgeUrl) return
    const cleanId = videoId?.trim()
    if (!cleanId) return

    if (cleanId === currentVideoIdRef.current && isFirstMountPlaybackHandled.current) return
    currentVideoIdRef.current = cleanId

    if (isBridgeReadyRef.current) {
      bridgePlayerInstance.loadVideoById?.({ videoId: cleanId, startSeconds: 0 })
      bridgePlayerInstance.playVideo?.()
      isFirstMountPlaybackHandled.current = true
    } else {
      postToBridge({ action: "loadVideo", videoId: cleanId, startSeconds: 0, autoplay: true })
    }
  }, [videoId, bridgeUrl, bridgePlayerInstance, postToBridge])

  // Direct fallback mode for pure web development without Tauri
  const checkTrackChangeDirect = useCallback((instance: YouTubePlayerInstance) => {
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

  const initDirectPlayer = useCallback((targetVideoId: string) => {
    if (playerRef.current || isInitializingRef.current || !containerRef.current) return
    isInitializingRef.current = true

    const placeholder = document.createElement("div")
    containerRef.current.appendChild(placeholder)

    void loadIframeApi()
      .then(() => {
        if (!window.YT?.Player) return

        const playerVars: Record<string, number | string> = {
          autoplay: autoPlayOnMount ? 1 : 0,
          controls: 0,
          enablejsapi: 1,
          playsinline: 1,
          rel: 0,
        }

        if (window.location.protocol.startsWith("http")) {
          playerVars.origin = window.location.origin
        }

        const player = new window.YT.Player(placeholder, {
          videoId: targetVideoId,
          playerVars,
          events: {
            onError: (event) => callbacksRef.current.onError(event.data),
            onReady: (event) => {
              const instance = event.target || player
              if (instance) {
                playerRef.current = instance
                currentVideoIdRef.current = targetVideoId
                callbacksRef.current.onReady(instance)

                if (autoPlayOnMount) {
                  instance.loadVideoById?.({ videoId: targetVideoId, startSeconds: initialSeconds })
                  instance.playVideo?.()
                } else {
                  instance.cueVideoById?.({ videoId: targetVideoId, startSeconds: initialSeconds })
                }
                isFirstMountPlaybackHandled.current = true
                checkTrackChangeDirect(instance)
              }
            },
            onStateChange: (event) => {
              callbacksRef.current.onStateChange(getPlaybackState(event.data))
              const instance = event.target || player || playerRef.current
              if (instance) checkTrackChangeDirect(instance)
            },
          },
        })
      })
      .catch((err) => {
        isInitializingRef.current = false
        callbacksRef.current.onError(-1)
        console.error("Failed to load direct YouTube API:", err)
      })
  }, [checkTrackChangeDirect, autoPlayOnMount, initialSeconds])

  useEffect(() => {
    if (!useFallbackDirect) return
    const cleanId = videoId?.trim()
    if (!cleanId) return

    if (!playerRef.current) {
      initDirectPlayer(cleanId)
    } else {
      if (cleanId === currentVideoIdRef.current) return
      currentVideoIdRef.current = cleanId
      playerRef.current.loadVideoById?.({ videoId: cleanId, startSeconds: 0 })
      playerRef.current.playVideo?.()
    }
  }, [useFallbackDirect, videoId, initDirectPlayer])

  // Watchdog: ensure track doesn't freeze in unstarted/paused state when auto-advancing
  useEffect(() => {
    if (!videoId || !autoPlayOnMount || !isFirstMountPlaybackHandled.current) return
    const timer = setTimeout(() => {
      const instance = playerRef.current
      if (instance && typeof instance.playVideo === "function") {
        instance.playVideo()
      }
    }, 1500)
    return () => clearTimeout(timer)
  }, [videoId, autoPlayOnMount])

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      try {
        playerRef.current?.destroy()
      } catch {}
      playerRef.current = null
      isInitializingRef.current = false
      isBridgeReadyRef.current = false
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
        width: 200,
        height: 200,
        opacity: 0.001,
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: -999,
      }}
    >
      {bridgeUrl && (
        <iframe
          ref={iframeRef}
          src={bridgeUrl}
          title="DOT Music Audio Engine"
          allow="autoplay; encrypted-media"
          tabIndex={-1}
          style={{
            width: 200,
            height: 200,
            border: "none",
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  )
}
