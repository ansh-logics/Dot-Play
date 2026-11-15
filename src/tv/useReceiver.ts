import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { useCallback, useEffect, useRef, useState } from "react"
import type { usePlayer } from "./usePlayer"

/**
 * The TV as a receiver: does what a linked desktop says (load, play, pause, seek, volume),
 * and tells it what the player is doing. The desktop keeps the queue; the TV plays one song
 * at a time and reports when it ends. Mirrors src/lib/tvOutput.ts on the desktop.
 */

export interface TrackInfo {
  videoId: string
  title: string
  artist: string
  thumb: string
}

export interface NowShowing {
  track: TrackInfo | null
  upcoming: TrackInfo[]
}

type Command =
  | { t: "now"; track: TrackInfo | null; upcoming?: TrackInfo[] }
  | { t: "load"; videoId: string; start?: number; autoplay?: boolean }
  | { t: "play" | "pause" | "stop" }
  | { t: "seek"; seconds: number }
  | { t: "volume"; volume: number }
  | { t: "mute"; muted: boolean }

/** A song that hasn't started this long after being asked to is treated as unplayable:
 *  YouTube shows "video unavailable" for some songs without ever raising an error. */
const START_TIMEOUT_MS = 15000
const REPORTED_STATES = new Set(["unstarted", "buffering", "playing", "paused", "ended", "cued"])

const report = (message: Record<string, unknown>) => void invoke("tv_report", { message }).catch(() => {})

/** `onTakeover` runs when a desktop starts playing here (whatever the TV was playing stops). */
export function useReceiver(player: ReturnType<typeof usePlayer>, onTakeover: () => void) {
  const [now, setNow] = useState<NowShowing | null>(null)
  const onTakeoverRef = useRef(onTakeover)
  onTakeoverRef.current = onTakeover
  const nowRef = useRef(now)
  nowRef.current = now
  const { snapshot, load, play, pause, seek, setVolume, setMuted } = player
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  /** True from "load with autoplay" until the song first plays (or fails). */
  const awaitingStartRef = useRef(false)

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen<Command>("tv-command", ({ payload }) => {
      switch (payload.t) {
        case "now":
          setNow({ track: payload.track ?? null, upcoming: payload.upcoming ?? [] })
          break
        case "load":
          if (typeof payload.videoId !== "string" || !payload.videoId) break
          awaitingStartRef.current = payload.autoplay !== false
          onTakeoverRef.current()
          load(payload.videoId, payload.start ?? 0, payload.autoplay !== false)
          break
        case "play":
          play()
          break
        case "pause":
          pause()
          break
        case "seek":
          if (Number.isFinite(payload.seconds)) seek(payload.seconds)
          break
        case "volume":
          if (Number.isFinite(payload.volume)) setVolume(Math.max(0, Math.min(100, payload.volume)))
          break
        case "mute":
          setMuted(Boolean(payload.muted))
          break
        case "stop":
          // The desktop took playback back. (Ignored when the TV is playing its own music,
          // which is what made the desktop let go in the first place.)
          if (!nowRef.current) break
          awaitingStartRef.current = false
          pause()
          setNow(null)
          break
      }
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [load, play, pause, seek, setVolume, setMuted])

  const sendState = () => {
    const s = snapshotRef.current
    if (!s.videoId || !REPORTED_STATES.has(s.state)) return
    report({ t: "state", videoId: s.videoId, state: s.state, time: s.currentTime, duration: s.duration })
  }

  // Every change of state at once; the position once a second while playing.
  useEffect(() => {
    if (snapshot.state === "playing") awaitingStartRef.current = false
    if (snapshot.state === "error" && snapshot.videoId) {
      awaitingStartRef.current = false
      report({ t: "error", videoId: snapshot.videoId, code: snapshot.errorCode ?? -1 })
      return
    }
    sendState()
    if (snapshot.state !== "playing") return
    const timer = setInterval(sendState, 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.state, snapshot.videoId, snapshot.errorCode])

  // The duration arrives a moment after "playing"; pass it on when it does.
  useEffect(() => {
    if (snapshot.duration > 0) sendState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.duration])

  useEffect(() => {
    if (!snapshot.videoId) return
    const videoId = snapshot.videoId
    const timer = setTimeout(() => {
      if (awaitingStartRef.current && snapshotRef.current.videoId === videoId) {
        awaitingStartRef.current = false
        // 150: "can't be played in an embedded player", which the desktop skips past.
        report({ t: "error", videoId, code: 150 })
      }
    }, START_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [snapshot.videoId])

  /** Next / Previous on the TV's remote: the desktop's queue decides what that means. */
  const sendKey = useCallback((key: "next" | "previous") => report({ t: "key", key }), [])

  /** The TV started playing something of its own: tell the desktops and stop following them. */
  const release = useCallback(() => {
    awaitingStartRef.current = false
    setNow((was) => {
      if (was) report({ t: "local" })
      return null
    })
  }, [])

  return { now, sendKey, release }
}
