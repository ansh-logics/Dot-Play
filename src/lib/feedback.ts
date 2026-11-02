import { invoke } from "@tauri-apps/api/core"
import { isTauriEnvironment } from "./search"

/**
 * Tactile feedback for detented controls (the player-style wheel): a tiny
 * synthesised click and, on Macs with a Force Touch trackpad, a haptic tick.
 */

export interface FeedbackPrefs {
  sound: boolean
  haptics: boolean
  /** A faint tape hiss under the music in the Cassette style. */
  hiss: boolean
}

const STORAGE_KEY = "dot_feedback"
const DEFAULT_PREFS: FeedbackPrefs = { sound: true, haptics: true, hiss: true }

export function loadFeedbackPrefs(): FeedbackPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const p = JSON.parse(raw) as Partial<FeedbackPrefs>
    return {
      sound: typeof p.sound === "boolean" ? p.sound : DEFAULT_PREFS.sound,
      haptics: typeof p.haptics === "boolean" ? p.haptics : DEFAULT_PREFS.haptics,
      hiss: typeof p.hiss === "boolean" ? p.hiss : DEFAULT_PREFS.hiss,
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

const prefListeners = new Set<() => void>()

export function saveFeedbackPrefs(prefs: FeedbackPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // ignore
  }
  prefListeners.forEach((fn) => fn())
}

/** Notifies when the prefs change (the deck turns its hiss on or off right away). */
export function subscribeFeedbackPrefs(listener: () => void): () => void {
  prefListeners.add(listener)
  return () => prefListeners.delete(listener)
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
  if (ctx.state === "suspended") {
    void ctx.resume()
    armUnlock()
  }
  return ctx
}

let unlockArmed = false

/**
 * WebKit keeps audio paused until a click or key press, so sound started any other way (the
 * tape hiss, which starts when the deck opens) would stay silent. Resume on the next one.
 */
function armUnlock() {
  if (unlockArmed) return
  unlockArmed = true
  const unlock = () => {
    unlockArmed = false
    window.removeEventListener("pointerdown", unlock, true)
    window.removeEventListener("keydown", unlock, true)
    void ctx?.resume()
  }
  window.addEventListener("pointerdown", unlock, true)
  window.addEventListener("keydown", unlock, true)
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

function haptic(pattern: "alignment" | "level" | "generic") {
  if (!isTauriEnvironment()) return
  invoke("perform_haptic", { pattern }).catch(() => {
    // Not available (older build / non-mac); feedback is best-effort.
  })
}

// ---- Public API ----------------------------------------------------------------

let lastTick = 0
const MIN_TICK_GAP_MS = 28

/** Below this gap a haptic per notch turns into a buzz, so a fast spin only clicks. */
const MIN_HAPTIC_GAP_MS = 45
let lastHaptic = 0

/** Up to ±`amount` of random variation, so repeated clicks don't sound machine-made. */
const jitter = (amount: number) => 1 + (Math.random() * 2 - 1) * amount

/**
 * One detent passed. `speed` is in notches per second: a fast spin clicks lighter and
 * higher, a slow turn heavier and lower, like a real ratchet. Throttled so a fast flick
 * ratchets instead of buzzing.
 */
export function tick(speed = 0, prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  const now = performance.now()
  if (now - lastTick < MIN_TICK_GAP_MS) return
  lastTick = now
  const fast = Math.min(1, Math.max(0, (speed - 3) / 20)) // 0 slow … 1 flung
  if (prefs.sound) click(2700 * (1 + fast * 0.35) * jitter(0.06), 1500 * (1 + fast * 0.3), 0.085 * (1 - fast * 0.45) * jitter(0.12))
  if (prefs.haptics && now - lastHaptic >= MIN_HAPTIC_GAP_MS) {
    lastHaptic = now
    haptic("alignment")
  }
}

/** Hit a stop (a style that isn't out yet): two dull, low knocks. */
export function reject(prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  lastTick = performance.now()
  if (prefs.sound) {
    click(900, 260, 0.16)
    window.setTimeout(() => click(760, 220, 0.11), 85)
  }
  if (prefs.haptics) {
    haptic("generic")
    window.setTimeout(() => haptic("generic"), 85)
  }
}

/** The control came to rest on a new value: a slightly heavier, lower click. */
export function settle(prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  lastTick = performance.now()
  if (prefs.sound) click(2200, 1100, 0.1)
  if (prefs.haptics) haptic("level")
}

/** A deck key going down: a short, firm mechanical click. */
export function keyPress(prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  if (prefs.sound) click(1700 * jitter(0.05), 650, 0.17)
  if (prefs.haptics) haptic("generic")
}

/** A cassette seating and the deck door shutting: a low clunk with a small rattle after it. */
export function clunk(prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  if (prefs.sound) {
    click(620, 150, 0.2)
    window.setTimeout(() => click(1500, 520, 0.05), 45)
  }
  if (prefs.haptics) haptic("level")
}

// ---- Cassette deck ---------------------------------------------------------------
// Everything is synthesised (no audio files): noise shaped by filters for tape and air,
// low oscillators for the capstan motor, short clicks for plastic and metal.

let tapeNoise: AudioBuffer | null = null

/** Two seconds of white noise, looped for hiss and winding. */
function longNoise(ac: AudioContext): AudioBuffer {
  if (!tapeNoise) {
    tapeNoise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate)
    const data = tapeNoise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  }
  return tapeNoise
}

