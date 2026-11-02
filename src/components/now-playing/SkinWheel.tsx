import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import { PLAYER_SKINS, wrapIndex, type PlayerSkinId } from "../../lib/playerSkins";
import { reject, settle, tick } from "../../lib/feedback";

const N = PLAYER_SKINS.length;
const STEP_DEG = 17;
/** Disc centre to where a label starts, in wheel units (--np-wheel-u scales with the window). */
const RADIUS = 150;
const WHEEL_PX_PER_NOTCH = 48;
const DRAG_PX_PER_NOTCH = 56;
const IDLE_SNAP_MS = 140;
/** Only the last bit of a drag decides the release speed. */
const VELOCITY_WINDOW_MS = 90;
/**
 * Flywheel: a released flick coasts and friction bleeds its speed off exponentially. It
 * travels about speed × FLING_TAU notches, so the clicks visibly and audibly slow down.
 */
const FLING_TAU = 0.42;
/** Slower than this (notches/s) and a release just settles on the nearest notch. */
const FLING_MIN = 2.5;
const FLING_MAX = 60;
const AUTO_HIDE_MS = 1200;
const HINT_MS = 1700;
/** Landing: soft, with a hint of follow-through but no visible bounce. */
const SNAP_SPRING = { type: "spring", stiffness: 360, damping: 30 } as const;
/** Thrown back off a locked style: quicker, with a little overshoot. */
const REBOUND_SPRING = { type: "spring", stiffness: 420, damping: 24 } as const;
/** Visual follow: smooths coarse input (mouse-wheel clicks). Fine input bypasses it. */
const FOLLOW_SPRING = { stiffness: 600, damping: 48 };
/**
 * Magnetic detents: how strongly the wheel holds each notch. The shown position lags the
 * input near a notch and catches up past the midpoint, so it pulls in and clicks over like a
 * real ratcheted knob. 0 is a smooth wheel; below 1 it never runs backwards.
 */
const DETENT = 0.42;
/** The pawl on the rim is kicked by each passing notch, then springs back. */
const PAWL_SPRING = { type: "spring", stiffness: 1100, damping: 16 } as const;

const detent = (p: number) => p - (DETENT * Math.sin(2 * Math.PI * p)) / (2 * Math.PI);
const isLocked = (p: number) => !!PLAYER_SKINS[wrapIndex(p)].soon;

/** Shortest signed distance on the loop from position `p` to item `index`, in (−N/2, N/2]. */
function loopDistance(index: number, p: number) {
  let d = (((index - p) % N) + N) % N;
  if (d > N / 2) d -= N;
  return d;
}

interface SkinWheelProps {
  open: boolean;
  skin: PlayerSkinId;
  onSelect: (id: PlayerSkinId) => void;
  onClose: () => void;
  reduceMotion: boolean;
  /** The current cover, shown inside each style's little preview. */
  artworkUrl?: string | null;
}

function WheelItem({
  index,
  shown,
  selected,
  reduceMotion,
  artworkUrl,
}: {
  index: number;
  shown: MotionValue<number>;
  selected: boolean;
  reduceMotion: boolean;
  artworkUrl?: string | null;
}) {
  const item = PLAYER_SKINS[index];
  const d = useTransform(shown, (p) => loopDistance(index, p));
  const transform = useTransform(d, (v) => {
    const a = Math.abs(v);
    const focus = Math.max(0, 1 - a); // 1 at the indicator, 0 one notch away
    return `rotate(${v * STEP_DEG}deg) translateX(calc(${RADIUS} * var(--np-wheel-u))) scale(${1 + focus * 0.06 - Math.min(a, 2) * 0.18})`;
  });
  // Fade fully out before |d| reaches N/2, where an item wraps to the other side.
  const opacity = useTransform(d, (v) => {
    const a = Math.abs(v);
    const falloff = Math.max(0, 1 - a * 0.42);
    const edge = Math.min(1, Math.max(0, (1.9 - a) / 0.5));
    return falloff * edge * (item.soon ? 0.6 : 1);
  });
  // Out-of-focus blur via text-shadow (sharp glyphs fade out as a soft shadow fades in).
  // filter: blur() would composite each label as its own layer, and WebKit can leave thin
  // coloured seams at those layer edges while they move.
  const color = useTransform(d, (v) =>
    reduceMotion ? "rgb(var(--np-wheel-ink))" : `rgba(var(--np-wheel-ink), ${Math.max(0, 1 - Math.abs(v) * 1.6).toFixed(3)})`,
  );
  const textShadow = useTransform(d, (v) => {
    if (reduceMotion) return "none";
    const a = Math.abs(v);
    const blur = Math.min(a, 2) * 2.2;
    return `0 0 ${blur.toFixed(2)}px rgba(var(--np-wheel-ink), ${Math.min(1, a * 1.6).toFixed(3)})`;
  });
  // The preview is an icon off to the side and grows into a little picture of the style,
  // with your cover in it, as it reaches the pointer.
  const thumbScale = useTransform(d, (v) => 0.6 + Math.max(0, 1 - Math.abs(v)) * 0.4);
  const thumbOpacity = useTransform(d, (v) => 0.5 + Math.max(0, 1 - Math.abs(v)) * 0.5);
  const art = artworkUrl ? `url(${JSON.stringify(artworkUrl)})` : "none";
  return (
    <motion.li
      id={`np-skin-${item.id}`}
      role="option"
      aria-selected={selected}
      aria-disabled={item.soon || undefined}
      data-index={index}
      className={`np-wheel-item ${item.soon ? "is-soon" : ""}`}
      style={{ transform, opacity }}
    >
      <motion.span
        className={`np-wheel-thumb is-${item.id}`}
        aria-hidden="true"
        style={{ scale: thumbScale, opacity: thumbOpacity }}
      >
        <span className="np-wheel-thumb-art" style={{ ["--np-thumb-art" as string]: art } as CSSProperties} />
      </motion.span>
      <motion.span className="np-wheel-label" style={{ color, textShadow }}>
        {item.label}
      </motion.span>
      {item.soon && <span className="np-wheel-soon">SOON</span>}
    </motion.li>
  );
}

