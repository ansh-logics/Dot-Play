/**
 * The time lyrics are drawn at, steered toward the player's position instead of snapped to it.
 *
 * The player reports its position about every 100 ms, and each report is a little late or a
 * little early. Snapping to every report makes the letter sweep jitter; snapping only forward
 * (the old clock) still jerks. This clock runs on its own and closes the gap smoothly:
 *
 * - each reading is extrapolated to "now" at the playback rate;
 * - small differences are eased away (time constant ~600 ms) without ever running more than
 *   25% fast or 50% slow, so the sweep never visibly races or goes backwards;
 * - a medium jump (300 ms – 3 s, e.g. a buffering stall) glides over 260 ms;
 * - a big jump or a seek backwards lands at once;
 * - a single reading far off the prediction is held until the next one agrees, so one bad
 *   poll can't yank the lyrics around.
 *
 * Times are seconds; `at` values are milliseconds from `performance.now()` (passed in, so the
 * clock is testable).
 */

const EASE_TIME_CONSTANT_S = 0.6;
const MAX_SPEED = 1.25;
const MIN_SPEED = 0.5;
const GLIDE_FROM_S = 0.3;
const JUMP_FROM_S = 3;
const GLIDE_MS = 260;
/** A reading this far from the prediction waits for a second one before it is believed. */
const OUTLIER_S = 0.25;
/** Going back further than this is a seek, not drift. */
const SEEK_BACK_S = 0.35;

interface Reading {
  position: number;
  at: number;
}

export interface LyricClock {
  /** A position report from the player. */
  update(position: number, playing: boolean, rate: number, at: number): void;
  /** The time to draw at, at `at`. */
  now(at: number): number;
}

const smoothstep = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export function createLyricClock(initial = 0, startAt = 0): LyricClock {
  let reading: Reading = { position: initial, at: startAt };
  let playing = false;
  let rate = 1;
  /** A reading that disagreed with the prediction and is waiting to be confirmed. */
  let suspect: Reading | null = null;

  let display = initial;
  let displayAt = startAt;
  let glide: { from: number; start: number } | null = null;

  const target = (at: number) => (playing ? reading.position + ((at - reading.at) / 1000) * rate : reading.position);

  const land = (at: number) => {
    display = target(at);
    displayAt = at;
    glide = null;
  };

  const accept = (next: Reading, at: number) => {
    reading = next;
    suspect = null;
    const error = target(at) - display;
    if (error < -SEEK_BACK_S || Math.abs(error) >= JUMP_FROM_S) land(at);
    else if (error >= GLIDE_FROM_S) glide = { from: display, start: at };
  };

  const now = (at: number): number => {
    const goal = target(at);
    if (glide) {
      const p = (at - glide.start) / GLIDE_MS;
      if (p >= 1) {
        land(at);
      } else {
        display = glide.from + (goal - glide.from) * smoothstep(p);
        displayAt = at;
      }
      return display;
    }
    const dt = Math.max(0, (at - displayAt) / 1000);
    displayAt = at;
    // Paused: hold still (a paused seek lands through update()).
    if (!playing || dt === 0) return display;
    // Exponential approach to the moving goal: never overshoots, however long the frame.
    const error = goal - (display + dt * rate);
    const eased = goal - error * Math.exp(-dt / EASE_TIME_CONSTANT_S);
    display += Math.min(dt * rate * MAX_SPEED, Math.max(dt * rate * MIN_SPEED, eased - display));
    return display;
  };

  return {
    now,
    update(position, isPlaying, nextRate, at) {
      if (!Number.isFinite(position)) return;
      // Bring the drawn time up to this moment under the old rules before changing them.
      now(at);
      const wasPlaying = playing;
      playing = isPlaying;
      rate = nextRate > 0 && Number.isFinite(nextRate) ? nextRate : 1;
      const next = { position, at };

      // Paused or just started/stopped: there is nothing to extrapolate, so believe it.
      if (!isPlaying || !wasPlaying) {
        reading = next;
        suspect = null;
        const error = position - display;
        if (!isPlaying) {
          // Pausing freezes on the last poll, which is usually a hair behind the drawn time;
          // stepping back would flick the sweep. Only a real move (a seek) lands.
          if (error < -SEEK_BACK_S || error > OUTLIER_S) land(at);
        } else if (Math.abs(error) > OUTLIER_S) {
          land(at);
        }
        return;
      }

      const predicted = target(at);
      if (Math.abs(position - predicted) <= OUTLIER_S) {
        accept(next, at);
        return;
      }
      // Off the prediction: believe it only if the previous odd reading points the same way.
      if (suspect) {
        const fromSuspect = suspect.position + ((at - suspect.at) / 1000) * rate;
        if (Math.abs(position - fromSuspect) <= OUTLIER_S) {
          accept(next, at);
          return;
        }
      }
      suspect = next;
    },

  };
}
