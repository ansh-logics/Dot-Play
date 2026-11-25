import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Power } from "lucide-react";
import { loadFeedbackPrefs, radioDetent } from "../../lib/feedback";
import {
  RADIO_ERAS,
  findStation,
  stationTitle,
  stationsForEra,
  type RadioEra,
  type RadioStation,
} from "../../lib/radioStations";
import type { SearchResult } from "../../lib/search";
import type { RadioController } from "../../lib/useRadio";
import { StationBadge } from "./StationBadge";

/** Released this soon after opening, the hold key is a tap: skip to the next station. */
const TAP_MS = 220;
/** Pointer this close to the hub keeps the previous highlight. */
const DEADZONE_PX = 46;
/** The pointer has to move this far after opening before it steers the highlight. */
const MOVE_THRESHOLD_PX = 6;
const OFF_SLOT = "off";

interface RadioWheelProps {
  open: boolean;
  /** The key the lead opens the wheel with; releasing it commits. */
  holdKey?: string;
  radio: RadioController;
  currentTrack: SearchResult | null;
  onClose: () => void;
  reduceMotion: boolean;
}

/** Slot ids for an era: "off" at the top, then the era's stations clockwise. */
function slotsFor(era: RadioEra): string[] {
  return [OFF_SLOT, ...stationsForEra(era).map((s) => s.id)];
}

function useViewport() {
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return vp;
}

/**
 * GTA-style radio wheel: hold the key, aim at a station with the mouse (or arrows), let go
 * to tune. A quick tap skips to the next station instead. Badges and layout are our own.
 */
