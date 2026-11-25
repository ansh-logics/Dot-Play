import { useSyncExternalStore } from "react"

/** GTA mode: the sunset theme across the app plus the radio wheel. Off by default. */
const STORAGE_KEY = "dot_gta_mode"

const listeners = new Set<() => void>()
let current: boolean | null = null

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

export function getGtaMode(): boolean {
  current ??= read()
  return current
}

export function setGtaMode(on: boolean): void {
  current = on
  try {
    if (on) localStorage.setItem(STORAGE_KEY, "1")
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
  listeners.forEach((fn) => fn())
}

export function subscribeGtaMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useGtaMode(): boolean {
  return useSyncExternalStore(subscribeGtaMode, getGtaMode)
}
