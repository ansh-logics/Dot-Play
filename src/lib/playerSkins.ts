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

export function saveSkin(id: PlayerSkinId): void {
  if (!isSelectable(id)) return
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // ignore
  }
}

const N = PLAYER_SKINS.length

/** Wraps any (possibly negative) wheel position to a skin index. */
export const wrapIndex = (i: number) => ((Math.round(i) % N) + N) % N

/**
 * The wheel loops, so `pos` is unbounded. Returns the integer position closest to `pos`
 * whose skin is selectable, so snapping never spins the long way round.
 */
export function nearestSelectablePosition(pos: number): number {
  const base = Math.round(pos)
  for (let step = 0; step <= N; step++) {
    // Prefer the side `pos` is already leaning towards on ties.
    const order = pos >= base ? [base + step, base - step] : [base - step, base + step]
    for (const candidate of order) {
      if (!PLAYER_SKINS[wrapIndex(candidate)].soon) return candidate
    }
  }
  return base
}