export const RadioWheel = memo(function RadioWheel({
  open,
  holdKey = "r",
  radio,
  currentTrack,
  onClose,
  reduceMotion,
}: RadioWheelProps) {
  const playingId = radio.status === "off" ? null : radio.stationId;
  const defaultEra = (findStation(radio.stationId ?? radio.lastStationId)?.era ?? "vi") as RadioEra;
  const [era, setEra] = useState<RadioEra>(defaultEra);
  const [highlight, setHighlight] = useState<string>(OFF_SLOT);
  const slots = useMemo(() => slotsFor(era), [era]);

  const hubRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(0);
  /** Whether the hold key is physically down right now (tracked even while closed). */
  const keyDown = useRef(false);
  /** Whether the wheel was opened by holding the key (vs. a button), so its release counts. */
  const holdActive = useRef(false);
  const soundOn = useRef(true);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const pointerArmed = useRef(false);
  const restoreFocus = useRef<HTMLElement | null>(null);

  // Live copies for the window listeners.
  const state = useRef({ era, highlight, slots, radio, playingId, onClose });
  useEffect(() => {
    state.current = { era, highlight, slots, radio, playingId, onClose };
  });

  const holdKeyLower = holdKey.toLowerCase();

  // Track the hold key's physical state all the time, so a release only commits when the
  // wheel was opened by holding it.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === holdKeyLower && !e.metaKey && !e.ctrlKey && !e.altKey) keyDown.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === holdKeyLower) keyDown.current = false;
    };
    const reset = () => (keyDown.current = false);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", reset);
    };
  }, [holdKeyLower]);

  /** Move the highlight, with a detent click when it lands on a new slot. */
  const moveHighlight = useCallback((id: string) => {
    setHighlight((prev) => {
      if (prev === id) return prev;
      if (soundOn.current) radioDetent(0.8);
      return id;
    });
  }, []);

  // Re-sync on open: era of the playing (or last) station, highlight on what's playing.
  useEffect(() => {
    if (!open) return;
    openedAt.current = performance.now();
    holdActive.current = keyDown.current;
    soundOn.current = loadFeedbackPrefs().sound;
    pointerStart.current = null;
    pointerArmed.current = false;
    const e = (findStation(radio.stationId ?? radio.lastStationId)?.era ?? "vi") as RadioEra;
    setEra(e);
    setHighlight(playingId && findStation(playingId)?.era === e ? playingId : OFF_SLOT);
    restoreFocus.current = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }));
    return () => {
      const el = restoreFocus.current;
      restoreFocus.current = null;
      if (el && document.contains(el)) el.focus({ preventScroll: true });
    };
    // Only on open; radio changes while open shouldn't yank the highlight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const switchEra = useCallback(
    (dir: 1 | -1 | RadioEra) => {
      const cur = state.current.era;
      const i = RADIO_ERAS.findIndex((x) => x.id === cur);
      const next =
        typeof dir === "string" ? dir : RADIO_ERAS[(i + dir + RADIO_ERAS.length) % RADIO_ERAS.length].id;
      if (next === cur) return;
      setEra(next);
      const pid = state.current.playingId;
      const first = stationsForEra(next)[0]?.id ?? OFF_SLOT;
      if (soundOn.current) radioDetent(0.6);
      setHighlight(pid && findStation(pid)?.era === next ? pid : first);
    },
    [],
  );

  /** Commit a slot: tune a station (unless it's already on) or switch the radio off. */
  const commit = useCallback((id: string) => {
    const { radio: r, playingId: pid, onClose: close } = state.current;
    close();
    if (id === OFF_SLOT) {
      if (r.status !== "off") r.off();
      return;
    }
    if (id !== pid) void r.tune(id);
  }, []);

  /** A tap of the hold key: the next station after the current one in this era. */
  const tapNext = useCallback(() => {
    const { radio: r, era: e, playingId: pid, onClose: close } = state.current;
    close();
    const list = stationsForEra(e);
    if (list.length === 0) return;
    if (!pid) {
      void r.tune(r.lastStationId ?? list[0].id);
      return;
    }
    const i = list.findIndex((s) => s.id === pid);
    const next = list[(i + 1 + list.length) % list.length];
    if (next && next.id !== pid) void r.tune(next.id);
  }, []);

  // Keyboard while open.
  useEffect(() => {
    if (!open) return;
    const swallow = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key;
      const lower = key.toLowerCase();
      if (lower === holdKeyLower) return swallow(e); // repeats while held
      if (key === "Escape") {
        swallow(e);
        state.current.onClose();
        return;
      }
      if (key === "Enter") {
        swallow(e);
        commit(state.current.highlight);
        return;
      }
      if (key === "Tab") {
        swallow(e);
        switchEra(e.shiftKey ? -1 : 1);
        return;
      }
      if (lower === "q" || lower === "e") {
        swallow(e);
        switchEra(lower === "q" ? -1 : 1);
        return;
      }
      if (key === "ArrowRight" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowUp") {
        swallow(e);
        const dir = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
        const { slots: s, highlight: h } = state.current;
        const i = Math.max(0, s.indexOf(h));
        moveHighlight(s[(i + dir + s.length) % s.length]);
        return;
      }
      if (key === " " || key === "Spacebar") swallow(e);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const lower = e.key.toLowerCase();
      if (lower !== holdKeyLower) {
        if (e.key === " " || e.key.startsWith("Arrow")) swallow(e);
        return;
      }
      swallow(e);
      if (!holdActive.current) return;
      holdActive.current = false;
      if (performance.now() - openedAt.current < TAP_MS) tapNext();
      else commit(state.current.highlight);
    };
    const onBlur = () => state.current.onClose();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, holdKeyLower, commit, tapNext, switchEra, moveHighlight]);

  // Aim with the pointer: the slot in the direction of the cursor from the hub.
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointerArmed.current) {
      const start = pointerStart.current;
      if (!start) {
        pointerStart.current = { x: e.clientX, y: e.clientY };
        return;
      }
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < MOVE_THRESHOLD_PX) return;
      pointerArmed.current = true;
    }
    const hub = hubRef.current?.getBoundingClientRect();
    if (!hub) return;
    const dx = e.clientX - (hub.left + hub.width / 2);
    const dy = e.clientY - (hub.top + hub.height / 2);
    if (Math.hypot(dx, dy) < DEADZONE_PX) return;
    // 0 at the top, growing clockwise.
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    const n = slots.length;
    const i = Math.round((((angle % 360) + 360) % 360) / (360 / n)) % n;
    moveHighlight(slots[i]);
  };

  // Ring size: fit the window, and shrink badges when an era has many stations.
  const vp = useViewport();
  const n = slots.length;
  const radius = Math.max(120, Math.min(270, (Math.min(vp.w, vp.h) - 230) / 2));
  const badgeSize = Math.round(Math.max(40, Math.min(72, ((2 * Math.PI * radius) / n) * 0.7)));
  const ringPx = radius * 2 + badgeSize * 1.6;

  const hStation: RadioStation | null | undefined = highlight === OFF_SLOT ? null : findStation(highlight);
  const hIndex = Math.max(0, slots.indexOf(highlight));
  const pointerDeg = hIndex * (360 / n);
  const isPlayingHighlight = !!hStation && hStation.id === playingId;
  const accent = hStation ? hStation.colors[0] : "#ffffff";

  const spring = reduceMotion ? { duration: 0 } : ({ type: "spring", stiffness: 420, damping: 32 } as const);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="radio-wheel"
          ref={dialogRef}
          className="radio-wheel-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Radio wheel"
          tabIndex={-1}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.16 } }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.14 }}
          onPointerMove={onPointerMove}
          onPointerDown={(e) => {
            // A click on the backdrop (not on the wheel's controls) cancels.
            if (e.target === e.currentTarget) onClose();
          }}
          style={{ "--radio-accent": accent } as CSSProperties}
        >
          <div className="radio-wheel-eras" role="tablist" aria-label="Radio era">
            {RADIO_ERAS.map((x) => (
              <button
                key={x.id}
                type="button"
                role="tab"
                aria-selected={x.id === era}
                className={`radio-wheel-era${x.id === era ? " is-active" : ""}`}
                onClick={() => switchEra(x.id)}
              >
                <span className="radio-wheel-era-short">{x.short}</span>
                <span className="radio-wheel-era-label">{x.label}</span>
              </button>
            ))}
          </div>

          <motion.div
            className="radio-wheel"
            style={{ width: ringPx, height: ringPx, "--radio-ring-r": `${radius}px` } as CSSProperties}
            initial={reduceMotion ? false : { scale: 0.82, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={reduceMotion ? undefined : { scale: 0.9, opacity: 0 }}
            transition={spring}
          >
            <div className="radio-wheel-disc" aria-hidden="true" />
            <motion.div
              className="radio-wheel-pointer"
              aria-hidden="true"
              initial={false}
              animate={{ rotate: pointerDeg }}
              transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 38 }}
            >
              <span className="radio-wheel-pointer-arc" />
            </motion.div>

            {slots.map((id, i) => {
              const a = ((i * 360) / n - 90) * (Math.PI / 180);
              const x = Math.cos(a) * radius;
              const y = Math.sin(a) * radius;
              const s = id === OFF_SLOT ? undefined : findStation(id);
              const hi = id === highlight;
              const playing = id === playingId || (id === OFF_SLOT && radio.status === "off");
              return (
                <button
                  key={id}
                  type="button"
                  className={`radio-wheel-slot${hi ? " is-highlighted" : ""}${playing ? " is-playing" : ""}${
                    s ? "" : " is-off"
                  }`}
                  style={
                    {
                      "--slot-x": `${x}px`,
                      "--slot-y": `${y}px`,
                      "--slot-size": `${badgeSize}px`,
                      "--slot-glow": s ? s.colors[0] : "#ffffff",
                    } as CSSProperties
                  }
                  aria-label={s ? `${stationTitle(s)}, ${s.genre}${playing ? ", playing" : ""}` : "Radio off"}
                  aria-current={playing || undefined}
                  onPointerEnter={() => {
                    if (pointerArmed.current) moveHighlight(id);
                  }}
                  onClick={() => commit(id)}
                >
                  {s ? (
                    <StationBadge station={s} size={badgeSize} active={hi} />
                  ) : (
                    <span className="radio-wheel-off" aria-hidden="true">
                      <Power size={Math.round(badgeSize * 0.4)} strokeWidth={2.4} />
                    </span>
                  )}
                </button>
              );
            })}

            <div ref={hubRef} className="radio-wheel-hub" aria-live="polite">
              {hStation ? (
                <>
                  <span className="radio-wheel-hub-title">{stationTitle(hStation)}</span>
                  <span className="radio-wheel-hub-meta">{hStation.genre}</span>
                  <span className="radio-wheel-hub-host">{hStation.host}</span>
                  {isPlayingHighlight && currentTrack && (
                    <span className="radio-wheel-hub-song">
                      <span className="radio-wheel-hub-song-title">{currentTrack.title}</span>
                      <span className="radio-wheel-hub-song-artist">{currentTrack.artist}</span>
                    </span>
                  )}
                  {isPlayingHighlight && radio.status === "tuning" && (
                    <span className="radio-wheel-hub-tuning">Tuning…</span>
                  )}
                </>
              ) : (
                <>
                  <span className="radio-wheel-hub-title">Radio off</span>
                  <span className="radio-wheel-hub-meta">
                    {radio.status === "off" ? "Silence is golden" : "Switch the radio off"}
                  </span>
                </>
              )}
            </div>
          </motion.div>

          <p className="radio-wheel-hint">Release R to tune · Tab to switch era · Esc to cancel</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
