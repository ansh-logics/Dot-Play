import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUEUE_SESSION,
  MAX_PLAYBACK_HISTORY,
  addToUpcoming,
  advanceOnTrackEnd,
  appendTracksToUpcoming,
  playNextUpcoming,
  playTrackImmediate,
  pushToHistory,
  removeUpcoming,
  reorderUpcoming,
  sanitizeSession,
  shuffleUpcoming,
  type QueueSession,
} from "./queueManager";
import type { SearchResult } from "./search";

const song = (id: string, extra: Partial<SearchResult> = {}): SearchResult => ({
  videoId: id,
  title: `Song ${id}`,
  artist: "Artist",
  thumbnailUrl: "",
  ...extra,
});

const session = (fields: Partial<QueueSession>): QueueSession => ({ ...DEFAULT_QUEUE_SESSION, ...fields });
const ids = (tracks: SearchResult[]) => tracks.map((t) => t.videoId);

describe("history", () => {
  it(`keeps only the last ${MAX_PLAYBACK_HISTORY} songs`, () => {
    let history: SearchResult[] = [];
    for (let i = 0; i < MAX_PLAYBACK_HISTORY + 5; i++) history = pushToHistory(history, song(`s${i}`));
    expect(history).toHaveLength(MAX_PLAYBACK_HISTORY);
    expect(history[0].videoId).toBe("s5");
  });

  it("ignores songs without an id", () => {
    expect(pushToHistory([], song(""))).toEqual([]);
  });
});

describe("Up Next", () => {
  it("adds to the end once, marked as queued by the listener", () => {
    const first = addToUpcoming(session({ upcoming: [song("a")] }), song("b"));
    expect(first.added).toBe(true);
    expect(ids(first.session.upcoming)).toEqual(["a", "b"]);
    expect(first.session.upcoming[1].queueSource).toBe("user");
    expect(addToUpcoming(first.session, song("b")).added).toBe(false);
  });

  it("Play Next goes first, or plays at once when nothing is playing", () => {
    const playing = playNextUpcoming(session({ currentTrack: song("x"), upcoming: [song("a")] }), song("b"));
    expect(ids(playing.session.upcoming)).toEqual(["b", "a"]);
    const idle = playNextUpcoming(session({}), song("b"));
    expect(idle.playedImmediate).toBe(true);
    expect(idle.session.currentTrack?.videoId).toBe("b");
  });

  it("appends a playlist without duplicates", () => {
    const next = appendTracksToUpcoming(session({ upcoming: [song("a")] }), [song("a"), song("b"), song("b"), song("c")]);
    expect(ids(next.upcoming)).toEqual(["a", "b", "c"]);
  });

  it("reorders and removes by index, ignoring bad indexes", () => {
    const base = session({ upcoming: [song("a"), song("b"), song("c")] });
    expect(ids(reorderUpcoming(base, 2, 0).upcoming)).toEqual(["c", "a", "b"]);
    expect(reorderUpcoming(base, 5, 0)).toBe(base);
    expect(ids(removeUpcoming(base, 1).upcoming)).toEqual(["a", "c"]);
    expect(removeUpcoming(base, -1)).toBe(base);
  });
});

describe("playing a song", () => {
  it("moves the current song to history and takes the playlist after the chosen one", () => {
    const playlist = [song("a"), song("b"), song("c"), song("d")];
    const next = playTrackImmediate(session({ currentTrack: song("x") }), song("b"), { contextUpcoming: playlist });
    expect(next.currentTrack?.videoId).toBe("b");
    expect(ids(next.upcoming)).toEqual(["c", "d"]);
    expect(ids(next.history)).toEqual(["x"]);
  });

  it("keeps only songs the listener queued when playing something new directly", () => {
    const before = session({
      currentTrack: song("x"),
      upcoming: [song("auto1"), song("mine", { queueSource: "user" }), song("auto2")],
    });
    const next = playTrackImmediate(before, song("new"), { keepUserQueuedOnly: true });
    expect(ids(next.upcoming)).toEqual(["mine"]);
  });
});

describe("when a song ends", () => {
  it("plays the next one", () => {
    const result = advanceOnTrackEnd(session({ currentTrack: song("a"), upcoming: [song("b"), song("c")] }));
    expect(result.nextTrack?.videoId).toBe("b");
    expect(ids(result.session.upcoming)).toEqual(["c"]);
    expect(result.needsAutoplay).toBe(false);
  });

  it("asks for autoplay when the queue is empty", () => {
    const result = advanceOnTrackEnd(session({ currentTrack: song("a") }));
    expect(result.nextTrack).toBeNull();
    expect(result.needsAutoplay).toBe(true);
  });

  it("repeat-all sends the finished song to the end", () => {
    const result = advanceOnTrackEnd(session({ currentTrack: song("a"), upcoming: [song("b")] }), { repeat: "all" });
    expect(result.nextTrack?.videoId).toBe("b");
    expect(ids(result.session.upcoming)).toEqual(["a"]);
  });
});

describe("restoring a saved queue", () => {
  it("drops broken entries and duplicates", () => {
    const restored = sanitizeSession({
      history: [song("h"), { nope: true }],
      currentTrack: { videoId: "" },
      upcoming: [song("a"), song("a"), null, song("b")],
      currentTime: -4,
    });
    expect(ids(restored.history)).toEqual(["h"]);
    expect(restored.currentTrack).toBeNull();
    expect(ids(restored.upcoming)).toEqual(["a", "b"]);
    expect(restored.currentTime).toBe(0);
  });

  it("falls back to an empty queue for garbage", () => {
    expect(sanitizeSession("garbage")).toEqual(DEFAULT_QUEUE_SESSION);
  });
});

describe("shuffle", () => {
  it("leaves the songs before `from` in place and keeps every song", () => {
    const upcoming = ["u1", "u2", "a", "b", "c", "d", "e", "f"].map((id) => song(id));
    for (let run = 0; run < 20; run++) {
      const { session: next, originalOrder } = shuffleUpcoming(session({ upcoming }), 2);
      expect(ids(next.upcoming).slice(0, 2)).toEqual(["u1", "u2"]);
      expect([...ids(next.upcoming)].sort()).toEqual([...ids(upcoming)].sort());
      expect(originalOrder).toBe(upcoming);
    }
  });
});
