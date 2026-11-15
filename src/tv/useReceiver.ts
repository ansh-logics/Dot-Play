import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { useCallback, useEffect, useRef, useState } from "react"
import type { Track } from "./data"
import type { PlayerState, usePlayer } from "./usePlayer"

/**
 * The TV's side of a connected desktop. The desktop keeps the queue and this TV always shows
 * it: what is playing, what's next, and where the sound is coming out ("tv" or "desktop").
 * When it is the speaker it does what the desktop says (load, play, pause, seek, volume) and
 * reports what its player is doing; either way the remote drives the desktop's queue.
 * Mirrors src/lib/tvOutput.ts and the TV parts of src/lib/usePlayback.ts on the desktop.
 */

export type TrackInfo = Track

export interface NowShowing {
  track: TrackInfo
  upcoming: TrackInfo[]
  /** Where the sound comes out: this TV, or the desktop itself. */
  on: "tv" | "desktop"
}

/** Where the desktop's own player is, for when this TV only shows it. */
export interface RemotePosition {
  videoId: string
  state: PlayerState
  time: number
  duration: number
  /** `performance.now()` when it was told. */
  at: number
}

type Command =
  | { t: "now"; track: TrackInfo | null; upcoming?: TrackInfo[]; on?: "tv" | "desktop" }
  | { t: "pos"; videoId: string; state: PlayerState; time: number; duration: number }
  | { t: "load"; videoId: string; start?: number; autoplay?: boolean }
  | { t: "play" | "pause" | "stop" }
  | { t: "seek"; seconds: number }
  | { t: "volume"; volume: number }
  | { t: "mute"; muted: boolean }

/** What the remote can ask of the desktop's queue. */
export type RemoteCommand =
  | { cmd: "toggle" | "play" | "pause" | "next" | "previous" }
  | { cmd: "seek"; seconds: number }

/** A song that hasn't started this long after being asked to is treated as unplayable:
 *  YouTube shows "video unavailable" for some songs without ever raising an error. */
const START_TIMEOUT_MS = 15000
const REPORTED_STATES = new Set(["unstarted", "buffering", "playing", "paused", "ended", "cued"])

const report = (message: Record<string, unknown>) => void invoke("tv_report", { message }).catch(() => {})

interface ReceiverOptions {
  /** The TV is playing a queue of its own (no desktop is deciding what plays). */
  ownQueue: boolean
  /** A desktop starts playing here: whatever the TV was playing by itself stops. */
  onTakeover: () => void
}

export function useReceiver(player: ReturnType<typeof usePlayer>, options: ReceiverOptions) {
  const [now, setNow] = useState<NowShowing | null>(null)
  const [remote, setRemote] = useState<RemotePosition | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options
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
          setNow(
            payload.track?.videoId
              ? { track: payload.track, upcoming: payload.upcoming ?? [], on: payload.on === "desktop" ? "desktop" : "tv" }
              : null,
          )
          break
        case "pos":
          if (typeof payload.videoId !== "string" || !Number.isFinite(payload.time)) break
          setRemote({
            videoId: payload.videoId,
            state: REPORTED_STATES.has(payload.state) ? payload.state : "paused",
            time: payload.time,
            duration: Number.isFinite(payload.duration) ? payload.duration : 0,
            at: performance.now(),
          })
          break
        case "load":
          if (typeof payload.videoId !== "string" || !payload.videoId) break
          awaitingStartRef.current = payload.autoplay !== false
          optionsRef.current.onTakeover()
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
          // The sound moved to the desktop (or another TV). Not for music the TV is playing
          // by itself, which no desktop started.
          if (optionsRef.current.ownQueue) break
          awaitingStartRef.current = false
          pause()
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

  /** The remote, for the desktop's queue: play, pause, next, previous, seek. */
  const command = useCallback((request: RemoteCommand) => report({ t: "cmd", ...request }), [])

  /** "Play on this TV": the desktop moves the sound here. */
  const take = useCallback(() => report({ t: "take" }), [])
  /** "Play on the computer": the desktop takes the sound back. */
  const give = useCallback(() => report({ t: "give" }), [])

  /** Music chosen on the TV: the desktop's queue plays it, on this TV. */
  const pick = useCallback((tracks: Track[], index: number) => report({ t: "pick", tracks, index }), [])

  /** What the TV has been playing by itself, for a desktop that just connected to carry on with. */
  const offer = useCallback((tracks: Track[]) => {
    const s = snapshotRef.current
    report({ t: "adopt", tracks, time: s.currentTime, duration: s.duration, state: REPORTED_STATES.has(s.state) ? s.state : "paused" })
  }, [])

  /** Every desktop has gone: nothing of theirs is left to show. */
  const forget = useCallback(() => {
    awaitingStartRef.current = false
    setNow(null)
    setRemote(null)
  }, [])

  return { now, remote, command, take, give, pick, offer, forget }
}

/** The position of a song playing on the desktop: counted on from what it last said. */
export function useRemoteTime(remote: RemotePosition | null): number {
  const [, tick] = useState(0)
  const playing = remote?.state === "playing"
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(timer)
  }, [playing])
  if (!remote) return 0
  const time = playing ? remote.time + (performance.now() - remote.at) / 1000 : remote.time
  return remote.duration > 0 ? Math.min(time, remote.duration) : time
}
