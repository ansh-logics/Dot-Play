import { useEffect, useSyncExternalStore } from "react"
import { invoke } from "@tauri-apps/api/core"
import { isTauriEnvironment } from "./search"

/** YouTube Music's like states, as its API spells them. */
export type LikeStatus = "LIKE" | "DISLIKE" | "INDIFFERENT"

/**
 * Which songs the signed-in user likes, shared by every heart in the app (player, sidebar,
 * menu bar, right-click menu) so they always agree. Filled in lazily per song from YouTube
 * Music, and changed optimistically: the heart fills at once and springs back if the
 * request fails.
 */
const statuses = new Map<string, LikeStatus>()
const inFlight = new Set<string>()
/** Bumped per song on every change, so a slow answer can't overwrite a newer click. */
const versions = new Map<string, number>()
const listeners = new Set<() => void>()

const notify = () => listeners.forEach((fn) => fn())
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function set(videoId: string, status: LikeStatus) {
  if (statuses.get(videoId) === status) return
  statuses.set(videoId, status)
  notify()
}

async function load(videoId: string) {
  if (!isTauriEnvironment() || statuses.has(videoId) || inFlight.has(videoId)) return
  inFlight.add(videoId)
  const version = versions.get(videoId) ?? 0
  try {
    const status = await invoke<LikeStatus>("get_like_status", { videoId })
    // A click while this was loading already decided the state.
    if ((versions.get(videoId) ?? 0) === version) set(videoId, status)
  } catch {
    // Unknown stays unknown; the next look at this song asks again.
  } finally {
    inFlight.delete(videoId)
  }
}

/** The like state of a song, fetched the first time it's asked for. Undefined until known. */
export function useLikeStatus(videoId: string | undefined, enabled: boolean): LikeStatus | undefined {
  const status = useSyncExternalStore(subscribe, () => (videoId ? statuses.get(videoId) : undefined))
  useEffect(() => {
    if (enabled && videoId) void load(videoId)
  }, [videoId, enabled])
  return enabled ? status : undefined
}

/** Likes or unlikes a song. Rejects (after putting the old state back) when YouTube Music refuses. */
export async function setLiked(videoId: string, liked: boolean): Promise<void> {
  const previous = statuses.get(videoId)
  const version = (versions.get(videoId) ?? 0) + 1
  versions.set(videoId, version)
  const next: LikeStatus = liked ? "LIKE" : "INDIFFERENT"
  set(videoId, next)
  try {
    await invoke("rate_song", { videoId, rating: next })
  } catch (error) {
    if (versions.get(videoId) === version) {
      if (previous) set(videoId, previous)
      else {
        statuses.delete(videoId)
        notify()
      }
    }
    throw error
  }
}

export const isLiked = (videoId: string) => statuses.get(videoId) === "LIKE"

/** Forgets every song's state, on sign-out. */
export function clearLikes() {
  statuses.clear()
  versions.clear()
  notify()
}