/** Filtered noise with an attack/hold/release envelope, optionally sweeping its frequency. */
function noiseSwell(o: { freq: number; freqTo?: number; q?: number; level: number; attack: number; hold: number; release: number; delay?: number }) {
  const ac = audio()
  if (!ac) return
  const t = ac.currentTime + 0.005 + (o.delay ?? 0)
  const end = t + o.attack + o.hold + o.release
  const src = ac.createBufferSource()
  src.buffer = longNoise(ac)
  src.loop = true
  const band = ac.createBiquadFilter()
  band.type = "bandpass"
  band.Q.value = o.q ?? 0.8
  band.frequency.setValueAtTime(o.freq, t)
  if (o.freqTo) band.frequency.exponentialRampToValueAtTime(o.freqTo, end)
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(o.level, t + o.attack)
  g.gain.setValueAtTime(o.level, t + o.attack + o.hold)
  g.gain.exponentialRampToValueAtTime(0.0001, end)
  src.connect(band).connect(g).connect(ac.destination)
  src.start(t, Math.random())
  src.stop(end + 0.02)
}

/** A low motor tone gliding between two pitches (the capstan spinning up or down). */
function motor(from: number, to: number, dur: number, level: number, delay = 0) {
  const ac = audio()
  if (!ac) return
  const t = ac.currentTime + 0.005 + delay
  const osc = ac.createOscillator()
  osc.type = "sawtooth"
  osc.frequency.setValueAtTime(from, t)
  osc.frequency.exponentialRampToValueAtTime(to, t + dur)
  const lp = ac.createBiquadFilter()
  lp.type = "lowpass"
  lp.frequency.value = 420
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(level, t + dur * 0.25)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  osc.connect(lp).connect(g).connect(ac.destination)
  osc.start(t)
  osc.stop(t + dur + 0.02)
}

const later = (ms: number, fn: () => void) => window.setTimeout(fn, ms)

/** PLAY pressed: the key thunks down and the motor spins the tape up to speed. */
export function tapeStart(prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  if (!prefs.sound) return
  click(850, 190, 0.2)
  motor(48, 118, 0.5, 0.08, 0.02)
  noiseSwell({ freq: 700, freqTo: 1500, level: 0.04, attack: 0.08, hold: 0.15, release: 0.25, delay: 0.02 })
}

