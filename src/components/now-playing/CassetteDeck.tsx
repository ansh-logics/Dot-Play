import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AnimatePresence, animate, motion, useAnimationFrame, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { CassetteTape } from "./CassetteTape";
import type { SettledArtwork } from "./useSettledArtwork";
import type { SearchResult } from "../../lib/search";
import { useLyricClock } from "./useLyricClock";
import { cleanDisplayTitle } from "../../lib/displayText";
import {
  clunk,
  crateRattle,
  doorRelease,
  keyPress,
  tapeClatter,
  tapeFlick,
  tapePickUp,
  tapeRunOut,
  tapeStart,
  tapeStop,
  tapeWind,
} from "../../lib/feedback";
import "./cassette.css";

/** The door tilts open toward you, hinged at the bottom. */
const DOOR_OPEN_DEG = -34;
const DOOR_SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;
/** The old tape waits for the door before it lifts out. */
const EJECT_DELAY_S = 0.2;

/** The tape lifts up and out toward you, and the new one drops in and seats. */
const TAPE_OUT = { y: "-58%", scale: 1.06, rotateX: 22, opacity: 0 };
const TAPE_IN = { y: "0%", scale: 1, rotateX: 0, opacity: 1, transition: { type: "spring", stiffness: 260, damping: 24 } } as const;
const TAPE_EJECT = { ...TAPE_OUT, transition: { delay: EJECT_DELAY_S, duration: 0.28, ease: [0.4, 0, 0.8, 0.4] } } as const;
const FADE = { duration: 0.15 };
/**
 * A tape brought by hand hovers just above its slot, a touch bigger (nearer to you), while the
 * old one sinks away; then it slides down into place.
 */
const HAND_LIFT = 0.16;
const HAND_SCALE = 1.07;
const HAND_SPRING = { type: "spring", stiffness: 300, damping: 28 } as const;
const TAPE_VARIANTS = {
  out: (hand: boolean) => (hand ? { y: `${-HAND_LIFT * 100}%`, scale: HAND_SCALE, rotateX: 0, opacity: 1 } : TAPE_OUT),
  in: TAPE_IN,
  gone: (hand: boolean) => (hand ? { y: "6%", scale: 0.94, opacity: 0, transition: { duration: 0.22 } } : TAPE_EJECT),
  /** Eject: the tape pops up out of the holder and stays there, tilted toward you. */
  ejected: { y: "-30%", scale: 1.04, rotateX: 16, opacity: 1, transition: { type: "spring", stiffness: 340, damping: 17 } } as const,
};
const FADE_VARIANTS = {
  out: { opacity: 0 },
  in: { opacity: 1, transition: FADE },
  gone: { opacity: 0, transition: FADE },
  ejected: { opacity: 0.6, transition: FADE },
};
/** How far (px) a press must move before it becomes a drag rather than a click. */
const DRAG_START_PX = 6;
/** A cassette is 100 × 64. */
const TAPE_ASPECT = 0.64;

const thumbArt = (t: SearchResult): SettledArtwork | null =>
  t.thumbnailUrl ? { url: t.thumbnailUrl, palette: null, videoId: t.videoId } : null;

/** Counter digits count playback seconds and roll fast through a seek. */
const COUNTER_EASE_MS = 420;

interface CassetteDeckProps {
  track: SearchResult;
  art: SettledArtwork | null;
  isPlaying: boolean;
  isReady: boolean;
  currentTime: number;
  duration: number;
  reduceMotion: boolean;
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (seconds: number) => void;
  /** 0–100. */
  volume: number;
  isMuted: boolean;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
  /** The queue's next songs, standing as tapes in a crate along the bottom. */
  upcoming: SearchResult[];
  onPlayTrack: (track: SearchResult) => void;
  /** What the deck's phosphor screen shows: the lyrics, or (when null) the song's details. */
  screen: ReactNode;
}

/**
 * The Cassette player style: a hi-fi tape deck in place of the artwork. The current song is
 * a tape behind the door; changing songs opens the door, lifts the old tape out and drops the
 * new one in. Eject pops the tape out and brings up the crate to choose another; Play (or a
 * click on the tape) loads it back. Lyrics glow on an amber phosphor screen; a volume
 * fader, a rolling tape counter and latching piano keys complete the deck.
 */
