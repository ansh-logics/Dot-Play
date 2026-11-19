import { describe, expect, it } from "vitest";
import { accentFromPalette, contrastWithWhite, parseHsl } from "./artworkAccent";

describe("artwork accent", () => {
  it("reads the palette's colour format", () => {
    expect(parseHsl("hsl(210 45% 30%)")).toEqual([210, 0.45, 0.3]);
    expect(parseHsl("not a colour")).toBeNull();
  });

  it("picks the most colourful palette colour", () => {
    const accent = accentFromPalette({ colors: ["hsl(30 28% 25%)", "hsl(220 70% 30%)", "hsl(0 30% 20%)", "hsl(90 40% 22%)"] });
    expect(accent?.accent).toMatch(/^hsl\(220 /);
    expect(accent?.subtle).toMatch(/\/ 0\.16\)$/);
  });

  it("keeps DOT red for grey covers", () => {
    expect(accentFromPalette({ colors: ["hsl(0 28% 20%)", "hsl(200 28% 30%)", "hsl(40 30% 25%)", "hsl(0 28% 22%)"] })).toBeNull();
  });

  it("darkens light hues until white text on them is readable", () => {
    const yellow = accentFromPalette({ colors: ["hsl(55 80% 40%)", "hsl(55 80% 40%)", "hsl(55 80% 40%)", "hsl(55 80% 40%)"] })!;
    const parsed = parseHsl(yellow.accent)!;
    expect(contrastWithWhite(parsed)).toBeGreaterThanOrEqual(2.95);
    expect(parsed[2]).toBeLessThan(0.55);
  });

  it("measures contrast like WCAG", () => {
    expect(contrastWithWhite([0, 0, 0])).toBeCloseTo(21, 0);
    expect(contrastWithWhite([0, 0, 1])).toBeCloseTo(1, 5);
  });
});
