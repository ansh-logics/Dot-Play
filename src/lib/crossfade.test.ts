import { describe, expect, it } from "vitest";
import { crossfadeStep, crossfadeVolumes, fadeProgress, fadeSpan, normalizeCrossfade, secondsLeft } from "./crossfade";

describe("crossfade", () => {
  it("crosses volumes on an equal-power curve", () => {
    expect(crossfadeVolumes(0, 80)).toEqual({ outgoing: 80, incoming: 0 });
    expect(crossfadeVolumes(1, 80)).toEqual({ outgoing: 0, incoming: 80 });
    // Halfway, each is at about 71%, not 50%: the sum of their power stays the same.
    expect(crossfadeVolumes(0.5, 100)).toEqual({ outgoing: 71, incoming: 71 });
    expect(crossfadeVolumes(2, 50)).toEqual({ outgoing: 0, incoming: 50 });
  });

  it("counts real seconds left at the playback speed", () => {
    expect(secondsLeft(170, 200, 1)).toBe(30);
    expect(secondsLeft(170, 200, 2)).toBe(15);
    expect(secondsLeft(10, 0, 1)).toBe(Infinity);
  });

  it("prepares the next song ahead, then fades", () => {
    const at = (position: number) => crossfadeStep({ fade: 6, position, duration: 200, rate: 1 });
    expect(at(100)).toBe("wait");
    expect(at(180)).toBe("prepare");
    expect(at(194)).toBe("fade");
  });

  it("stays off when the setting is off or the song is short", () => {
    expect(crossfadeStep({ fade: 0, position: 195, duration: 200, rate: 1 })).toBe("wait");
    expect(crossfadeStep({ fade: 6, position: 20, duration: 25, rate: 1 })).toBe("wait");
    expect(crossfadeStep({ fade: 6, position: 0, duration: 0, rate: 1 })).toBe("wait");
  });

  it("only accepts offered lengths", () => {
    expect(normalizeCrossfade("6")).toBe(6);
    expect(normalizeCrossfade(7)).toBe(0);
    expect(normalizeCrossfade(null)).toBe(0);
  });

  it("follows the incoming song, not the wall clock", () => {
    // Still buffering: the blend waits, the current song stays loud.
    expect(fadeProgress({ incomingPlayed: 0, outgoingLeft: 6, span: 6 })).toBe(0);
    expect(fadeProgress({ incomingPlayed: 3, outgoingLeft: 5, span: 6 })).toBe(0.5);
    // The current song is running out: pushed on so it reaches silence at its end.
    expect(fadeProgress({ incomingPlayed: 1, outgoingLeft: 1.5, span: 6 })).toBe(0.75);
    expect(fadeProgress({ incomingPlayed: 9, outgoingLeft: 0, span: 6 })).toBe(1);
  });

  it("keeps a short next song from being swallowed by the fade", () => {
    expect(fadeSpan(12, 240)).toBe(12);
    expect(fadeSpan(12, 18)).toBe(6);
    expect(fadeSpan(6, 0)).toBe(6);
  });
});