export function CassetteDeck(props: CassetteDeckProps) {
  const { track, isPlaying, reduceMotion } = props;
  const [doorOpen, setDoorOpen] = useState(false);
  /** Held open while a tape is dragged over the door. */
  const [hoverOpen, setHoverOpen] = useState(false);
  const [ghost, setGhost] = useState<SearchResult | null>(null);
  const [ghostW, setGhostW] = useState(0);
  const swapping = useRef(false);
  const lastId = useRef(track.videoId);
  /** The song whose tape is being brought in by hand (it skips the drop-in from above). */
  const handInsert = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const wellRef = useRef<HTMLDivElement>(null);
  const gx = useMotionValue(0);
  const gy = useMotionValue(0);
  const gScale = useMotionValue(1);
  const gRotate = useMotionValue(0);
  const pick = useRef<{ track: SearchResult; slot: HTMLElement; home: HTMLElement; x: number; y: number; dragging: boolean; lastX: number; lastT: number } | null>(null);
  const ghostTimer = useRef<number | null>(null);
  const hoverRef = useRef(false);
  /** The crate stays out of sight until you reach for it (the pull tab or the bottom edge). */
  const [crateOpen, setCrateOpen] = useState(false);
  const crateTimer = useRef<number | null>(null);
  /** Eject pressed: the tape sits popped up in the open door until it's loaded again. */
  const [ejected, setEjected] = useState(false);
  /** The ejected tape is being loaded back: clunk and play once it has seated. */
  const reseat = useRef(false);

  // A new song: open the door. AnimatePresence then takes the old tape out and puts the new
  // one in; the door shuts once it has seated.
  useEffect(() => {
    if (track.videoId === lastId.current) return;
    lastId.current = track.videoId;
    setEjected(false);
    if (reduceMotion) return;
    swapping.current = true;
    setDoorOpen(true);
  }, [track.videoId, reduceMotion]);

  useEffect(() => () => {
    if (ghostTimer.current) window.clearTimeout(ghostTimer.current);
    if (crateTimer.current) window.clearTimeout(crateTimer.current);
  }, []);

  // ---- Sound: the motor runs only while playing with the door shut ----
  const open = doorOpen || hoverOpen || ejected;
  const running = isPlaying && !open;
  const wasRunning = useRef(running);
  useEffect(() => {
    if (running !== wasRunning.current) {
      if (running) tapeStart();
      else tapeStop();
      wasRunning.current = running;
    }
  }, [running]);

  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) doorRelease();
    wasOpen.current = open;
  }, [open]);

  // A jump in position that playback can't explain is a seek: whirr the tape that way. Near
  // the end, the leader runs past the head and the auto-stop clacks.
  const lastPos = useRef({ t: props.currentTime, at: performance.now(), id: track.videoId });
  const ranOut = useRef<string | null>(null);
  useEffect(() => {
    const now = performance.now();
    const last = lastPos.current;
    if (last.id === track.videoId) {
      const expected = last.t + (isPlaying ? (now - last.at) / 1000 : 0);
      if (Math.abs(props.currentTime - expected) > 2.5) tapeWind(props.currentTime > expected);
    }
    lastPos.current = { t: props.currentTime, at: now, id: track.videoId };
    if (isPlaying && props.duration > 5 && props.duration - props.currentTime < 0.9 && ranOut.current !== track.videoId) {
      ranOut.current = track.videoId;
      tapeRunOut();
    }
  }, [props.currentTime, props.duration, isPlaying, track.videoId]);

  // ---- The crate: pops up on demand, tucks away again when you move off it ----
  const openCrate = () => {
    if (crateTimer.current) window.clearTimeout(crateTimer.current);
    if (!crateOpen && props.upcoming.length > 0) crateRattle(props.upcoming.length);
    setCrateOpen(true);
  };
  const closeCrateSoon = (ms = 650) => {
    if (crateTimer.current) window.clearTimeout(crateTimer.current);
    crateTimer.current = window.setTimeout(() => {
      if (!pick.current) setCrateOpen(false);
    }, ms);
  };

  const setHover = (open: boolean) => {
    if (hoverRef.current === open) return;
    hoverRef.current = open;
    setHoverOpen(open);
  };

  /** Eject: stop, pop the tape up, and bring up the crate to choose another. Again: load it back. */
  const eject = () => {
    if (ejected) return reload();
    setEjected(true);
    tapeClatter();
    if (isPlaying) props.onPlayPause();
    openCrate();
  };
  const reload = () => {
    reseat.current = true;
    setEjected(false);
    setCrateOpen(false);
  };

  const seated = () => {
    handInsert.current = null;
    setHover(false);
    if (!swapping.current) return;
    swapping.current = false;
    setDoorOpen(false);
    clunk();
  };

  // ---- Geometry, in the deck's own coordinates (the ghost tape is positioned inside it) ----
  const rel = (r: DOMRect) => {
    const o = rootRef.current!.getBoundingClientRect();
    return { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height };
  };
  const tapeRect = () => {
    const el = wellRef.current?.querySelector(".deck-tape") ?? wellRef.current!;
    const r = rel(el.getBoundingClientRect());
    return { ...r, h: r.w * TAPE_ASPECT };
  };
  const overWell = (x: number, y: number) => {
    const w = rel(wellRef.current!.getBoundingClientRect());
    const pad = w.w * 0.1;
    return x > w.x - pad && x < w.x + w.w + pad && y > w.y - pad && y < w.y + w.h + pad;
  };

  /** Take a tape out of the crate: a full-size copy appears over it and comes up to size. */
  const lift = (t: SearchResult, slot: HTMLElement) => {
    const tr = tapeRect();
    const s = rel(slot.getBoundingClientRect());
    setGhostW(tr.w);
    gx.set(s.x + s.w / 2 - tr.w / 2);
    gy.set(s.y); // the ghost scales from its top edge, so line the tops up
    gScale.set(s.w / tr.w);
    gRotate.set(0);
    setGhost(t);
    tapePickUp();
    if (reduceMotion) gScale.set(1);
    else animate(gScale, 1, HAND_SPRING);
  };

  /** Bring the held tape to the open door; the deck then swaps it in. */
  const insert = (t: SearchResult) => {
    const tr = tapeRect();
    setHover(true);
    const to = (mv: typeof gx, v: number) => (reduceMotion ? (mv.set(v), Promise.resolve()) : animate(mv, v, HAND_SPRING));
    void Promise.all([to(gx, tr.x), to(gy, tr.y - tr.h * HAND_LIFT), to(gScale, HAND_SCALE), to(gRotate, 0)]).then(() => {
      handInsert.current = t.videoId;
      props.onPlayTrack(t);
      setCrateOpen(false);
    });
    // If the song never changes (it failed to load), don't leave a tape hanging in the air.
    if (ghostTimer.current) window.clearTimeout(ghostTimer.current);
    ghostTimer.current = window.setTimeout(() => {
      setGhost(null);
      setHover(false);
    }, 4000);
  };

  /** Dropped away from the door: the tape goes back where it came from. */
  /**
   * Dropped away from the door: the tape goes back to exactly where it stood. `home` is its
   * slot, which never moves (the tapes all settle to rest while one is held), so this is the
   * spot it will be drawn in once the copy in your hand disappears.
   */
  const putBack = (home: HTMLElement) => {
    setHover(false);
    const tr = tapeRect();
    const s = rel(home.getBoundingClientRect());
    const scale = s.w / tr.w;
    const tilt = parseFloat(home.style.getPropertyValue("--tilt")) || 0;
    const done = () => {
      setGhost(null);
      closeCrateSoon(1400); // tucks away unless you go back to it
    };
    if (reduceMotion) return done();
    const spring = { type: "spring", stiffness: 380, damping: 32 } as const;
    void Promise.all([
      animate(gx, s.x + s.w / 2 - tr.w / 2, spring),
      animate(gy, s.y, spring),
      animate(gScale, scale, spring),
      animate(gRotate, tilt, spring),
    ]).then(() => {
      tapeFlick();
      done();
    });
  };

  const crate = {
    busy: ghost !== null,
    held: ghost?.videoId ?? null,
    onPointerDown: (e: ReactPointerEvent<HTMLElement>, t: SearchResult, slot: HTMLElement, home: HTMLElement) => {
      if (ghost || e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      pick.current = { track: t, slot, home, x: e.clientX, y: e.clientY, dragging: false, lastX: e.clientX, lastT: e.timeStamp };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const p = pick.current;
      if (!p) return;
      if (!p.dragging) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_START_PX) return;
        p.dragging = true;
        lift(p.track, p.slot);
      }
      const o = rootRef.current!.getBoundingClientRect();
      const x = e.clientX - o.left;
      const y = e.clientY - o.top;
      const w = ghostW || tapeRect().w;
      gx.set(x - w / 2);
      gy.set(y - w * TAPE_ASPECT * 0.4);
      // It swings a little with the hand's sideways speed, like something held at the top.
      const dt = Math.max(1, e.timeStamp - p.lastT);
      const swing = Math.max(-14, Math.min(14, ((e.clientX - p.lastX) / dt) * 9));
      gRotate.set(gRotate.get() + (swing - gRotate.get()) * 0.25);
      p.lastX = e.clientX;
      p.lastT = e.timeStamp;
      setHover(overWell(x, y));
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      const p = pick.current;
      pick.current = null;
      if (!p) return;
      if (!p.dragging) {
        // A click: pick it up and take it to the deck.
        lift(p.track, p.slot);
        insert(p.track);
        return;
      }
      const o = rootRef.current!.getBoundingClientRect();
      if (overWell(e.clientX - o.left, e.clientY - o.top)) insert(p.track);
      else putBack(p.home);
    },
    onKey: (e: ReactKeyboardEvent<HTMLElement>, t: SearchResult) => {
      if (ghost || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      lift(t, e.currentTarget);
      insert(t);
    },
  };

  const hand = handInsert.current === track.videoId;

  return (
    <div ref={rootRef} className={`deck ${isPlaying ? "is-playing" : ""} ${ghost ? "is-holding" : ""}`}>
      <div className="deck-module">
        <div className="deck-top">
          <span className="deck-brand">dot(.)</span>
          <span className="deck-model">Stereo Cassette Deck</span>
          <span className="deck-tapetype" aria-hidden="true">
            <span className="is-lit">Normal</span>
            <span>CrO₂</span>
            <span>Metal</span>
          </span>
          <span className="deck-power">
            <i className="deck-led" />
            Power
          </span>
        </div>

        <div
          ref={wellRef}
          className={`deck-well ${hoverOpen ? "is-target" : ""} ${ejected ? "is-ejected" : ""}`}
          // The popped-up tape can be pushed straight back in.
          onClick={() => ejected && !ghost && reload()}
          title={ejected ? "Click to load the tape back in" : undefined}
        >
          <AnimatePresence mode="wait" initial={false} custom={hand}>
            <motion.div
              key={track.videoId}
              className="deck-tape"
              custom={hand}
              variants={reduceMotion ? FADE_VARIANTS : TAPE_VARIANTS}
              initial="out"
              animate={ejected ? "ejected" : "in"}
              exit="gone"
              onAnimationStart={(def) => {
                // The deck's own copy has taken over from the one in your hand.
                if (def === "in" && swapping.current && !reduceMotion) tapeClatter();
                if (def === "in" && ghost?.videoId === track.videoId) {
                  if (ghostTimer.current) window.clearTimeout(ghostTimer.current);
                  setGhost(null);
                }
              }}
              onAnimationComplete={(def) => {
                if (def !== "in") return;
                if (reseat.current) {
                  reseat.current = false;
                  clunk();
                  if (!props.isPlaying) props.onPlayPause();
                }
                seated();
              }}
            >
              <CassetteTape
                track={track}
                art={props.art}
                // The reels only catch once the door has shut on the new tape.
                isPlaying={isPlaying && !open}
                currentTime={props.currentTime}
                duration={props.duration}
                reduceMotion={reduceMotion}
              />
            </motion.div>
          </AnimatePresence>
          <motion.div
            className="deck-door"
            aria-hidden="true"
            animate={{ rotateX: open ? DOOR_OPEN_DEG : 0 }}
            transition={DOOR_SPRING}
          >
            <span className="deck-door-glare" />
          </motion.div>
        </div>

        <div className="deck-screen">
          <div className="deck-screen-glass">
            {props.screen ?? (
              <div className="deck-screen-info">
                <span className="deck-screen-kicker">{isPlaying ? "▶ Playing" : "❚❚ Paused"}</span>
                <span className="deck-screen-title">{cleanDisplayTitle(track.title)}</span>
                <span className="deck-screen-artist">{track.artist}</span>
              </div>
            )}
          </div>
          <ScreenSeek
            currentTime={props.currentTime}
            duration={props.duration}
            isPlaying={isPlaying}
            onSeek={props.onSeek}
            disabled={!props.isReady}
          />
          {/* Scanlines, glow and curved-glass vignette over whatever is on screen. */}
          <span className="deck-screen-scan" aria-hidden="true" />
        </div>

        <div className="deck-side">
          <DeckVolume volume={props.volume} isMuted={props.isMuted} onChange={props.onVolumeChange} onToggleMute={props.onToggleMute} />
          <TapeCounter currentTime={props.currentTime} isPlaying={isPlaying} reduceMotion={reduceMotion} />
        </div>

        <div className="deck-keys" role="group" aria-label="Deck controls">
          <DeckKey label="Rew" glyph="◀◀" aria="Previous" onPress={props.onPrevious} disabled={!props.isReady} />
          <DeckKey
            label="Play"
            glyph="▶"
            aria={ejected ? "Load the tape and play" : "Play"}
            latched={isPlaying && !ejected}
            onPress={() => (ejected ? reload() : !isPlaying && props.onPlayPause())}
            disabled={!props.isReady}
          />
          <DeckKey
            label="Pause"
            glyph="❚❚"
            aria="Pause"
            latched={!isPlaying}
            onPress={() => isPlaying && props.onPlayPause()}
            disabled={!props.isReady}
          />
          <DeckKey label="FF" glyph="▶▶" aria="Next" onPress={props.onNext} disabled={!props.isReady} />
          <DeckKey
            label={ejected ? "Load" : "Eject"}
            glyph="⏏"
            aria={ejected ? "Load the tape back in" : "Eject the tape and choose another"}
            latched={ejected}
            onPress={eject}
          />
        </div>
      </div>

      <TapeCrate
        tracks={props.upcoming}
        open={crateOpen}
        onOpen={openCrate}
        onCloseSoon={closeCrateSoon}
        onToggle={() => (crateOpen ? setCrateOpen(false) : openCrate())}
        reduceMotion={reduceMotion}
        {...crate}
      />

      {ghost && (
        <motion.div className="deck-ghost" style={{ x: gx, y: gy, scale: gScale, rotate: gRotate, width: ghostW }} aria-hidden="true">
          <CassetteTape track={ghost} art={thumbArt(ghost)} isPlaying={false} currentTime={0} duration={0} reduceMotion />
        </motion.div>
      )}
    </div>
  );
}

