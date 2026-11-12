import { invoke } from "@tauri-apps/api/core"
import { useCallback, useEffect, useRef, useState } from "react"

/**
 * The TV's playback engine: the same YouTube player bridge page the desktop app uses
 * (served by the Rust side on 127.0.0.1), in an off-screen iframe, driven by postMessage.
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

const STATES: Record<number, PlayerState> = { [-1]: "unstarted", 0: "ended", 1: "playing", 2: "paused", 3: "buffering", 5: "cued" }

export function usePlayer() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const originRef = useRef("")
  const readyRef = useRef(false)
  const pendingRef = useRef<Record<string, unknown>[]>([])
  const [src, setSrc] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>({
    state: "loading",
    videoId: "",
    currentTime: 0,
    duration: 0,
    volume: 100,
    errorCode: null,
  })

  useEffect(() => {
    let cancelled = false
    invoke<string | null>("get_player_server_url")
      .then((url) => {
        if (cancelled || !url) return
        const parsed = new URL(url)
        parsed.searchParams.set("parentOrigin", window.location.origin)
        originRef.current = parsed.origin
        setSrc(parsed.toString())
      })
      .catch(() => setSnapshot((s) => ({ ...s, state: "error", errorCode: -2 })))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!originRef.current || event.origin !== originRef.current) return
      const msg = event.data as { type?: string; stateCode?: number; code?: number; currentTime?: number; duration?: number; volume?: number }
      if (!msg || typeof msg !== "object") return
      if (msg.type === "ready") {
        readyRef.current = true
        setSnapshot((s) => ({ ...s, state: "ready" }))
        for (const action of pendingRef.current.splice(0)) post(action)
      } else if (msg.type === "stateChange") {
        setSnapshot((s) => ({ ...s, state: STATES[msg.stateCode ?? -1] ?? "unstarted", errorCode: null }))
      } else if (msg.type === "timeUpdate") {
        setSnapshot((s) => ({
          ...s,
          currentTime: msg.currentTime ?? s.currentTime,
          duration: msg.duration ?? s.duration,
          volume: msg.volume ?? s.volume,
        }))
      } else if (msg.type === "error") {
        setSnapshot((s) => ({ ...s, state: "error", errorCode: msg.code ?? -1 }))
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function post(action: Record<string, unknown>) {
    if (!readyRef.current) {
      pendingRef.current.push(action)
      return
    }
    iframeRef.current?.contentWindow?.postMessage(action, originRef.current)
  }

  const load = useCallback((videoId: string, startSeconds = 0, autoplay = true) => {
    setSnapshot((s) => ({ ...s, videoId, currentTime: startSeconds, duration: 0, errorCode: null }))
    post({ action: autoplay ? "loadVideo" : "cueVideo", videoId, startSeconds })
  }, [])
  const play = useCallback(() => post({ action: "play" }), [])
  const pause = useCallback(() => post({ action: "pause" }), [])
  const seek = useCallback((seconds: number) => post({ action: "seekTo", seconds: Math.max(0, seconds) }), [])
  const setVolume = useCallback((volume: number) => post({ action: "setVolume", volume }), [])

  return { iframeRef, src, snapshot, load, play, pause, seek, setVolume }
}
