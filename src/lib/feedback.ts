import { invoke } from "@tauri-apps/api/core"
import { isTauriEnvironment } from "./search"

/**
 * Tactile feedback for detented controls (the player-style wheel): a tiny
 * synthesised click and, on Macs with a Force Touch trackpad, a haptic tick.
 */

export interface FeedbackPrefs {
  sound: boolean
  haptics: boolean
}

const STORAGE_KEY = "dot_feedback"
const DEFAULT_PREFS: FeedbackPrefs = { sound: true, haptics: true }

export function loadFeedbackPrefs(): FeedbackPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const p = JSON.parse(raw) as Partial<FeedbackPrefs>
    return {
      sound: typeof p.sound === "boolean" ? p.sound : DEFAULT_PREFS.sound,
      haptics: typeof p.haptics === "boolean" ? p.haptics : DEFAULT_PREFS.haptics,
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function saveFeedbackPrefs(prefs: FeedbackPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // ignore
  }
}

// ---- Sound -------------------------------------------------------------------

let ctx: AudioContext | null = null
let noise: AudioBuffer | null = null

function audio(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null
  if (!ctx) {
    ctx = new AudioContext()
    // 20ms of white noise, reused for every click.
    noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.02), ctx.sampleRate)
    const data = noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  }
  if (ctx.state === "suspended") void ctx.resume()
  return ctx
}

/** A short mechanical click: band-passed noise transient plus a tiny pitched body. */
function click(freq: number, body: number, level: number) {
  const ac = audio()
  if (!ac || !noise) return
  const t = ac.currentTime + 0.001

  const src = ac.createBufferSource()
  src.buffer = noise
  const band = ac.createBiquadFilter()
  band.type = "bandpass"
  band.frequency.value = freq
  band.Q.value = 1.4
  const nGain = ac.createGain()
  nGain.gain.setValueAtTime(level, t)
  nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.006)
  src.connect(band).connect(nGain).connect(ac.destination)
  src.start(t)
  src.stop(t + 0.02)

  const osc = ac.createOscillator()
  osc.type = "sine"
  osc.frequency.setValueAtTime(body, t)
  osc.frequency.exponentialRampToValueAtTime(body * 0.6, t + 0.012)
  const oGain = ac.createGain()
  oGain.gain.setValueAtTime(level * 0.5, t)
  oGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.012)
  osc.connect(oGain).connect(ac.destination)
  osc.start(t)
  osc.stop(t + 0.02)
}

// ---- Haptics -----------------------------------------------------------------

function haptic(pattern: "alignment" | "level") {
  if (!isTauriEnvironment()) return
  invoke("perform_haptic", { pattern }).catch(() => {
    // Not available (older build / non-mac); feedback is best-effort.
  })
}

// ---- Public API ----------------------------------------------------------------

let lastTick = 0
const MIN_TICK_GAP_MS = 28

/** One detent passed. Throttled so a fast flick ratchets instead of buzzing. */
export function tick(prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  const now = performance.now()
  if (now - lastTick < MIN_TICK_GAP_MS) return
  lastTick = now
  if (prefs.sound) click(3200, 1800, 0.07)
  if (prefs.haptics) haptic("alignment")
}

/** The control came to rest on a new value: a slightly heavier, lower click. */
export function settle(prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  lastTick = performance.now()
  if (prefs.sound) click(2200, 1100, 0.1)
  if (prefs.haptics) haptic("level")
}