function DeckKey({
  label,
  glyph,
  aria,
  latched = false,
  disabled = false,
  onPress,
}: {
  label: string;
  glyph: string;
  aria: string;
  latched?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      className={`deck-key ${latched ? "is-latched" : ""}`}
      aria-label={aria}
      aria-pressed={latched || undefined}
      disabled={disabled}
      onPointerDown={() => !disabled && keyPress()}
      onClick={onPress}
    >
      <span className="deck-key-glyph">{glyph}</span>
      <span className="deck-key-label">{label}</span>
    </button>
  );
}

function TapeCounter({ currentTime, isPlaying, reduceMotion }: { currentTime: number; isPlaying: boolean; reduceMotion: boolean }) {
  const now = useLyricClock(currentTime, isPlaying);
  const value = useMotionValue(now());
  useAnimationFrame((_, dt) => {
    const t = Math.max(0, now());
    const v = value.get();
    value.set(reduceMotion || Math.abs(t - v) < 0.01 ? t : v + (t - v) * (1 - Math.exp(-dt / COUNTER_EASE_MS)));
  });
  return (
    <div className="deck-counter" aria-hidden="true">
      <span className="deck-counter-label">Tape counter · min sec</span>
      <span className="deck-counter-window">
        <CounterWheel value={value} wheel="m10" />
        <CounterWheel value={value} wheel="m1" />
        <span className="deck-counter-colon">:</span>
        <CounterWheel value={value} wheel="s10" />
        <CounterWheel value={value} wheel="s1" />
      </span>
    </div>
  );
}

