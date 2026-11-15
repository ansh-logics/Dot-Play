import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { useCallback, useEffect, useState } from "react"

/** Mirrors `LinkState` in tv.rs. */
export interface LinkState {
  name: string
  /** The six-digit code a desktop app needs to link this TV. */
  code: string
  linked: Array<{ id: string; name: string }>
  online: string[]
  signedIn: boolean
}

export interface Profile {
  name: string
  email: string
  avatarUrl: string
}

/** The TV's links and who is signed in, kept current as desktops link, connect and leave. */
export function useLink() {
  const [link, setLink] = useState<LinkState | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)

  const refresh = useCallback(() => {
    void invoke<LinkState>("tv_link_state").then(setLink, () => {})
  }, [])

  useEffect(() => {
    refresh()
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen("tv-link-changed", refresh).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [refresh])

  const signedIn = link?.signedIn ?? false
  useEffect(() => {
    if (!signedIn) return
    let cancelled = false
    void invoke<Profile | null>("get_user_profile").then(
      (found) => {
        if (!cancelled) setProfile(found)
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [signedIn])

  const signOut = useCallback(() => {
    void invoke<LinkState>("tv_sign_out").then(setLink, () => {})
  }, [])

  // A profile fetched before a sign-out is stale: only show it while signed in.
  return { link, profile: signedIn ? profile : null, signOut }
}
