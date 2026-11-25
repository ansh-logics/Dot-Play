import { useEffect, useRef, useState } from "react"
import { Pause, Play, Power, SkipForward } from "lucide-react"
import { CAR_COLORS } from "./car"
import { DriveEngine, QUALITY_LABELS, TIMES, type DriveFrame, type DriveInput, type QualitySetting, type TimeOfDay } from "./engine"
import { stationTitle } from "../lib/radioStations"
import type { SearchResult } from "../lib/search"
import type { RadioController } from "../lib/useRadio"
import { StationBadge } from "../components/radio/StationBadge"
import { RadioView } from "../views/RadioView"
import "./drive.css"

interface GtaDriveProps {
  radio: RadioController
  currentTrack: SearchResult | null
  isPlaying: boolean
  /** The radio wheel is open (it owns Esc and the arrow keys then). */
  wheelOpen: boolean
  onOpenWheel: () => void
  onTogglePlay: () => void
  onNext: () => void
  onExit: () => void
}

// Keyed by KeyboardEvent.code: e.key changes with Shift and layout, e.code doesn't.
const DRIVE_KEYS: Record<string, keyof DriveInput> = {
  KeyW: "throttle", ArrowUp: "throttle",
  KeyS: "brake", ArrowDown: "brake",
  KeyA: "left", ArrowLeft: "left",
  KeyD: "right", ArrowRight: "right",
  ShiftLeft: "boost", ShiftRight: "boost",
}

const SEED_KEY = "dot_drive_seed"
const QUALITY_KEY = "dot_drive_quality"
const FPS_CAP_KEY = "dot_drive_fps_cap"
const FPS_CAPS = [
  { value: 0, label: "Uncapped" },
  { value: 60, label: "60 fps" },
  { value: 30, label: "30 fps" },
]
const CAR_COLOR_KEY = "dot_drive_car_color"
const CLASSIC_KEY = "dot_drive_classic_car"
const readKey = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const writeKey = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k)
    else localStorage.setItem(k, v)
  } catch {
    // ignore
  }
}
function loadQuality(): QualitySetting {
  try {
    const v = localStorage.getItem(QUALITY_KEY)
    return v === "low" || v === "medium" || v === "high" ? v : "auto"
  } catch {
    return "auto"
  }
}
function loadSeed() {
  try {
    const v = Number(localStorage.getItem(SEED_KEY))
    if (Number.isFinite(v) && v > 0) return v
    const seed = Math.floor(Math.random() * 1e9) + 1
    localStorage.setItem(SEED_KEY, String(seed))
    return seed
  } catch {
    return 1986
  }
}

/**
 * GTA mode: the whole window becomes an endless coastal drive at golden hour, and the
 * radio is the only way to pick music. Esc opens the menu (stations, time of day, exit).
 */