/** A wheel rolls over in the last part of each second, like a mechanical counter clicking on. */
const ROLL_FROM = 0.82;

/**
 * One wheel of the min:sec counter. It sits still on its digit and rolls to the next one just
 * before it changes (carrying from the wheel to its right), never stopping between digits.
 */
function CounterWheel({ value, wheel }: { value: MotionValue<number>; wheel: "m10" | "m1" | "s10" | "s1" }) {
  const base = wheel === "s10" ? 6 : 10;
  const y = useTransform(value, (raw) => {
    const t = Math.max(0, raw);
    const s = Math.floor(t);
    const f = t - s;
    const r = Math.max(0, (f - ROLL_FROM) / (1 - ROLL_FROM));
    const roll = r * r * (3 - 2 * r); // eased
    const sec = s % 60;
    const min = Math.floor(s / 60) % 100;
    let digit = 0;
    let carry = false;
    if (wheel === "s1") [digit, carry] = [sec % 10, true];
    else if (wheel === "s10") [digit, carry] = [Math.floor(sec / 10), sec % 10 === 9];
    else if (wheel === "m1") [digit, carry] = [min % 10, sec === 59];
    else [digit, carry] = [Math.floor(min / 10), sec === 59 && min % 10 === 9];
    return `${-(digit + (carry ? roll : 0))}em`;
  });
  return (
    <span className="deck-digit">
      <motion.span className="deck-digit-strip" style={{ y }}>
        {[...Array.from({ length: base }, (_, d) => d), 0].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </motion.span>
    </span>
  );
}

/**
 * The deck's volume fader: a ridged cap in a recessed slot, with a Mute key beside it. Drag
 * it, click along the slot, scroll over it, or use the arrow keys; it ticks every 10%.
 */
function DeckVolume({
  volume,
  isMuted,
  onChange,
  onToggleMute,
}: {
  volume: number;
  isMuted: boolean;
  onChange: (volume: number) => void;
  onToggleMute: () => void;
}) {
  const effective = isMuted ? 0 : volume;
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? effective;
  const lastStep = useRef(Math.round(effective / 10));

  const set = (v: number) => {
    const next = Math.round(Math.min(100, Math.max(0, v)));
    const step = Math.round(next / 10);
    if (step !== lastStep.current) {
      lastStep.current = step;
      tapeFlick();
    }
    onChange(next);
  };
  const at = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * 100;
  };

  return (
    <div className="deck-volume">
      <span className="deck-volume-label">Volume</span>
      <div className="deck-volume-row">
        <button
          type="button"
          className={`deck-mute ${isMuted ? "is-on" : ""}`}
          onPointerDown={() => keyPress()}
          onClick={onToggleMute}
          aria-pressed={isMuted}
          aria-label={isMuted ? "Unmute" : "Mute"}
        >
          <i aria-hidden="true" />
          Mute
        </button>
        <div
          className={`deck-fader ${drag !== null ? "is-dragging" : ""}`}
          role="slider"
          tabIndex={0}
          aria-label="Volume"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(shown)}
          aria-valuetext={`${Math.round(shown)}%`}
          style={{ ["--v" as string]: `${shown}%` }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            const v = Math.min(100, Math.max(0, at(e)));
            setDrag(v);
            set(v);
          }}
          onPointerMove={(e) => {
            if (drag === null) return;
            const v = Math.min(100, Math.max(0, at(e)));
            setDrag(v);
            set(v);
          }}
          onPointerUp={() => setDrag(null)}
          onPointerCancel={() => setDrag(null)}
          onWheel={(e) => {
            e.stopPropagation();
            set(effective - e.deltaY / 12);
          }}
          onKeyDown={(e) => {
            const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 5 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -5 : 0;
            if (!d) return;
            e.preventDefault();
            e.stopPropagation(); // not the app's ±5s seek
            set(effective + d);
          }}
        >
          <span className="deck-fader-ticks" aria-hidden="true" />
          <span className="deck-fader-slot" aria-hidden="true">
            <span className="deck-fader-fill" />
          </span>
          <span className="deck-fader-cap" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

