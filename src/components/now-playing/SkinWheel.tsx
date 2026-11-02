import { memo, useCallback, useEffect, useRef, type PointerEvent, type WheelEvent } from "react";
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
import {
  PLAYER_SKINS,
  nearestSelectablePosition,
  wrapIndex,
  type PlayerSkinId,
} from "../../lib/playerSkins";
import { settle, tick } from "../../lib/feedback";

const N = PLAYER_SKINS.length;
const STEP_DEG = 17;
const RADIUS = 150; // px from disc centre to where a label starts
const WHEEL_PX_PER_NOTCH = 48;
const DRAG_PX_PER_NOTCH = 56;
const IDLE_SNAP_MS = 140;
/** A released drag keeps going for about this long at its release speed (a flick spins on). */
const FLING_SECONDS = 0.22;
/** Only the last bit of a drag decides the release speed. */
const VELOCITY_WINDOW_MS = 90;
const AUTO_HIDE_MS = 1200;
/** Landing: soft, with a hint of follow-through but no visible bounce. */
const SNAP_SPRING = { type: "spring", stiffness: 360, damping: 30 } as const;
/** Visual follow: smooths coarse input (mouse-wheel clicks, jumpy deltas). */
const FOLLOW_SPRING = { stiffness: 600, damping: 48 };

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
}

function WheelItem({
  index,
  shown,
  selected,
  reduceMotion,
}: {
  index: number;
  shown: MotionValue<number>;
  selected: boolean;
  reduceMotion: boolean;
}) {
  const item = PLAYER_SKINS[index];
  const d = useTransform(shown, (p) => loopDistance(index, p));
  const transform = useTransform(d, (v) => {
    const a = Math.abs(v);
    const focus = Math.max(0, 1 - a); // 1 at the indicator, 0 one notch away
    return `rotate(${v * STEP_DEG}deg) translateX(${RADIUS}px) scale(${1 + focus * 0.06 - Math.min(a, 2) * 0.18})`;
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
      <motion.span className="np-wheel-label" style={{ color, textShadow }}>
        {item.label}
      </motion.span>
      {item.soon && <span className="np-wheel-soon">SOON</span>}
    </motion.li>
  );
}

/**
 * Curved, detented, endlessly looping picker for the player style. Spins with
 * trackpad/mouse wheel, vertical drag or ↑/↓; every notch clicks (sound + Force
 * Touch haptic). The chosen style is applied once the wheel comes to rest.
 */
export const SkinWheel = memo(function SkinWheel({ open, skin, onSelect, onClose, reduceMotion }: SkinWheelProps) {
  const currentIndex = PLAYER_SKINS.findIndex((s) => s.id === skin);
  /** Input position: unbounded, so the wheel loops. */
  const pos = useMotionValue(currentIndex);
  const follow = useSpring(pos, FOLLOW_SPRING);
  const shown = reduceMotion ? pos : follow;
  const lastNotch = useRef(currentIndex);
  const listRef = useRef<HTMLUListElement>(null);
  const idleTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const hovered = useRef(false);
  const drag = useRef<{ y: number; start: number; samples: { t: number; p: number }[] } | null>(null);
  /** Where queued wheel clicks / key presses are heading, so quick inputs add up. */
  const pendingTarget = useRef<number | null>(null);
  /** The running snap/step animation; new input must cancel it or the two fight over `pos`. */
  const snapAnim = useRef<ReturnType<typeof animate> | null>(null);
  const stopSnap = () => {
    snapAnim.current?.stop();
    snapAnim.current = null;
  };

  // One click per detent crossed, timed to what's on screen (incl. while settling).
  useMotionValueEvent(shown, "change", (p) => {
    const notch = Math.round(p);
    if (notch !== lastNotch.current) {
      lastNotch.current = notch;
      tick();
      listRef.current?.setAttribute("aria-activedescendant", `np-skin-${PLAYER_SKINS[wrapIndex(notch)].id}`);
    }
  });

  const clearTimers = () => {
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
  };

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!hovered.current) onClose();
    }, AUTO_HIDE_MS);
  }, [onClose]);

  /**
   * Spring to a detent; teasers bounce to the nearest real style, the short way round.
   * `velocity` (notches/s) carries a released drag's speed into the spring.
   */
  const snapTo = useCallback(
    (target: number, velocity = 0) => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
      pendingTarget.current = null;
      const landing = nearestSelectablePosition(target);
      const finish = () => {
        const chosen = PLAYER_SKINS[wrapIndex(landing)];
        if (chosen.id !== skin) {
          settle();
          onSelect(chosen.id);
        }
        scheduleHide();
      };
      stopSnap();
      if (reduceMotion) {
        pos.set(landing);
        finish();
      } else {
        snapAnim.current = animate(pos, landing, { ...SNAP_SPRING, velocity, onComplete: finish });
      }
    },
    [onSelect, pos, reduceMotion, scheduleHide, skin],
  );

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
    requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }));
    return clearTimers;
    // Only on open; skin changes made by the wheel itself shouldn't re-sync mid-spin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keyboard while open: ↑/↓ step (wrapping, skipping teasers).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      e.stopPropagation(); // don't also seek ±5s
      const dir = e.key === "ArrowDown" ? 1 : -1;
      let next = (pendingTarget.current ?? Math.round(pos.get())) + dir;
      for (let guard = 0; PLAYER_SKINS[wrapIndex(next)].soon && guard < N; guard++) next += dir;
      pendingTarget.current = next;
      stopSnap();
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
    // of small deltas. Clicks move exactly one notch each; trackpads follow the finger.
    const discrete = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 60;
    if (discrete) {
      const target = (pendingTarget.current ?? Math.round(pos.get())) + Math.sign(e.deltaY);
      pendingTarget.current = target;
      pos.set(target); // the follow spring makes the step glide
      settleSoon();
      return;
    }
    pendingTarget.current = null;
    pos.set(pos.get() + e.deltaY / WHEEL_PX_PER_NOTCH);
    settleSoon();
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    stopSnap();
    drag.current = { y: e.clientY, start: pos.get(), samples: [{ t: e.timeStamp, p: pos.get() }] };
    pendingTarget.current = null;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = d.start + (d.y - e.clientY) / DRAG_PX_PER_NOTCH;
    pos.set(p);
    d.samples.push({ t: e.timeStamp, p });
    while (d.samples.length > 2 && e.timeStamp - d.samples[0].t > VELOCITY_WINDOW_MS) d.samples.shift();
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
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
    // Release speed over the last few moves, in notches/s: a flick spins on, a slow drag
    // stops where it was let go.
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    const stale = e.timeStamp - last.t > VELOCITY_WINDOW_MS; // held still before letting go
    const velocity = dt > 0 && !stale ? (last.p - first.p) / dt : 0;
    const reach = Math.max(-2 * N, Math.min(2 * N, velocity * FLING_SECONDS));
    snapTo(Math.round(pos.get() + reach), velocity);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="wheel"
          className="np-wheel"
          initial={{ x: "-100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "-100%", opacity: 0, transition: { duration: 0.22 } }}
          transition={reduceMotion ? { duration: 0.12 } : { type: "spring", stiffness: 380, damping: 36 }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (drag.current = null)}
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
          <div className="np-wheel-disc" aria-hidden="true" />
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
              <WheelItem key={s.id} index={i} shown={shown} selected={s.id === skin} reduceMotion={reduceMotion} />
            ))}
          </ul>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
