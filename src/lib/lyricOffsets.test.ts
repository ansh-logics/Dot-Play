import { describe, expect, it } from "vitest";
import { clampOffset, formatOffset, readOffsets, withOffset } from "./lyricOffsets";

describe("lyric offsets", () => {
  it("rounds to tenths and stays within ±5 s", () => {
    expect(clampOffset(0.1 + 0.2)).toBe(0.3);
    expect(clampOffset(9)).toBe(5);
    expect(clampOffset(-9)).toBe(-5);
    expect(clampOffset(Number.NaN)).toBe(0);
  });

  it("removes a song when its offset returns to zero", () => {
    expect(withOffset({ a: 0.5 }, "a", 0)).toEqual({});
  });

  it("keeps only the newest 500 songs", () => {
    let map: Record<string, number> = {};
    for (let i = 0; i < 510; i++) map = withOffset(map, `song${i}`, 0.1);
    const keys = Object.keys(map);
    expect(keys).toHaveLength(500);
    expect(keys[0]).toBe("song10");
    expect(keys[499]).toBe("song509");
  });

  it("ignores junk in storage", () => {
    const storage = { getItem: () => JSON.stringify({ a: 0.4, b: "x", c: 0, d: 99 }) };
    expect(readOffsets(storage)).toEqual({ a: 0.4, d: 5 });
    expect(readOffsets({ getItem: () => "not json" })).toEqual({});
  });

  it("formats with a sign", () => {
    expect(formatOffset(0.3)).toBe("+0.3 s");
    expect(formatOffset(-1.26)).toBe("−1.3 s");
    expect(formatOffset(0)).toBe("0.0 s");
  });
});
