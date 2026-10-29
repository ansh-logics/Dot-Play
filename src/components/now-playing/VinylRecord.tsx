import { useRef } from "react";
import { motion, useAnimationFrame, useMotionValue } from "motion/react";
import { ArtworkImage } from "../ArtworkImage";
import type { SearchResult } from "../../lib/search";
import { useLyricClock } from "./useLyricClock";
import { TonearmParts } from "../vinyl/TonearmParts";
import "../vinyl/vinyl.css";

/** One revolution every 5s: a real 33⅓ rpm (1.8s) reads as frantic on screen. */
const PLAYING_DEG_PER_MS = 360 / 5000;
/** Time constant for spin-up / spin-down, so the platter eases instead of snapping. */
const SPIN_EASE_MS = 700;

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
    <div className={`vinyl ${isPlaying ? "is-playing" : ""}`}>
      <motion.div className="vinyl-disc" style={{ rotate: angle }}>
        <div className="vinyl-label">
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
        <div className="vinyl-spindle" />
      </motion.div>
      {/* Fixed highlight: the light doesn't turn with the record, which is what sells the spin. */}
      <div className="vinyl-sheen" aria-hidden="true" />
      <motion.svg className="vinyl-arm" viewBox="0 0 100 100" aria-hidden="true" style={{ rotate: arm }}>
        <TonearmParts />
      </motion.svg>
    </div>
  );
}