/** PAUSE / stop: a lighter key click and the motor winding down. */
export function tapeStop(prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  if (!prefs.sound) return
  click(1100, 260, 0.16)
  motor(118, 36, 0.42, 0.065)
}

/** Fast-forward / rewind whirr for a seek; `forward` sweeps up, back sweeps down. */
export function tapeWind(forward: boolean, prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  if (!prefs.sound) return
  noiseSwell({ freq: forward ? 1100 : 2600, freqTo: forward ? 2600 : 1100, q: 2.2, level: 0.05, attack: 0.05, hold: 0.32, release: 0.18 })
  motor(forward ? 140 : 260, forward ? 260 : 140, 0.55, 0.03)
  later(560, () => click(1400, 420, 0.07)) // the wind button pops back up
}

/** The end of the tape: clear leader hisses past the head, then the auto-stop clacks. */
export function tapeRunOut(prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  if (!prefs.sound) return
  noiseSwell({ freq: 4200, q: 0.6, level: 0.035, attack: 0.15, hold: 0.25, release: 0.2 })
  later(600, () => click(700, 170, 0.16))
  later(680, () => click(1300, 380, 0.08))
}

/** The door's latch letting go. */
export function doorRelease(prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  if (!prefs.sound) return
  click(2600, 900, 0.06)
  motor(150, 90, 0.18, 0.012)
}

/** A cassette sliding into the holder: a quick plastic clatter. */
export function tapeClatter(prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  if (!prefs.sound) return
  click(2400 * jitter(0.08), 900, 0.11)
  later(32, () => click(2000 * jitter(0.08), 760, 0.09))
  later(75, () => click(2800 * jitter(0.08), 1000, 0.07))
}

/** Running a finger along the tapes in the crate: a tiny tick per tape. */
export function tapeFlick(prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  if (!prefs.sound) return
  click(3200 * jitter(0.1), 1400, 0.045)
}

/** Taking a tape out of the crate. */
export function tapePickUp(prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  if (!prefs.sound) return
  click(2800 * jitter(0.06), 1200, 0.05)
  later(26, () => click(2100 * jitter(0.06), 800, 0.04))
}

/** The crate's tapes knocking together as they pop up: one small click each, staggered. */
export function crateRattle(count: number, prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  if (!prefs.sound) return
  for (let i = 0; i < Math.min(count, 6); i++) {
    later(i * 42 + Math.random() * 12, () => click(2200 + Math.random() * 1200, 900, 0.035))
  }
}

// Tape hiss: a quiet, steady bed of high, soft noise while the tape plays.
let hissNodes: { src: AudioBufferSourceNode; gain: GainNode } | null = null
const HISS_LEVEL = 0.032

/** Fade the hiss in (playing) or out (paused, stopped, or the deck going away). */
export function setTapeHiss(on: boolean, prefs: FeedbackPrefs = loadFeedbackPrefs()): void {
  const ac = audio()
  if (!ac) return
  const t = ac.currentTime
  if (on && prefs.hiss) {
    if (!hissNodes) {
      const src = ac.createBufferSource()
      src.buffer = longNoise(ac)
      src.loop = true
      const hp = ac.createBiquadFilter()
      hp.type = "highpass"
      hp.frequency.value = 2800
      const lp = ac.createBiquadFilter()
      lp.type = "lowpass"
      lp.frequency.value = 9500
      const gain = ac.createGain()
      gain.gain.value = 0.0001
      src.connect(hp).connect(lp).connect(gain).connect(ac.destination)
      src.start()
      hissNodes = { src, gain }
    }
    hissNodes.gain.gain.cancelScheduledValues(t)
    hissNodes.gain.gain.setTargetAtTime(HISS_LEVEL, t, 0.25)
    return
  }
  if (!hissNodes) return
  const nodes = hissNodes
  hissNodes = null
  nodes.gain.gain.cancelScheduledValues(t)
  nodes.gain.gain.setTargetAtTime(0.0001, t, 0.12)
  nodes.src.stop(t + 0.8)
}
