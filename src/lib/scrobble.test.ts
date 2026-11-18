import { describe, expect, it } from "vitest";
import { buildListen, createListenTracker, scrobbleThreshold } from "./scrobble";

describe("scrobbleThreshold", () => {
  it("is half the song, at most 4 minutes", () => {
    expect(scrobbleThreshold(200)).toBe(100);
    expect(scrobbleThreshold(600)).toBe(240);
  });

  it("never counts songs of 30 seconds or less", () => {
    expect(scrobbleThreshold(30)).toBeNull();
    expect(scrobbleThreshold(12)).toBeNull();
  });

  it("waits 4 minutes while the length is unknown", () => {
    expect(scrobbleThreshold(0)).toBe(240);
  });
});

describe("createListenTracker", () => {
  /** Feeds readings every 0.1 s of song from `from` to `to`. */
  const play = (tracker: ReturnType<typeof createListenTracker>, from: number, to: number, playing = true) => {
    for (let t = from; t <= to + 1e-9; t += 0.1) tracker.update(Number(t.toFixed(1)), playing);
  };

  it("counts music heard", () => {
    const tracker = createListenTracker();
    play(tracker, 0, 30);
    expect(tracker.heard).toBeCloseTo(30, 5);
  });

  it("doesn't count music skipped by seeking forward", () => {
    const tracker = createListenTracker();
    play(tracker, 0, 10);
    play(tracker, 100, 110); // jumped from 10 to 100
    expect(tracker.heard).toBeCloseTo(20, 5);
  });

  it("doesn't count readings while paused", () => {
    const tracker = createListenTracker();
    play(tracker, 0, 10);
    play(tracker, 10, 20, false);
    expect(tracker.heard).toBeCloseTo(10, 5);
  });

  it("notices the song starting over", () => {
    const tracker = createListenTracker();
    play(tracker, 0, 60);
    expect(tracker.update(0.2, true)).toBe(true);
    expect(tracker.heard).toBe(0);
  });
});

describe("buildListen", () => {
  it("cleans the title and artist and stamps the start", () => {
    const listen = buildListen({ videoId: "abc", title: "Song (Official Video)", artist: "Artist - Topic" }, 199.6, 1_700_000_000.4);
    expect(listen).toEqual({ artist: "Artist", track: "Song", duration: 200, startedAt: 1_700_000_000, videoId: "abc" });
  });
});
