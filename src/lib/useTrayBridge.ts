import { useEffect, useEffectEvent, useRef, useState } from "react"
import { emitTo, listen } from "@tauri-apps/api/event"
import { cleanDisplayTitle } from "./displayText"
import { optimizeThumbnailUrl } from "./imagePipeline"
import type { PlaybackModes } from "./playbackModes"
import { isTauriEnvironment, type SearchResult } from "./search"

/** One Up Next row, as the menu bar popover renders it. Mirrors src/tray/types.ts. */
export interface TrayQueueItem {
  videoId: string
  title: string
  artist: string
  thumb: string
}

export interface TrayState {
  upcoming: TrayQueueItem[]
  shuffle: boolean
  repeat: PlaybackModes["repeat"]
  autoplay: boolean
  volume: number
  muted: boolean
}

export type TrayCommand =
  | { type: "playQueueItem"; videoId: string }
  | { type: "removeQueueItem"; index: number; videoId: string }
  | { type: "toggleShuffle" | "cycleRepeat" | "toggleMute" }
  | { type: "setVolume"; volume: number }

/** The popover only shows the start of a long queue; this keeps each message small. */
const MAX_UPCOMING = 50

interface TrayBridgeOptions {
  upcoming: SearchResult[]
  playbackModes: PlaybackModes
  volume: number
  isMuted: boolean
  onSelectUpcoming: (track: SearchResult) => void
  onRemoveUpcoming: (index: number) => void
  onToggleShuffle: () => void
  onCycleRepeat: () => void
  onChangeVolume: (volume: number) => void
  onToggleMute: () => void
}

/**
 * Feeds the menu bar popover its queue, modes and volume, and applies its commands.
 * Track info and play/pause/next/previous/seek already flow through
 * useSystemMediaControls; this covers everything else. Nothing is sent while the
 * popover is closed (Rust reports open/closed with `tray-visibility`).
 */
export function useTrayBridge({
  upcoming,
  playbackModes,
  volume,
  isMuted,
  onSelectUpcoming,
  onRemoveUpcoming,
  onToggleShuffle,
  onCycleRepeat,
  onChangeVolume,
  onToggleMute,
}: TrayBridgeOptions) {
  const enabled = isTauriEnvironment()
  const [open, setOpen] = useState(false)
  // Bumped when a freshly created popover has loaded and is listening.
  const [readyCount, setReadyCount] = useState(0)
  const upcomingRef = useRef(upcoming)
  useEffect(() => {
    upcomingRef.current = upcoming
  }, [upcoming])

  const handleCommand = useEffectEvent((command: TrayCommand) => {
    const queue = upcomingRef.current
    switch (command.type) {
      case "playQueueItem": {
        const track = queue.find((t) => t.videoId === command.videoId)
        if (track) onSelectUpcoming(track)
        break
      }
      case "removeQueueItem": {
        // The queue may have changed since the popover rendered; never remove the wrong song.
        const index =
          queue[command.index]?.videoId === command.videoId
            ? command.index
            : queue.findIndex((t) => t.videoId === command.videoId)
        if (index >= 0) onRemoveUpcoming(index)
        break
      }
      case "toggleShuffle":
        onToggleShuffle()
        break
      case "cycleRepeat":
        onCycleRepeat()
        break
      case "toggleMute":
        onToggleMute()
        break
      case "setVolume":
        onChangeVolume(command.volume)
        break
    }
  })

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    const unlisteners: Array<() => void> = []
    const keep = (fn: () => void) => (disposed ? fn() : unlisteners.push(fn))

    void listen<{ open: boolean }>("tray-visibility", ({ payload }) => setOpen(payload.open)).then(keep)
    void listen("tray-ready", () => {
      setOpen(true)
      setReadyCount((n) => n + 1)
    }).then(keep)
    void listen<TrayCommand>("tray-command", ({ payload }) => handleCommand(payload)).then(keep)

    return () => {
      disposed = true
      unlisteners.forEach((fn) => fn())
    }
  }, [enabled])

  // Pushed when the popover opens or finishes loading, and on every change while it's open.
  useEffect(() => {
    if (!enabled || !open) return
    const state: TrayState = {
      upcoming: upcoming.slice(0, MAX_UPCOMING).map((track) => ({
        videoId: track.videoId,
        title: cleanDisplayTitle(track.title),
        artist: track.artist,
        thumb: optimizeThumbnailUrl(track.thumbnailUrl, track.videoId, "thumbnail"),
      })),
      shuffle: playbackModes.shuffle,
      repeat: playbackModes.repeat,
      autoplay: playbackModes.autoplay,
      volume,
      muted: isMuted,
    }
    void emitTo("tray", "tray-state", state).catch(() => {})
  }, [enabled, open, readyCount, upcoming, playbackModes, volume, isMuted])
}
