import { useRef } from "react";
import { motion, useAnimationFrame, useMotionValue, useTransform } from "motion/react";
import { SettledArt } from "./SettledArt";
import type { SettledArtwork } from "./useSettledArtwork";
import type { SearchResult } from "../../lib/search";
import { cleanDisplayTitle } from "../../lib/displayText";
import { useLyricClock } from "./useLyricClock";
import "./cassette.css";

/*
 * Tape geometry, in % of the cassette's width (the CSS draws in the same cqw units).
 * Both reels hold the same tape, so the areas add up: r_left² + r_right² stays constant.
 */
const HUB_R = 4.6;
const FULL_R = 17;
const packRadius = (share: number) => Math.sqrt(HUB_R * HUB_R + (FULL_R * FULL_R - HUB_R * HUB_R) * share);

/**
 * Tape runs past the head at a constant speed, so a reel turns faster the less tape it
 * holds: degrees per ms for a pack of radius r is TAPE_SPEED / r. About one turn every 2s at
 * mid-pack, slow enough to read as calm.
 */
const TAPE_SPEED = 1.9;
/** A seek winds the tape: a full song's worth turns a mid-sized reel ~12 times. */
const SEEK_WIND = 40000;
/** Spin-up / spin-down, like the capstan motor catching. */
const MOTOR_EASE_MS = 450;
/** How quickly the tape packs follow a seek (the fast-wind takes about this long). */
const WIND_EASE_MS = 420;

interface CassetteTapeProps {
  track: SearchResult;
  /** The cover, already loaded and measured (see useSettledArtwork). */
  art: SettledArtwork | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  reduceMotion: boolean;
}

/**
 * The player as a cassette: the cover is the label's colour band, the title is handwritten
 * on the label, and through the window the tape winds from the left reel to the right one
 * as the song plays. Seeking fast-winds the reels.
 */
export function CassetteTape({ track, art, isPlaying, currentTime, duration, reduceMotion }: CassetteTapeProps) {
  const now = useLyricClock(currentTime, isPlaying);
  const progressOf = () => (duration > 0 ? Math.min(1, Math.max(0, now() / duration)) : 0);
  /** Played share of the tape, eased so a seek winds instead of jumping. */
  const wound = useMotionValue(progressOf());
  const leftAngle = useMotionValue(0);
  const rightAngle = useMotionValue(0);
  const motor = useRef(0);

  const leftR = useTransform(wound, (p) => packRadius(1 - p));
  const rightR = useTransform(wound, (p) => packRadius(p));
  const leftScale = useTransform(leftR, (r) => r / FULL_R);
  const rightScale = useTransform(rightR, (r) => r / FULL_R);

  useAnimationFrame((_, dt) => {
    const target = progressOf();
    if (reduceMotion) {
      wound.set(target);
      return;
    }
    const before = wound.get();
    const after = Math.abs(target - before) < 1e-5 ? target : before + (target - before) * (1 - Math.exp(-dt / WIND_EASE_MS));
    wound.set(after);

    motor.current += ((isPlaying ? 1 : 0) - motor.current) * Math.min(1, dt / MOTOR_EASE_MS);
    if (!isPlaying && motor.current < 0.002) motor.current = 0;
    // Playing turns the reels at tape speed; any extra change in position (a seek) winds them,
    // backwards for a rewind.
    const wind = (after - before) * SEEK_WIND;
    const play = motor.current * TAPE_SPEED * dt;
    const rl = packRadius(1 - after);
    const rr = packRadius(after);
    leftAngle.set((leftAngle.get() + (play + wind) / rl) % 360);
    rightAngle.set((rightAngle.get() + (play + wind) / rr) % 360);
  });

  return (
    <div className={`cassette ${isPlaying ? "is-playing" : ""}`}>
      <div className="cassette-shell">
        <span className="cassette-screw is-tl" />
        <span className="cassette-screw is-tr" />
        <span className="cassette-screw is-bl" />
        <span className="cassette-screw is-br" />

        <div className="cassette-label">
          <div className="cassette-label-top">
            <span className="cassette-side">A</span>
            <span className="cassette-title" title={track.title}>
              {cleanDisplayTitle(track.title)}
            </span>
          </div>
          <div className="cassette-label-artist">{track.artist}</div>
          <div className="cassette-band">
            {/* Only this tape's own cover: a new tape is blank card until its cover arrives,
                then it fades in, rather than briefly wearing the previous song's. */}
            <SettledArt art={art?.videoId === track.videoId ? art : null} alt={`${track.title} artwork`} />
            <span className="cassette-band-mark is-left">dot(.)</span>
            <span className="cassette-band-mark is-right">C60</span>
          </div>
        </div>

        {/* The window: tape packs and hubs turn behind smoked plastic. */}
        <div className="cassette-window">
          <motion.span className="cassette-pack is-left" style={{ scale: leftScale }} />
          <motion.span className="cassette-pack is-right" style={{ scale: rightScale }} />
          <motion.span className="cassette-hub is-left" style={{ rotate: leftAngle }} />
          <motion.span className="cassette-hub is-right" style={{ rotate: rightAngle }} />
          <span className="cassette-glass" />
        </div>

        <div className="cassette-mouth">
          <span className="cassette-hole is-left" />
          <span className="cassette-head" />
          <span className="cassette-hole is-right" />
          <span className="cassette-screw is-bottom" />
        </div>
      </div>
      {/* Fixed light over the plastic, so the reels move under it. */}
      <div className="cassette-sheen" aria-hidden="true" />
    </div>
  );
}