export default function GtaDrive(props: GtaDriveProps) {
  const { radio, currentTrack, isPlaying, wheelOpen, onOpenWheel, onTogglePlay, onNext, onExit } = props
  const stageRef = useRef<HTMLDivElement>(null)
  const speedRef = useRef<HTMLSpanElement>(null)
  const odoRef = useRef<HTMLSpanElement>(null)
  const statsRef = useRef<HTMLPreElement>(null)
  const [showStats, setShowStats] = useState(false)
  const engineRef = useRef<DriveEngine | null>(null)
  const inputRef = useRef<DriveInput>({ throttle: false, brake: false, left: false, right: false, boost: false })
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hud, setHud] = useState<Pick<DriveFrame, "autopilot" | "time" | "camera">>({
    autopilot: true,
    time: "sunset",
    camera: "chase",
  })
  const [showHints, setShowHints] = useState(true)
  const [loading, setLoading] = useState(true)
  const [wallpaper, setWallpaper] = useState(true)
  const [quality, setQualityState] = useState<QualitySetting>(loadQuality)
  const [activeQuality, setActiveQuality] = useState<string>("")
  const [struggling, setStruggling] = useState(false)
  const [fpsCap, setFpsCapState] = useState(() => Number(readKey(FPS_CAP_KEY)) || 0)
  const fpsCapRef = useRef(fpsCap)
  const [carColor, setCarColorState] = useState(() => readKey(CAR_COLOR_KEY) ?? CAR_COLORS[0].hex)
  const [classicCar, setClassicCarState] = useState(() => readKey(CLASSIC_KEY) === "1")
  /** Whether the Datsun is really showing (it may be missing or still loading). */
  const [classicShowing, setClassicShowing] = useState(false)

  // Engine and render loop.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    // A fresh canvas per engine: its WebGL context is released when the drive closes, and
    // React's development double-mount never hands two renderers the same context.
    const canvas = document.createElement("canvas")
    canvas.className = "drive-canvas"
    stage.appendChild(canvas)
    let engine: DriveEngine
    try {
      engine = new DriveEngine(canvas, loadSeed(), loadQuality(), {
        color: readKey(CAR_COLOR_KEY) ?? undefined,
        classic: readKey(CLASSIC_KEY) === "1",
      })
      engine.setFrameCap(fpsCapRef.current)
    } catch (e) {
      canvas.remove()
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    engineRef.current = engine
    let cancelled = false
    engine.ready.then(
      () => !cancelled && setLoading(false),
      (e) => !cancelled && setError(`Couldn't load the scenery (${e instanceof Error ? e.message : String(e)}). Are the files in public/drive?`),
    )
    const fit = () => engine.resize(canvas.clientWidth, canvas.clientHeight)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(canvas)

    let raf = 0
    let last = performance.now()
    let lastHud = ""
    let lastStats = 0
    let nextFrame = 0
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      // Optional frame cap (battery / weak PCs): skip this display frame if it's too soon.
      // A running deadline (not "time since last frame") so the rate is exact on 60, 120
      // or 144 Hz displays.
      const cap = fpsCapRef.current
      if (cap > 0) {
        if (now < nextFrame - 1) return
        nextFrame += 1000 / cap
        // Fell behind (a long frame, or just switched on): start the schedule from now.
        if (now - nextFrame > 1000 / cap) nextFrame = now + 1000 / cap
      }
      const dt = (now - last) / 1000
      last = now
      const f = engine.frame(dt, inputRef.current)
      if (speedRef.current) speedRef.current.textContent = String(Math.round(f.speedKmh))
      if (odoRef.current) odoRef.current.textContent = f.distanceKm.toFixed(1)
      const q = engine.qualityInfo.active
      const classic = engine.classicShowing
      const key = `${f.autopilot}|${f.time}|${f.camera}|${q}|${f.struggling}|${classic}`
      if (key !== lastHud) {
        lastHud = key
        setHud({ autopilot: f.autopilot, time: f.time, camera: f.camera })
        setActiveQuality(q)
        setStruggling(f.struggling)
        setClassicShowing(classic)
      }
      const st = statsRef.current
      if (st && now - lastStats > 250) {
        lastStats = now
        const x = engine.stats
        st.textContent =
          `${x.fps.toFixed(0)} fps · ${x.frameMs.toFixed(1)} ms\n` +
          `${x.drawCalls} draws · ${(x.triangles / 1000).toFixed(0)}k tris\n` +
          `${x.quality} · res ${x.resolution.toFixed(2)}×\n` +
          `${x.chunks} chunks · grass ${x.grass}\n` +
          x.breakdown
            .slice(0, 5)
            .map(([k, v]) => `${k.padEnd(9)}${(v / 1000).toFixed(0).padStart(6)}k`)
            .join("\n")
      }
    }
    raf = requestAnimationFrame(loop)
    const hintTimer = window.setTimeout(() => setShowHints(false), 9000)

    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(hintTimer)
      ro.disconnect()
      cancelled = true
      engine.dispose()
      canvas.remove()
      engineRef.current = null
    }
  }, [])

  // Keyboard: driving keys are ours (so the arrows don't also seek the song).
  const menuRef = useRef(menuOpen)
  const wheelRef = useRef(wheelOpen)
  /** KeyboardEvent.code of every driving key currently held down. */
  const heldRef = useRef(new Set<string>())
  // Each control is on while ANY of its keys is held, so overlapping keys never cancel.
  const syncInput = () => {
    const input = inputRef.current
    input.throttle = input.brake = input.left = input.right = input.boost = false
    for (const code of heldRef.current) input[DRIVE_KEYS[code]] = true
  }
  useEffect(() => {
    menuRef.current = menuOpen
    wheelRef.current = wheelOpen
    if (menuOpen || wheelOpen) {
      heldRef.current.clear()
      const input = inputRef.current
      input.throttle = input.brake = input.left = input.right = input.boost = false
    }
  }, [menuOpen, wheelOpen])

  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
    const down = (e: KeyboardEvent) => {
      // macOS sends no keyup for keys released while Cmd is held: drop everything.
      if (e.key === "Meta") {
        heldRef.current.clear()
        syncInput()
      }
      if (wheelRef.current || typing(e.target)) return
      const k = e.key.toLowerCase()
      if (k === "escape") {
        e.preventDefault()
        e.stopPropagation()
        setMenuOpen((open) => !open)
        return
      }
      if (menuRef.current || e.metaKey || e.ctrlKey || e.altKey) return
      const engine = engineRef.current
      if (DRIVE_KEYS[e.code]) {
        heldRef.current.add(e.code)
        syncInput()
      } else if (k === "h" && !e.repeat) {
        engine?.setAutopilot(!engine.isAutopilot)
      } else if (k === "c" && !e.repeat) {
        engine?.cycleCamera()
      } else if (k === "p" && !e.repeat) {
        setShowStats((v) => !v)
      } else if (k === "t" && !e.repeat) {
        engine?.cycleTime()
      } else if (k === "f" || k === "/" || k === "?") {
        // Now Playing, search and the shortcut list live behind the drive: keep them shut.
      } else return
      e.preventDefault()
      e.stopPropagation()
      setShowHints(false)
    }
    const up = (e: KeyboardEvent) => {
      if (DRIVE_KEYS[e.code]) {
        heldRef.current.delete(e.code)
        syncInput()
      }
    }
    const blur = () => {
      heldRef.current.clear()
      const input = inputRef.current
      input.throttle = input.brake = input.left = input.right = input.boost = false
    }
    window.addEventListener("keydown", down, true)
    window.addEventListener("keyup", up, true)
    window.addEventListener("blur", blur)
    return () => {
      window.removeEventListener("keydown", down, true)
      window.removeEventListener("keyup", up, true)
      window.removeEventListener("blur", blur)
    }
  }, [])

  const setTime = (t: TimeOfDay) => engineRef.current?.setTime(t)
  const chooseQuality = (q: QualitySetting) => {
    setQualityState(q)
    engineRef.current?.setQuality(q)
    try {
      if (q === "auto") localStorage.removeItem(QUALITY_KEY)
      else localStorage.setItem(QUALITY_KEY, q)
    } catch {
      // ignore
    }
  }
  const chooseFpsCap = (cap: number) => {
    setFpsCapState(cap)
    fpsCapRef.current = cap
    engineRef.current?.setFrameCap(cap)
    writeKey(FPS_CAP_KEY, cap ? String(cap) : null)
  }
  const chooseCarColor = (hex: string) => {
    setCarColorState(hex)
    engineRef.current?.setCarColor(hex)
    writeKey(CAR_COLOR_KEY, hex === CAR_COLORS[0].hex ? null : hex)
  }
  const toggleClassicCar = () => {
    const next = !classicCar
    setClassicCarState(next)
    engineRef.current?.setClassicCar(next)
    writeKey(CLASSIC_KEY, next ? "1" : null)
  }
  const toggleWallpaper = () => {
    const next = !wallpaper
    setWallpaper(next)
    engineRef.current?.setWallpaper(next)
  }
  const station = radio.station

  return (
    <div className="drive-root" role="application" aria-label="GTA mode drive">
      <div ref={stageRef} className="drive-stage" />
      <div className="drive-vignette" aria-hidden="true" />

      {loading && !error && (
        <div className="drive-loading-screen">
          <span className="drive-loading-title">Leonida</span>
          <span className="drive-loading-sub">Loading the coast…</span>
        </div>
      )}

      {error && (
        <div className="drive-error">
          <strong>The drive couldn't start.</strong>
          <span>{error}</span>
          <button type="button" onClick={onExit}>Leave GTA mode</button>
        </div>
      )}

      {/* Top left: what's on the radio. */}
      <div className="drive-onair">
        {station ? (
          <>
            <StationBadge station={station} size={34} />
            <div className="drive-onair-text">
              <span className="drive-onair-station">{stationTitle(station)}</span>
              <span className="drive-onair-song">
                {radio.status === "tuning" ? "Tuning…" : currentTrack ? `${currentTrack.artist} — ${currentTrack.title}` : ""}
              </span>
            </div>
          </>
        ) : (
          <div className="drive-onair-text">
            <span className="drive-onair-station">Radio off</span>
            <span className="drive-onair-song">Hold R to tune in</span>
          </div>
        )}
      </div>

      {/* Bottom right: speed. */}
      <div className="drive-speedo">
        <span className="drive-speed" ref={speedRef}>0</span>
        <span className="drive-unit">km/h</span>
        <span className="drive-meta">
          {hud.autopilot ? <span className="drive-auto">Cruise</span> : <span className="drive-manual">Manual</span>}
          <span className="drive-odo"><span ref={odoRef}>0.0</span> km</span>
        </span>
      </div>

      {showStats && <pre ref={statsRef} className="drive-stats" aria-label="Performance" />}

      {struggling && !menuOpen && activeQuality !== "low" && (
        <div className="drive-slow-hint" role="status">
          Running slow on this computer — press <kbd>Esc</kbd> and set Graphics to Low
        </div>
      )}

      {showHints && !menuOpen && (
        <div className="drive-hints">
          <span><kbd>R</kbd> radio</span>
          <span><kbd>W</kbd><kbd>S</kbd> speed</span>
          <span><kbd>A</kbd><kbd>D</kbd> lanes</span>
          <span><kbd>H</kbd> cruise</span>
          <span><kbd>C</kbd> camera</span>
          <span><kbd>T</kbd> time of day</span>
          <span><kbd>Esc</kbd> menu</span>
          <span><kbd>P</kbd> stats</span>
          <span>Hands off: it drives itself</span>
        </div>
      )}

      {menuOpen && (
        <div className="drive-menu" role="dialog" aria-modal="true" aria-label="Drive menu">
          <div className="drive-menu-side">
            <h1 className="drive-menu-title">Leonida<br />Drive</h1>
            <span className="drive-menu-sub">GTA mode · experimental</span>

            <div className="drive-menu-transport">
              <button type="button" onClick={onTogglePlay} aria-label={isPlaying ? "Pause" : "Play"}>
                {isPlaying ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <button type="button" onClick={onNext} aria-label="Next song">
                <SkipForward size={18} />
              </button>
              {station && (
                <button type="button" onClick={radio.off} aria-label="Radio off">
                  <Power size={18} />
                </button>
              )}
            </div>

            <span className="drive-menu-label">Time of day</span>
            <div className="drive-menu-times">
              {TIMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={hud.time === t.id ? "is-on" : undefined}
                  onClick={() => setTime(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <span className="drive-menu-label">Driving</span>
            <div className="drive-menu-times">
              <button
                type="button"
                className={hud.autopilot ? "is-on" : undefined}
                onClick={() => engineRef.current?.setAutopilot(!hud.autopilot)}
              >
                Cruise {hud.autopilot ? "on" : "off"}
              </button>
              <button type="button" onClick={() => engineRef.current?.cycleCamera()}>
                Camera: {hud.camera}
              </button>
              <button type="button" className={wallpaper ? "is-on" : undefined} onClick={toggleWallpaper}>
                Live wallpaper {wallpaper ? "on" : "off"}
              </button>
            </div>

            <span className="drive-menu-label">Paint</span>
            <div className="drive-menu-swatches" role="radiogroup" aria-label="Car colour">
              {CAR_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={carColor === c.hex}
                  aria-label={c.label}
                  title={c.label}
                  className={carColor === c.hex ? "is-on" : undefined}
                  style={{ background: c.hex }}
                  disabled={classicShowing}
                  onClick={() => chooseCarColor(c.hex)}
                />
              ))}
            </div>
            <div className="drive-menu-times">
              <button type="button" className={classicCar ? "is-on" : undefined} onClick={toggleClassicCar}>
                Classic Datsun {classicCar ? (classicShowing ? "on" : "on · loading or not found") : "off"}
              </button>
            </div>

            <span className="drive-menu-label">
              Graphics{quality === "auto" && activeQuality ? ` · auto picked ${activeQuality}` : ""}
            </span>
            <div className="drive-menu-times">
              {QUALITY_LABELS.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  className={quality === q.id ? "is-on" : undefined}
                  onClick={() => chooseQuality(q.id)}
                >
                  {q.label}
                </button>
              ))}
            </div>

            <span className="drive-menu-label">Frame rate</span>
            <div className="drive-menu-times">
              {FPS_CAPS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  className={fpsCap === c.value ? "is-on" : undefined}
                  onClick={() => chooseFpsCap(c.value)}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <div className="drive-menu-actions">
              <button type="button" className="drive-menu-resume" onClick={() => setMenuOpen(false)}>
                Resume
              </button>
              <button type="button" className="drive-menu-exit" onClick={onExit}>
                Leave GTA mode
              </button>
            </div>
          </div>
          <div className="drive-menu-stations">
            <RadioView
              radio={radio}
              currentTrack={currentTrack}
              onOpenWheel={() => {
                setMenuOpen(false)
                onOpenWheel()
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

