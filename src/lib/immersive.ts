import { invoke } from "@tauri-apps/api/core"
import type { PlayerSkinId } from "./playerSkins"
import { isTauriEnvironment } from "./search"

/** What the main window tells the immersive windows (see useImmersiveBridge). */
export interface ImmersiveState {
  skin: PlayerSkinId
  next: { title: string; artist: string } | null
}

/** What each display shows. */
export type ImmersiveView = "stage" | "lyrics" | "art"
/** A display's setting: a view, or not used for immersive mode. */
export type DisplayChoice = ImmersiveView | "off"

/** A display as Rust lists it (see list_immersive_displays), in logical points. */
export interface ImmersiveDisplay {
  key: string
  name: string
  x: number
  y: number
  width: number
  height: number
  pixelWidth: number
  pixelHeight: number
  /** The display dot(.)music is on. */
  isAppDisplay: boolean
}

const VIEWS_KEY = "dot_immersive_views"

/** The display dot(.)music is on shows the clock, the next one lyrics, the rest artwork. */
export function defaultView(index: number): ImmersiveView {
  if (index === 0) return "stage"
  return index === 1 ? "lyrics" : "art"
}

const isChoice = (v: unknown): v is DisplayChoice => v === "stage" || v === "lyrics" || v === "art" || v === "off"

/** Choices saved per display key; displays not in here use `defaultView`. */
export function loadDisplayChoices(): Record<string, DisplayChoice> {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "{}") as Record<string, unknown>
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, DisplayChoice] => isChoice(e[1])))
  } catch {
    return {}
  }
}

export function saveDisplayChoice(key: string, choice: DisplayChoice): void {
  const all = { ...loadDisplayChoices(), [key]: choice }
  try {
    localStorage.setItem(VIEWS_KEY, JSON.stringify(all))
  } catch {
    // ignore
  }
  applyDisplayChoices(all)
}

/** Rust only needs to know which displays are off; it starts each launch with this. */
export function applyDisplayChoices(choices: Record<string, DisplayChoice> = loadDisplayChoices()): void {
  if (!isTauriEnvironment()) return
  const off = Object.entries(choices).filter(([, c]) => c === "off").map(([key]) => key)
  void invoke("set_immersive_screens", { off }).catch(() => {})
}

export function listDisplays(): Promise<ImmersiveDisplay[]> {
  if (!isTauriEnvironment()) return Promise.resolve([])
  return invoke<ImmersiveDisplay[]>("list_immersive_displays").catch(() => [])
}

export const IDLE_CHOICES = [0, 2, 5, 10] as const
export type IdleMinutes = (typeof IDLE_CHOICES)[number]

const IDLE_KEY = "dot_immersive_idle"
const DEFAULT_IDLE: IdleMinutes = 5

/** Minutes without input before immersive mode starts while music plays; 0 = never. */
export function loadIdleMinutes(): IdleMinutes {
  try {
    const saved = localStorage.getItem(IDLE_KEY)
    const v = Number(saved)
    return saved !== null && (IDLE_CHOICES as readonly number[]).includes(v) ? (v as IdleMinutes) : DEFAULT_IDLE
  } catch {
    return DEFAULT_IDLE
  }
}

export function saveIdleMinutes(minutes: IdleMinutes): void {
  try {
    localStorage.setItem(IDLE_KEY, String(minutes))
  } catch {
    // ignore
  }
  applyIdleMinutes(minutes)
}

/** The idle timer runs in Rust; it starts each launch with this. */
export function applyIdleMinutes(minutes: IdleMinutes): void {
  if (!isTauriEnvironment()) return
  void invoke("set_immersive_idle", { minutes }).catch(() => {})
}

export function openImmersive(): void {
  if (!isTauriEnvironment()) return
  void invoke("open_immersive").catch(() => {})
}

/**
 * Shows or stops showing immersive mode on one display, right away and next time. A display
 * turned back on gets the view it had before (or its default).
 */
export function setDisplayOn(key: string, index: number, on: boolean): void {
  const saved = loadDisplayChoices()[key]
  saveDisplayChoice(key, on ? (saved && saved !== "off" ? saved : defaultView(index)) : "off")
  void invoke("set_immersive_display", { key, on }).catch(() => {})
}

/** Esc in immersive mode: back one step, to the full-screen player. */
export function leaveToPlayer(): void {
  void invoke("leave_immersive_to_player").catch(() => {})
}

export function closeImmersive(): void {
  void invoke("close_immersive").catch(() => {})
}
