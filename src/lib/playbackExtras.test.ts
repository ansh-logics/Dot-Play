import { describe, expect, it } from "vitest";
import {
  formatRate,
  formatSleepRemaining,
  normalizeRate,
  SLEEP_FADE_MS,
  sleepAfter,
  sleepFadeGain,
  sleepRemainingMs,
} from "./playbackExtras";

describe("playback speed", () => {
  it("snaps to an offered speed", () => {
    expect(normalizeRate(1.3)).toBe(1.25);
    expect(normalizeRate(5)).toBe(2);
    expect(normalizeRate(0.1)).toBe(0.5);
    expect(normalizeRate("1.5")).toBe(1.5);
  });

  it("falls back to normal for junk", () => {
    expect(normalizeRate(Number.NaN)).toBe(1);
    expect(normalizeRate(-1)).toBe(1);
    expect(normalizeRate(undefined)).toBe(1);
  });

  it("formats without trailing zeros", () => {
    expect(formatRate(1)).toBe("1×");
    expect(formatRate(1.25)).toBe("1.25×");
    expect(formatRate(0.5)).toBe("0.5×");
  });
});

describe("sleep timer", () => {
  it("sets a deadline, clamped to 1 minute – 12 hours", () => {
    expect(sleepAfter(30, 1000)).toEqual({ kind: "at", deadline: 1000 + 30 * 60_000, minutes: 30 });
    expect(sleepAfter(0, 0)).toMatchObject({ minutes: 1 });
    expect(sleepAfter(10_000, 0)).toMatchObject({ minutes: 720 });
  });

  it("counts down from the deadline and never below zero", () => {
    const timer = sleepAfter(15, 0);
    expect(sleepRemainingMs(timer, 60_000)).toBe(14 * 60_000);
    expect(sleepRemainingMs(timer, 99 * 60_000)).toBe(0);
    expect(sleepRemainingMs({ kind: "endOfTrack" }, 0)).toBeNull();
    expect(sleepRemainingMs(null)).toBeNull();
  });

  it("fades only in the last ten seconds", () => {
    expect(sleepFadeGain(null)).toBe(1);
    expect(sleepFadeGain(SLEEP_FADE_MS + 1)).toBe(1);
    expect(sleepFadeGain(SLEEP_FADE_MS / 2)).toBeCloseTo(Math.SQRT1_2, 5);
    expect(sleepFadeGain(0)).toBe(0);
  });

  it("shows minutes, then minutes and seconds", () => {
    expect(formatSleepRemaining(28 * 60_000 + 1)).toBe("29 min");
    expect(formatSleepRemaining(4 * 60_000 + 5_000)).toBe("4:05");
    expect(formatSleepRemaining(8_200)).toBe("0:09");
  });
});
