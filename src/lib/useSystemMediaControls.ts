import { useEffect, useEffectEvent, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type { YouTubePlaybackState } from "../components/HiddenYouTubePlayer"
import { cleanDisplayTitle } from "./displayText"
import { useArtwork } from "./imagePipeline"
import { isTauriEnvironment, type SearchResult } from "./search"

type MediaControlAction =
  | { action: "play" | "pause" | "toggle" | "next" | "previous" }
  | { action: "seek"; position: number }

interface SystemMediaControlsOptions {
  track: SearchResult | null | undefined
  playerState: YouTubePlaybackState
  currentTime: number
  duration: number
  onTogglePlayPause: () => void
  onNext: () => void
  onPrevious: () => void
  onSeek: (seconds: number) => void
}

/** How far the player may drift from macOS's extrapolated position before we resync. */
const DRIFT_TOLERANCE_SECONDS = 2

/**
 * Mirrors playback into macOS Now Playing (Control Center, lock screen) and routes
 * media keys / AirPods / Control Center buttons back into the app's own handlers.
 * macOS extrapolates progress from the last position and rate, so updates are only
 * sent on track, play/pause and duration changes, and when a seek is detected.
 */
export function useSystemMediaControls({
  track,
  playerState,
  currentTime,
  duration,
  onTogglePlayPause,
  onNext,
  onPrevious,
  onSeek,
}: SystemMediaControlsOptions) {
  const enabled = isTauriEnvironment()

  // Same artwork the Now Playing screen resolves, so the lock screen matches the app.
  const { currentUrl: artworkUrl } = useArtwork({
    sourceUrl: track?.thumbnailUrl,
    videoId: track?.videoId,
    variant: "hero",
  })

  // Buffering between tracks shouldn't flash "paused" on the lock screen.
  const [isPlaying, setIsPlaying] = useState(false)
  const nextIsPlaying =
    playerState === "playing" ? true : playerState === "buffering" ? isPlaying : false
  if (nextIsPlaying !== isPlaying) setIsPlaying(nextIsPlaying)

  const lastSentRef = useRef<{ position: number; at: number; playing: boolean } | null>(null)

  const videoId = track?.videoId
  const title = track ? cleanDisplayTitle(track.title) : ""
  const artist = track?.artist ?? ""
  const knownDuration = duration > 0 ? Math.round(duration) : 0
  const remoteArtworkUrl = /^https?:\/\//.test(artworkUrl) ? artworkUrl : null

  const publish = useEffectEvent(() => {
    if (!enabled) return
    if (!videoId) {
      lastSentRef.current = null
      void invoke("set_now_playing", { info: null }).catch(() => {})
      return
    }
    lastSentRef.current = { position: currentTime, at: performance.now(), playing: isPlaying }
    void invoke("set_now_playing", {
      info: {
        title,
        artist,
        album: null,
        duration: knownDuration,
        position: currentTime,
        isPlaying,
        artworkUrl: remoteArtworkUrl,
        videoId,
      },
    }).catch((error) => console.warn("[DOT Music] Now Playing update failed:", error))
  })

  useEffect(() => {
    publish()
  }, [videoId, title, artist, remoteArtworkUrl, isPlaying, knownDuration])

  // Catch seeks from anywhere (scrubber, arrow keys, "previous" restarting the song).
  useEffect(() => {
    const last = lastSentRef.current
    if (!last) return
    const expected = last.position + (last.playing ? (performance.now() - last.at) / 1000 : 0)
    if (Math.abs(currentTime - expected) > DRIFT_TOLERANCE_SECONDS) {
      publish()
    }
  }, [currentTime])

  const handleAction = useEffectEvent((payload: MediaControlAction) => {
    switch (payload.action) {
      case "play":
        if (!isPlaying) onTogglePlayPause()
        break
      case "pause":
        if (isPlaying) onTogglePlayPause()
        break
      case "toggle":
        onTogglePlayPause()
        break
      case "next":
        onNext()
        break
      case "previous":
        onPrevious()
        break
      case "seek":
        onSeek(payload.position)
        break
    }
  })

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let unlisten: (() => void) | undefined

    void listen<MediaControlAction>("media-control", ({ payload }) => handleAction(payload)).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [enabled])
}