/**
 * Curved, detented, endlessly looping picker for the player style. Spins with
 * trackpad/mouse wheel, vertical drag or ↑/↓; a flick coasts like a flywheel; every notch
 * clicks (sound + Force Touch haptic). A style that isn't out yet is a locked stop: the
 * wheel knocks against it and is thrown back. The chosen style is applied at rest.
 */
export const SkinWheel = memo(function SkinWheel({ open, skin, onSelect, onClose, reduceMotion, artworkUrl }: SkinWheelProps) {
  const currentIndex = PLAYER_SKINS.findIndex((s) => s.id === skin);
  /** Input position: unbounded, so the wheel loops. */
  const pos = useMotionValue(currentIndex);
  const follow = useSpring(pos, FOLLOW_SPRING);
  /** A small shake added on top, so a judder isn't smoothed away by the follow spring. */
  const judder = useMotionValue(0);
  const shown = useTransform([reduceMotion ? pos : follow, judder], ([p, j]: number[]) => detent(p + j));
  /** The knob turns with the labels: one notch on the rim per style. */
  const rotorRotate = useTransform(shown, (p) => -p * STEP_DEG);
  const pawl = useMotionValue(0);
  const [pressed, setPressed] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const lastNotch = useRef(currentIndex);
  const lastNotchAt = useRef(0);
  /** Which way the wheel last clicked over (+1 down the list, −1 up). */
  const lastDir = useRef(1);
  const listRef = useRef<HTMLUListElement>(null);
  const idleTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const hintTimer = useRef<number | null>(null);
  const hovered = useRef(false);
  const drag = useRef<{ y: number; start: number; samples: { t: number; p: number }[] } | null>(null);
  /** Where queued wheel clicks / key presses are heading, so quick inputs add up. */
  const pendingTarget = useRef<number | null>(null);
  /** The running snap/step animation; new input must cancel it or the two fight over `pos`. */
  const snapAnim = useRef<ReturnType<typeof animate> | null>(null);
  const flingFrame = useRef<number | null>(null);
  /** Bumped whenever motion is interrupted, so a multi-step sequence knows to give up. */
  const motionGen = useRef(0);
  const stopSnap = () => {
    motionGen.current++;
    snapAnim.current?.stop();
    snapAnim.current = null;
    if (flingFrame.current) cancelAnimationFrame(flingFrame.current);
    flingFrame.current = null;
  };
  /** Fine input (drag, trackpad, coasting) tracks 1:1 with no spring lag; only the detents shape it. */
  const setDirect = (p: number) => {
    pos.set(p);
    follow.jump(p);
  };

  // One click per detent crossed, timed to what's on screen (incl. while settling). The time
  // since the last notch gives the speed, which shapes the click.
  useMotionValueEvent(shown, "change", (p) => {
    const notch = Math.round(p);
    if (notch !== lastNotch.current) {
      const dir = Math.sign(notch - lastNotch.current);
      const now = performance.now();
      const speed = 1000 / Math.max(1, now - lastNotchAt.current);
      lastNotch.current = notch;
      lastNotchAt.current = now;
      lastDir.current = dir;
      tick(speed);
      if (!reduceMotion) {
        pawl.set(-dir * 14);
        animate(pawl, 0, PAWL_SPRING);
      }
      listRef.current?.setAttribute("aria-activedescendant", `np-skin-${PLAYER_SKINS[wrapIndex(notch)].id}`);
    }
  });

  const clearTimers = () => {
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
  };

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!hovered.current) onClose();
    }, AUTO_HIDE_MS);
  }, [onClose]);

  const showHint = (label: string) => {
    setHint(`${label} is coming soon`);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), HINT_MS);
  };

  /**
   * Spring to the detent nearest `target`. `velocity` (notches/s) carries a released drag's
   * speed into the spring. A locked style is a stop: the wheel seats in it, knocks, shakes
   * and is thrown back to the style it came from.
   */
  const snapTo = useCallback(
    (target: number, velocity = 0) => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
      pendingTarget.current = null;
      stopSnap();
      const gen = motionGen.current;
      const stop = Math.round(target);
      const finish = (landing: number) => {
        const chosen = PLAYER_SKINS[wrapIndex(landing)];
        if (chosen.id !== skin) {
          settle();
          onSelect(chosen.id);
        }
        scheduleHide();
      };

      if (!isLocked(stop)) {
        if (reduceMotion) {
          pos.set(stop);
          finish(stop);
        } else {
          snapAnim.current = animate(pos, stop, { ...SNAP_SPRING, velocity, onComplete: () => finish(stop) });
        }
        return;
      }

      // Thrown back the way it came, past any other locked styles.
      const dir = Math.sign(stop - pos.get()) || Math.sign(velocity) || lastDir.current;
      let back = stop - dir;
      for (let guard = 0; isLocked(back) && guard < N; guard++) back -= dir;
      const label = PLAYER_SKINS[wrapIndex(stop)].label;

      if (reduceMotion) {
        reject();
        showHint(label);
        pos.set(back);
        finish(back);
        return;
      }
      void (async () => {
        const seat = animate(pos, stop, { type: "spring", stiffness: 700, damping: 42, velocity });
        snapAnim.current = seat;
        await seat;
        if (gen !== motionGen.current) return;
        reject();
        showHint(label);
        await animate(judder, [0, -dir * 0.1, dir * 0.07, -dir * 0.04, dir * 0.015, 0], { duration: 0.32, ease: "easeOut" });
        if (gen !== motionGen.current) return;
        snapAnim.current = animate(pos, back, { ...REBOUND_SPRING, velocity: -dir * 6, onComplete: () => finish(back) });
      })();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onSelect, pos, judder, reduceMotion, scheduleHide, skin],
  );

  /** Coast from the current position with `velocity` (notches/s), slowing by friction. */
  const fling = (velocity: number) => {
    const v0 = Math.max(-FLING_MAX, Math.min(FLING_MAX, velocity));
    const p0 = pos.get();
    const target = Math.round(p0 + v0 * FLING_TAU);
    const distance = target - p0;
    const tau = distance / v0; // keeps the start speed equal to the release speed
    if (reduceMotion || Math.abs(v0) < FLING_MIN || !(tau > 0.12 && tau < 0.9)) {
      snapTo(p0 + (reduceMotion ? 0 : v0 * 0.12), v0);
      return;
    }
    stopSnap();
    const gen = motionGen.current;
    let start: number | null = null;
    const frame = (now: number) => {
      if (gen !== motionGen.current) return;
      start ??= now;
      const t = (now - start) / 1000;
      const decay = Math.exp(-t / tau);
      setDirect(p0 + distance * (1 - decay));
      // Hand the last crawl to the landing spring, with the speed it still has.
      if (Math.abs(distance * decay) < 0.03) {
        flingFrame.current = null;
        snapTo(target, (distance / tau) * decay);
        return;
      }
      flingFrame.current = requestAnimationFrame(frame);
    };
    flingFrame.current = requestAnimationFrame(frame);
  };

  const settleSoon = useCallback(() => {
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => snapTo(pendingTarget.current ?? pos.get()), IDLE_SNAP_MS);
  }, [pos, snapTo]);

  // Re-sync silently whenever it opens: jump (not spring) so it doesn't spin or tick.
  useEffect(() => {
    if (!open) return;
    const i = PLAYER_SKINS.findIndex((s) => s.id === skin);
    lastNotch.current = i;
    pendingTarget.current = null;
    pos.jump(i);
    follow.jump(i);
    judder.jump(0);
    setHint(null);
    requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
    return () => {
      clearTimers();
      stopSnap();
    };
    // Only on open; skin changes made by the wheel itself shouldn't re-sync mid-spin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keyboard while open: ↑/↓ step (wrapping, skipping teasers so the loop stays reachable).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      e.stopPropagation(); // don't also seek ±5s
      const dir = e.key === "ArrowDown" ? 1 : -1;
      let next = (pendingTarget.current ?? Math.round(pos.get())) + dir;
      for (let guard = 0; isLocked(next) && guard < N; guard++) next += dir;
      stopSnap();
      pendingTarget.current = next;
      if (reduceMotion) pos.set(next);
      else snapAnim.current = animate(pos, next, SNAP_SPRING);
      settleSoon();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, pos, reduceMotion, settleSoon]);

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (!e.deltaY) return;
    stopSnap(); // the user is spinning again: input wins over an in-flight snap
    // A mouse wheel sends one big step per click (or line units); a trackpad sends a stream
    // of small deltas. Clicks move exactly one notch each; trackpads follow the finger (and
    // macOS already adds its own momentum after a swipe).
    const discrete = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 60;
    if (discrete) {
      const target = (pendingTarget.current ?? Math.round(pos.get())) + Math.sign(e.deltaY);
      pendingTarget.current = target;
      pos.set(target); // the follow spring makes the step glide
      settleSoon();
      return;
    }
    pendingTarget.current = null;
    setDirect(pos.get() + e.deltaY / WHEEL_PX_PER_NOTCH);
    settleSoon();
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    stopSnap(); // catching a coasting wheel stops it dead, like a hand on a flywheel
    judder.set(0);
    drag.current = { y: e.clientY, start: pos.get(), samples: [{ t: e.timeStamp, p: pos.get() }] };
    pendingTarget.current = null;
    setPressed(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = d.start + (d.y - e.clientY) / DRAG_PX_PER_NOTCH;
    setDirect(p);
    d.samples.push({ t: e.timeStamp, p });
    while (d.samples.length > 2 && e.timeStamp - d.samples[0].t > VELOCITY_WINDOW_MS) d.samples.shift();
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setPressed(false);
    if (!d) return;
    if (Math.abs(d.y - e.clientY) < 4) {
      // A tap: spin to the tapped item the short way round.
      const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-index]");
      if (el) {
        const p = pos.get();
        snapTo(p + loopDistance(Number(el.dataset.index), p));
        return;
      }
    }
    // Release speed over the last few moves, in notches/s: a flick coasts on, a slow drag
    // stops where it was let go.
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    const stale = e.timeStamp - last.t > VELOCITY_WINDOW_MS; // held still before letting go
    const velocity = dt > 0 && !stale ? (last.p - first.p) / dt : 0;
    fling(velocity);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="wheel"
          className={`np-wheel ${pressed ? "is-pressed" : ""}`}
          initial={{ x: "-100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "-100%", opacity: 0, transition: { duration: 0.22 } }}
          transition={reduceMotion ? { duration: 0.12 } : { type: "spring", stiffness: 380, damping: 36 }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag.current = null;
            setPressed(false);
          }}
          onPointerEnter={() => {
            hovered.current = true;
            if (hideTimer.current) window.clearTimeout(hideTimer.current);
          }}
          onPointerLeave={() => {
            hovered.current = false;
            scheduleHide();
          }}
        >
          <div className="np-wheel-scrim" aria-hidden="true" />
          <div className="np-wheel-disc" aria-hidden="true">
            <motion.div className="np-wheel-rotor" style={{ rotate: rotorRotate }}>
              <div className="np-wheel-knurl" />
              <div className="np-wheel-ticks" />
              <div className="np-wheel-cap" />
            </motion.div>
            <div className="np-wheel-glare" />
            <motion.div className="np-wheel-pawl" style={{ rotate: pawl }} />
          </div>
          <ul
            ref={listRef}
            className="np-wheel-list"
            role="listbox"
            aria-label="Player style"
            aria-orientation="vertical"
            aria-activedescendant={`np-skin-${skin}`}
            tabIndex={0}
          >
            {PLAYER_SKINS.map((s, i) => (
              <WheelItem
                key={s.id}
                index={i}
                shown={shown}
                selected={s.id === skin}
                reduceMotion={reduceMotion}
                artworkUrl={artworkUrl}
              />
            ))}
          </ul>
          <AnimatePresence>
            {hint && (
              <motion.div
                key="hint"
                className="np-wheel-hint"
                role="status"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.25 } }}
              >
                {hint}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
