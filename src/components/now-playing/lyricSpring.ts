/**
 * The spring the lyric lines move on when the song reaches the next line: a damped harmonic
 * oscillator (mass 1, stiffness 100, damping 18), the feel Apple Music's lyrics have. Lines
 * glide, ease a touch past their place and settle, and a line already moving keeps its speed
 * when the next move starts, so quick lines flow into each other instead of restarting.
 *
 * The motion is sampled into keyframes for the Web Animations API, so the compositor runs it
 * and nothing on the main thread (the letter sweep, React) can hold it up.
 */

/** sqrt(stiffness / mass). */
export const SPRING_FREQUENCY = 10;
/** damping / (2 · mass): 18 / 2. */
export const SPRING_DECAY = 9;
/** Long enough for the spring to come to rest. */
export const SPRING_DURATION_S = 1.2;
const SAMPLES = 60;

export interface SpringState {
  /** Offset from the resting place, in px. */
  position: number;
  /** px per second. */
  velocity: number;
}

/**
 * Where an underdamped spring released at `position` with `velocity` is after `t` seconds,
 * and how fast it is moving.
 */
export function sampleSpring(position: number, velocity: number, t: number): SpringState {
  const omega = Math.sqrt(SPRING_FREQUENCY ** 2 - SPRING_DECAY ** 2);
  const decay = Math.exp(-SPRING_DECAY * t);
  const cos = Math.cos(omega * t);
  const sin = Math.sin(omega * t);
  const b = (velocity + SPRING_DECAY * position) / omega;
  return {
    position: decay * (position * cos + b * sin),
    velocity: decay * (velocity * cos - (SPRING_DECAY * b + omega * position) * sin),
  };
}

/** Keyframes moving a row from `position` (with `velocity`) to rest, on `translate`. */
export function springKeyframes(position: number, velocity: number): Keyframe[] {
  const frames: Keyframe[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const offset = i / SAMPLES;
    const y = i === SAMPLES ? 0 : sampleSpring(position, velocity, offset * SPRING_DURATION_S).position;
    frames.push({ offset, translate: `0 ${y.toFixed(2)}px` });
  }
  return frames;
}
