import { describe, expect, it } from "vitest";
import { sampleSpring, SPRING_DURATION_S, springKeyframes } from "./lyricSpring";

describe("lyric spring", () => {
  it("starts where it was released, at the speed it had", () => {
    const at0 = sampleSpring(100, -50, 0);
    expect(at0.position).toBeCloseTo(100, 6);
    expect(at0.velocity).toBeCloseTo(-50, 6);
  });

  it("comes to rest within its duration", () => {
    const end = sampleSpring(120, 0, SPRING_DURATION_S);
    expect(Math.abs(end.position)).toBeLessThan(0.1);
  });

  it("eases only a touch past its place (barely bouncy)", () => {
    let lowest = 0;
    for (let t = 0; t <= SPRING_DURATION_S; t += 0.005) lowest = Math.min(lowest, sampleSpring(100, 0, t).position);
    expect(lowest).toBeLessThan(0);
    expect(lowest).toBeGreaterThan(-3);
  });

  it("reports velocity that matches its motion", () => {
    const t = 0.1;
    const dt = 1e-5;
    const numeric = (sampleSpring(80, 30, t + dt).position - sampleSpring(80, 30, t).position) / dt;
    expect(sampleSpring(80, 30, t).velocity).toBeCloseTo(numeric, 1);
  });

  it("turns the motion into translate keyframes ending at rest", () => {
    const frames = springKeyframes(64, 0);
    expect(frames[0]).toEqual({ offset: 0, translate: "0 64.00px" });
    expect(frames[frames.length - 1]).toEqual({ offset: 1, translate: "0 0.00px" });
  });
});