/** How many queued tapes stand in the crate. */
const CRATE_SIZE = 6;

/**
 * The next songs as tapes standing in a crate along the bottom edge, front to back: the
 * next song in front, later ones behind and higher, so each one's label peeks over the one
 * in front. Hover lifts a tape out; drag it to the deck (or click it) to play it.
 */
function TapeCrate({
  tracks,
  open,
  onOpen,
  onCloseSoon,
  onToggle,
  reduceMotion,
  held,
  busy,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onKey,
}: {
  tracks: SearchResult[];
  open: boolean;
  onOpen: () => void;
  onCloseSoon: (ms?: number) => void;
  onToggle: () => void;
  reduceMotion: boolean;
  held: string | null;
  busy: boolean;
  /** `slot` is where the tape is drawn now (maybe lifted); `home` is its fixed place in the crate. */
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, t: SearchResult, slot: HTMLElement, home: HTMLElement) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onKey: (e: ReactKeyboardEvent<HTMLElement>, t: SearchResult) => void;
}) {
  const shown = tracks.slice(0, CRATE_SIZE);
  const more = tracks.length - shown.length;
  const edgeTimer = useRef<number | null>(null);
  const slots = useRef<(HTMLLIElement | null)[]>([]);
  const lifts = useRef<(HTMLDivElement | null)[]>([]);
  /** The tape you're pointing at (by its label strip), or keyboard focus. */
  const [pointed, setPointed] = useState<number | null>(null);
  const holding = useRef(false);

  // The bounce only plays when the crate opens or closes; pointing at tapes afterwards moves
  // them straight away.
  const wasOpen = useRef(open);
  const toggling = wasOpen.current !== open;
  useEffect(() => {
    wasOpen.current = open;
    if (!open) setPointed(null);
  }, [open]);

  /**
   * Which tape is under the pointer. Every tape stands a little higher than the one in front,
   * so each owns the band from its own top edge down to the top of the tape in front (the
   * front tape owns everything below its top). Measured on the slots, which never move, so
   * lifting a tape can't take it out from under the pointer.
   */
  const tapeAt = (x: number, y: number) => {
    for (let i = 0; i < shown.length; i++) {
      const r = slots.current[i]?.getBoundingClientRect();
      if (r && x >= r.left && x <= r.right && y >= r.top + 2) return i;
    }
    return null;
  };

  const point = (i: number | null) => {
    if (i === pointed) return;
    if (i !== null && !reduceMotion) tapeFlick();
    setPointed(i);
  };

  // Pointing at a tape lifts it; the ones in front tip forward and drop, like flipping
  // through a crate, so the one you're on shows whole.
  const pose = (i: number) => {
    if (!open) return { y: "135%", rotateX: 0 };
    if (pointed === null || busy) return { y: "0%", rotateX: 0 };
    if (i === pointed) return { y: "-20%", rotateX: -6 };
    if (i < pointed) return { y: "34%", rotateX: 16 };
    return { y: "0%", rotateX: 0 };
  };
  const move = (i: number) =>
    reduceMotion
      ? { duration: 0.12 }
      : toggling && open
        ? { type: "spring" as const, stiffness: 420, damping: 15, mass: 0.9, delay: 0.04 + i * 0.05 }
        : toggling
          ? { duration: 0.2, ease: [0.5, 0, 0.9, 0.5] as const, delay: (shown.length - 1 - i) * 0.015 }
          : { type: "spring" as const, stiffness: 520, damping: 30 };

  return (
    <div
      className={`deck-crate-zone ${open ? "is-open" : ""}`}
      onPointerEnter={() => open && onOpen()}
      onPointerLeave={() => !busy && onCloseSoon()}
    >
      {/* Reaching for the bottom edge brings the crate up, like a drawer under the deck. */}
      <div
        className="deck-crate-edge"
        onPointerEnter={() => {
          edgeTimer.current = window.setTimeout(onOpen, 160);
        }}
        onPointerLeave={() => {
          if (edgeTimer.current) window.clearTimeout(edgeTimer.current);
        }}
      />
      <div
        className={`deck-crate ${busy ? "is-busy" : ""} ${pointed !== null && !busy ? "is-pointing" : ""}`}
        aria-hidden={!open}
        onPointerMove={(e) => {
          if (holding.current) return onPointerMove(e);
          if (!busy) point(tapeAt(e.clientX, e.clientY));
        }}
        onPointerLeave={() => !holding.current && point(null)}
        onPointerDown={(e) => {
          const i = tapeAt(e.clientX, e.clientY);
          if (i === null || busy) return;
          e.preventDefault(); // no text selection or native image drag from this press
          holding.current = true;
          point(i);
          onPointerDown(e, shown[i], lifts.current[i] ?? e.currentTarget, slots.current[i] ?? e.currentTarget);
        }}
        onPointerUp={(e) => {
          if (!holding.current) return;
          holding.current = false;
          setPointed(null);
          onPointerUp(e);
        }}
        onPointerCancel={(e) => {
          if (!holding.current) return;
          holding.current = false;
          onPointerUp(e);
        }}
      >
        <ul className="deck-crate-stack" aria-label="Up next">
          {shown.map((t, i) => (
            <li
              key={`${t.videoId}-${i}`}
              ref={(el) => {
                slots.current[i] = el;
              }}
              className="deck-crate-slot"
              style={{ ["--i" as string]: i, ["--tilt" as string]: `${[-1.2, 0.9, -0.5, 1.3, -0.9, 0.6][i % 6]}deg`, zIndex: CRATE_SIZE - i }}
            >
              <motion.div
                ref={(el) => {
                  lifts.current[i] = el;
                }}
                className={`deck-crate-lift ${pointed === i ? "is-pointed" : ""}`}
                initial={false}
                animate={pose(i)}
                transition={move(i)}
              >
                <button
                  type="button"
                  className={`deck-crate-tape ${held === t.videoId ? "is-held" : ""}`}
                  aria-label={`Play ${t.title} by ${t.artist}`}
                  title={`${t.title} · ${t.artist}`}
                  tabIndex={open ? 0 : -1}
                  onFocus={() => setPointed(i)}
                  onBlur={() => setPointed((p) => (p === i ? null : p))}
                  onKeyDown={(e) => onKey(e, t)}
                >
                  <CassetteTape track={t} art={thumbArt(t)} isPlaying={false} currentTime={0} duration={0} reduceMotion />
                </button>
              </motion.div>
            </li>
          ))}
        </ul>
        <motion.div
          className="deck-crate-front"
          initial={false}
          animate={{ y: open ? "0%" : "110%" }}
          transition={reduceMotion ? { duration: 0.12 } : { type: "spring", stiffness: 380, damping: 26 }}
        >
          <span>
            {shown.length === 0
              ? "Crate's empty. Queue songs from search and they'll stack up here."
              : pointed !== null && !busy
                ? `${shown[pointed].title} · drag it to the deck`
                : `Point at a tape, then drag it to the deck${more > 0 ? ` · ${more} more in the queue` : ""}`}
          </span>
        </motion.div>
      </div>

      {/* The pull tab: always there, says what's waiting. */}
      <button
        type="button"
        className="deck-crate-tab"
        aria-expanded={open}
        onClick={() => {
          keyPress();
          onToggle();
        }}
      >
        <span className="deck-crate-tab-arrow" aria-hidden="true">{open ? "▾" : "▴"}</span>
        {open ? "Put tapes away" : tracks.length ? `Tapes · ${tracks.length} up next` : "Tapes"}
      </button>
    </div>
  );
}

