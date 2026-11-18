import { describe, expect, it } from "vitest";
import { createLyricClock } from "./lyricClock";

/** Plays for `ms`, drawing every 16 ms and reporting every 100 ms; `reading(t)` is the player. */
function run(
  clock: ReturnType<typeof createLyricClock>,
  from: number,
  ms: number,
  reading: (at: number) => number,
  rate = 1,
) {
  const drawn: Array<{ at: number; t: number }> = [];
  for (let at = from; at <= from + ms; at += 16) {
    if (Math.round(at - from) % 96 === 0) clock.update(reading(at), true, rate, at);
    drawn.push({ at, t: clock.now(at) });
  }
  return drawn;
}

describe("createLyricClock", () => {
  it("follows steady playback closely", () => {
    const clock = createLyricClock(0, 0);
    clock.update(0, true, 1, 0);
    const drawn = run(clock, 0, 3000, (at) => at / 1000);
    const last = drawn[drawn.length - 1];
    expect(Math.abs(last.t - last.at / 1000)).toBeLessThan(0.02);
  });

  it("never goes backwards while readings jitter", () => {
    const clock = createLyricClock(0, 0);
    clock.update(0, true, 1, 0);
    let flip = 1;
    const drawn = run(clock, 0, 4000, (at) => at / 1000 + (flip = -flip) * 0.08);
    for (let i = 1; i < drawn.length; i++) expect(drawn[i].t).toBeGreaterThanOrEqual(drawn[i - 1].t);
  });

  it("eases a small lag away instead of jumping", () => {
    const clock = createLyricClock(0, 0);
    clock.update(0, true, 1, 0);
    run(clock, 0, 1000, (at) => at / 1000);
    // The player turns out to be 0.2 s further on.
    const drawn = run(clock, 1016, 2000, (at) => at / 1000 + 0.2);
    for (let i = 1; i < drawn.length; i++) {
      const speed = (drawn[i].t - drawn[i - 1].t) / ((drawn[i].at - drawn[i - 1].at) / 1000);
      expect(speed).toBeLessThanOrEqual(1.25 + 1e-9);
    }
    const last = drawn[drawn.length - 1];
    expect(Math.abs(last.t - (last.at / 1000 + 0.2))).toBeLessThan(0.03);
  });

  it("lands at once on a seek backwards, after a second reading confirms it", () => {
    const clock = createLyricClock(0, 0);
    clock.update(0, true, 1, 0);
    run(clock, 0, 2000, (at) => at / 1000);
    clock.update(0.5, true, 1, 2100);
    expect(clock.now(2100)).toBeGreaterThan(2); // one odd reading is held
    clock.update(0.6, true, 1, 2200);
    expect(clock.now(2200)).toBeCloseTo(0.6, 2);
  });

  it("ignores one stray reading", () => {
    const clock = createLyricClock(0, 0);
    clock.update(0, true, 1, 0);
    run(clock, 0, 1000, (at) => at / 1000);
    clock.update(5, true, 1, 1100);
    clock.update(1.2, true, 1, 1200);
    expect(clock.now(1200)).toBeCloseTo(1.2, 1);
  });

  it("glides over a medium jump", () => {
    const clock = createLyricClock(0, 0);
    clock.update(0, true, 1, 0);
    run(clock, 0, 1000, (at) => at / 1000);
    // Buffering stall recovered 1 s ahead (confirmed by two readings).
    clock.update(2.1, true, 1, 1100);
    clock.update(2.2, true, 1, 1200);
    const mid = clock.now(1330);
    expect(mid).toBeGreaterThan(1.3);
    expect(mid).toBeLessThan(2.3);
    expect(clock.now(1500)).toBeCloseTo(2.5, 2);
  });

  it("holds still when paused, and lands on a seek while paused", () => {
    const clock = createLyricClock(10, 0);
    clock.update(10, false, 1, 0);
    expect(clock.now(5000)).toBe(10);
    clock.update(9.9, false, 1, 5000); // a hair behind: no flick back
    expect(clock.now(5000)).toBe(10);
    clock.update(42, false, 1, 6000);
    expect(clock.now(6000)).toBe(42);
  });

  it("runs at the playback rate", () => {
    const clock = createLyricClock(0, 0);
    clock.update(0, true, 1.5, 0);
    const drawn = run(clock, 0, 2000, (at) => (at / 1000) * 1.5, 1.5);
    const last = drawn[drawn.length - 1];
    expect(Math.abs(last.t - 3)).toBeLessThan(0.03);
  });
});
