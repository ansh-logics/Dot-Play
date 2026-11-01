import { useEffect, useState } from "react"
import { emit, listen } from "@tauri-apps/api/event"
import { cleanDisplayTitle } from "./displayText"
import type { ImmersiveState } from "./immersive"
import type { PlayerSkinId } from "./playerSkins"
import { isTauriEnvironment, type SearchResult } from "./search"

interface ImmersiveBridgeOptions {
  skin: PlayerSkinId
  upcoming: SearchResult[]
}

/**
 * Feeds the immersive windows the player style and the next song. Track info and
 * playback already reach them through `now-playing`. Nothing is sent while immersive
 * mode is closed (Rust reports open/closed with `immersive-visibility`).
 */
export function useImmersiveBridge({ skin, upcoming }: ImmersiveBridgeOptions) {
  const enabled = isTauriEnvironment()
  const [open, setOpen] = useState(false)
  // Bumped each time an immersive window has loaded and is listening.
  const [readyCount, setReadyCount] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    const unlisteners: Array<() => void> = []
    const keep = (fn: () => void) => (disposed ? fn() : unlisteners.push(fn))

    void listen<{ open: boolean }>("immersive-visibility", ({ payload }) => setOpen(payload.open)).then(keep)
    void listen("immersive-ready", () => {
      setOpen(true)
      setReadyCount((n) => n + 1)
    }).then(keep)

    return () => {
      disposed = true
      unlisteners.forEach((fn) => fn())
    }
  }, [enabled])

  const next = upcoming[0]
  const nextTitle = next ? cleanDisplayTitle(next.title) : null
  const nextArtist = next?.artist ?? ""

  useEffect(() => {
    if (!enabled || !open) return
    const state: ImmersiveState = {
      skin,
      next: nextTitle ? { title: nextTitle, artist: nextArtist } : null,
    }
    void emit("immersive-state", state).catch(() => {})
  }, [enabled, open, readyCount, skin, nextTitle, nextArtist])
}
