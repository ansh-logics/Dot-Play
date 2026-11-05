import { useEffect, useEffectEvent, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { emitTo, listen } from "@tauri-apps/api/event"
import { cleanDisplayTitle } from "./displayText"
import { optimizeThumbnailUrl } from "./imagePipeline"
import type { PlaybackModes } from "./playbackModes"
import type { PlayerSkinId } from "./playerSkins"
import { useLikeStatus } from "./likes"
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
  /** The Vinyl style shows the artwork as a turning record in the popover too. */
  skin: PlayerSkinId
  /** Whether the current song is liked; null while signed out or not known yet (no heart). */
  liked: boolean | null
}

export type TrayCommand =
  | { type: "playQueueItem"; videoId: string }
  | { type: "removeQueueItem"; index: number; videoId: string }
  | { type: "toggleShuffle" | "cycleRepeat" | "toggleMute" | "toggleLike" }
  | { type: "setVolume"; volume: number }
  /** Phone Remote: move a song to position `to` in Up Next (0 is Play Next). */
  | { type: "moveQueueItem"; videoId: string; to: number }
  /** Phone Remote search results: play now, play next, or add to the end of Up Next. */
  | { type: "playTrack" | "playNextTrack" | "queueTrack"; track: RemoteTrack }

/** A song picked from the Phone Remote's search. */
export interface RemoteTrack {
  videoId: string
  title: string
  artist: string
  thumbnailUrl: string
}

/** Only well-formed songs from a phone reach the player. */
function toSearchResult(track: RemoteTrack | undefined): SearchResult | null {
  if (!track || typeof track.videoId !== "string" || !/^[\w-]{11}$/.test(track.videoId)) return null
  return {
    videoId: track.videoId,
    title: String(track.title ?? "").slice(0, 300),
    artist: String(track.artist ?? "").slice(0, 300),
    thumbnailUrl: typeof track.thumbnailUrl === "string" ? track.thumbnailUrl : "",
    itemType: "song",
  }
}

/** The popover only shows the start of a long queue; this keeps each message small. */
const MAX_UPCOMING = 50
/** The phone has more room to scroll. */
const MAX_REMOTE_UPCOMING = 100

interface TrayBridgeOptions {
  upcoming: SearchResult[]
  playbackModes: PlaybackModes
  skin: PlayerSkinId
  volume: number
  isMuted: boolean
  onSelectUpcoming: (track: SearchResult) => void
  onRemoveUpcoming: (index: number) => void
  onReorderUpcoming: (upcoming: SearchResult[]) => void
  onPlayTrack: (track: SearchResult) => void
  onPlayNext: (track: SearchResult) => void
  onAddToQueue: (track: SearchResult) => void
  onToggleShuffle: () => void
  onCycleRepeat: () => void
  onChangeVolume: (volume: number) => void
  onToggleMute: () => void
  currentVideoId: string | undefined
  canLike: boolean
  onToggleLike: () => void
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
  skin,
  volume,
  isMuted,
  onSelectUpcoming,
  onRemoveUpcoming,
  onReorderUpcoming,
  onPlayTrack,
  onPlayNext,
  onAddToQueue,
  onToggleShuffle,
  onCycleRepeat,
  onChangeVolume,
  onToggleMute,
  currentVideoId,
  canLike,
  onToggleLike,
}: TrayBridgeOptions) {
  const enabled = isTauriEnvironment()
  const [open, setOpen] = useState(false)
  // Bumped when a freshly created popover has loaded and is listening.
  const [readyCount, setReadyCount] = useState(0)
  const [remoteClients, setRemoteClients] = useState(0)
  const likeStatus = useLikeStatus(currentVideoId, canLike)
  const liked = likeStatus === undefined ? null : likeStatus === "LIKE"
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
      case "moveQueueItem": {
        const from = queue.findIndex((t) => t.videoId === command.videoId)
        if (from < 0) break
        const next = queue.slice()
        const [track] = next.splice(from, 1)
        next.splice(Math.max(0, Math.min(command.to, next.length)), 0, track)
        onReorderUpcoming(next)
        break
      }
      case "playTrack":
      case "playNextTrack":
      case "queueTrack": {
        const track = toSearchResult(command.track)
        if (!track) break
        if (command.type === "playTrack") onPlayTrack(track)
        else if (command.type === "playNextTrack") onPlayNext(track)
        else onAddToQueue(track)
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
      case "toggleLike":
        onToggleLike()
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
    // Phone Remote: the same commands, and how many phones are watching.
    void listen<TrayCommand>("remote-command", ({ payload }) => handleCommand(payload)).then(keep)
    void listen<{ count: number }>("remote-clients", ({ payload }) => setRemoteClients(payload.count)).then(keep)

    return () => {
      disposed = true
      unlisteners.forEach((fn) => fn())
    }
  }, [enabled])

  // Pushed when the popover opens or finishes loading, and on every change while it's open.
  // The same state goes to connected phones (with a longer queue) while any are watching.
  useEffect(() => {
    if (!enabled || (!open && remoteClients === 0)) return
    const toItem = (track: SearchResult): TrayQueueItem => ({
      videoId: track.videoId,
      title: cleanDisplayTitle(track.title),
      artist: track.artist,
      thumb: optimizeThumbnailUrl(track.thumbnailUrl, track.videoId, "thumbnail"),
    })
    const base = {
      shuffle: playbackModes.shuffle,
      repeat: playbackModes.repeat,
      autoplay: playbackModes.autoplay,
      volume,
      muted: isMuted,
      skin,
      liked,
    }
    if (open) {
      const state: TrayState = { ...base, upcoming: upcoming.slice(0, MAX_UPCOMING).map(toItem) }
      void emitTo("tray", "tray-state", state).catch(() => {})
    }
    if (remoteClients > 0) {
      const state: TrayState & { total: number } = {
        ...base,
        upcoming: upcoming.slice(0, MAX_REMOTE_UPCOMING).map(toItem),
        total: upcoming.length,
      }
      void invoke("set_remote_state", { state }).catch(() => {})
    }
  }, [enabled, open, readyCount, remoteClients, upcoming, playbackModes, skin, volume, isMuted, liked])
}
