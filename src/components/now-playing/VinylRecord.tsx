import { useRef } from "react";
import { motion, useAnimationFrame, useMotionValue } from "motion/react";
import { ArtworkImage } from "../ArtworkImage";
import type { SearchResult } from "../../lib/search";
import { useLyricClock } from "./useLyricClock";

/** One revolution every 3.6s: calmer than a real 33⅓ rpm (1.8s), which reads as frantic on screen. */
const PLAYING_DEG_PER_MS = 360 / 3600;
/** Time constant for spin-up / spin-down, so the platter eases instead of snapping. */
const SPIN_EASE_MS = 450;

/*
 * Tonearm geometry (SVG units, the record fills a 100×100 box centred at 50,50, radius 46;
 * the label has radius 19). Pivot at (82,16). Angles are CSS rotations about the pivot:
 *   rest  −32° → needle off the record
 *   start −18° → needle near the outer rim (start of the song)
 *   end    +4° → needle just outside the label (end of the song)
 */
const ARM_REST = -32;
const ARM_START = -18;
const ARM_END = 4;
/** Time constant for the arm easing toward its target (lift, drop and seeks). */
const ARM_EASE_MS = 320;

interface VinylRecordProps {
  track: SearchResult;
  isPlaying: boolean;
  /** Playback position; moves the tonearm inward through the song like a real record. */
  currentTime: number;
  duration: number;
  reduceMotion: boolean;
}

export function VinylRecord({ track, isPlaying, currentTime, duration, reduceMotion }: VinylRecordProps) {
  const angle = useMotionValue(0);
  const speed = useRef(0);
  const arm = useMotionValue(ARM_REST);
  // The app reports time every ~100ms; this interpolates per frame so the arm drifts smoothly.
  const now = useLyricClock(currentTime, isPlaying);

  // One frame loop drives both the platter and the arm. The arm eases exponentially toward
  // its target every frame (no CSS transition that would restart on each 100ms time update).
  useAnimationFrame((_, dt) => {
    const progress = duration > 0 ? Math.min(1, Math.max(0, now() / duration)) : 0;
    const armTarget = isPlaying ? ARM_START + progress * (ARM_END - ARM_START) : ARM_REST;
    if (reduceMotion) {
      arm.set(armTarget);
      return;
    }
    const a = arm.get();
    if (Math.abs(armTarget - a) > 0.001) arm.set(a + (armTarget - a) * (1 - Math.exp(-dt / ARM_EASE_MS)));

    const target = isPlaying ? PLAYING_DEG_PER_MS : 0;
    speed.current += (target - speed.current) * Math.min(1, dt / SPIN_EASE_MS);
    if (!isPlaying && speed.current < 0.0005) {
      speed.current = 0;
      return;
    }
    angle.set((angle.get() + speed.current * dt) % 360);
  });

  return (
    <div className={`np-vinyl ${isPlaying ? "is-playing" : ""}`}>
      <motion.div className="np-vinyl-disc" style={{ rotate: angle }}>
        <div className="np-vinyl-label">
          <ArtworkImage
            key={track.videoId}
            src={track.thumbnailUrl}
            videoId={track.videoId}
            alt={`${track.title} artwork`}
            className="np-art"
            variant="hero"
            priority
          />
        </div>
        <div className="np-vinyl-spindle" />
      </motion.div>
      {/* Fixed highlight: the light doesn't turn with the record, which is what sells the spin. */}
      <div className="np-vinyl-sheen" aria-hidden="true" />
      <motion.svg className="np-vinyl-arm" viewBox="0 0 100 100" aria-hidden="true" style={{ rotate: arm }}>
        {/* soft shadow: the arm path offset, no filter */}
        <path d="M84 18 L71 65 L68 72" className="np-arm-shadow" />
        <line x1="82" y1="16" x2="89" y2="5" className="np-arm-weight" />
        <circle cx="82" cy="16" r="6.5" className="np-arm-base" />
        <path d="M82 16 L69 63 L66 70" className="np-arm-tube" />
        <path d="M63.2 67.6 L69.4 69.9 L67.4 76.2 L61.2 73.9 Z" className="np-arm-head" />
        <circle cx="82" cy="16" r="2.6" className="np-arm-cap" />
      </motion.svg>
    </div>
  );
}
