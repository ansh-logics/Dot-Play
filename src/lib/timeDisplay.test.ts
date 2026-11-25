import { describe, expect, it } from "vitest";
import { formatRemaining } from "./timeDisplay";

describe("time display", () => {
  it("shows the time left with a minus", () => {
    expect(formatRemaining(200, 80)).toBe("-2:00");
    expect(formatRemaining(65, 5)).toBe("-1:00");
    expect(formatRemaining(200, 199.5)).toBe("-0:00");
  });

  it("never counts below zero once the song has run past its length", () => {
    expect(formatRemaining(100, 140)).toBe("-0:00");
  });

  it("treats an unknown length as zero", () => {
    expect(formatRemaining(0, 0)).toBe("-0:00");
    expect(formatRemaining(0, 30)).toBe("-0:00");
    expect(formatRemaining(Number.NaN, 30)).toBe("-0:00");
  });
});