/** Elapsed · a phosphor progress bar · length, at the foot of the screen. Click or drag to seek. */
function ScreenSeek({
  currentTime,
  duration,
  isPlaying,
  onSeek,
  disabled,
}: {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  onSeek: (seconds: number) => void;
  disabled: boolean;
}) {
  const now = useLyricClock(currentTime, isPlaying);
  const [scrub, setScrub] = useState<number | null>(null);
  const fill = useMotionValue(0);
  useAnimationFrame(() => {
    fill.set(scrub ?? (duration > 0 ? Math.min(1, Math.max(0, now() / duration)) : 0));
  });
  const fillWidth = useTransform(fill, (f) => `${f * 100}%`);
  const fracAt = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const shownTime = scrub !== null ? scrub * duration : currentTime;
  return (
    <div className="deck-seek">
      <span className="deck-seek-time">{formatTime(shownTime)}</span>
      <div
        className="deck-seek-bar"
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        aria-disabled={disabled || undefined}
        onPointerDown={(e) => {
          if (disabled || duration <= 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setScrub(fracAt(e));
        }}
        onPointerMove={(e) => scrub !== null && setScrub(fracAt(e))}
        onPointerUp={(e) => {
          if (scrub === null) return;
          onSeek(fracAt(e) * duration);
          setScrub(null);
        }}
        onPointerCancel={() => setScrub(null)}
      >
        <motion.span className="deck-seek-fill" style={{ width: fillWidth }} />
      </div>
      <span className="deck-seek-time">{formatTime(duration)}</span>
    </div>
  );
}

function formatTime(s: number) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}
