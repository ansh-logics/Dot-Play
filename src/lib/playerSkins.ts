/** Visual styles for the full-screen player. Same layout and behaviour; only the look changes. */
export type PlayerSkinId = "apple" | "nothing" | "vinyl" | "cassette"

export interface PlayerSkin {
  id: PlayerSkinId
  label: string
  /** Shown on the wheel as a teaser but not selectable yet. */
  soon?: boolean
}

/** Wheel order, top to bottom. */
export const PLAYER_SKINS: PlayerSkin[] = [
  { id: "cassette", label: "Cassette", soon: true },
  { id: "apple", label: "Apple" },
  { id: "nothing", label: "Nothing" },
  { id: "vinyl", label: "Vinyl" },
]

const STORAGE_KEY = "dot_player_skin"
export const DEFAULT_SKIN: PlayerSkinId = "apple"

const isSelectable = (id: unknown): id is PlayerSkinId =>
  PLAYER_SKINS.some((s) => s.id === id && !s.soon)

export function loadSkin(): PlayerSkinId {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isSelectable(v) ? v : DEFAULT_SKIN
  } catch {
    return DEFAULT_SKIN
  }
}

const listeners = new Set<() => void>()
let current: PlayerSkinId | null = null

/** The chosen style, read from storage once and then kept in memory. */
export function getSkin(): PlayerSkinId {
  current ??= loadSkin()
  return current
}

export function saveSkin(id: PlayerSkinId): void {
  if (!isSelectable(id)) return
  current = id
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // ignore
  }
  listeners.forEach((fn) => fn())
}

/** Notifies when the style is changed in this window (the sidebar card follows it). */
export function subscribeSkin(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const N = PLAYER_SKINS.length

/** Wraps any (possibly negative) wheel position to a skin index. */
export const wrapIndex = (i: number) => ((Math.round(i) % N) + N) % N
