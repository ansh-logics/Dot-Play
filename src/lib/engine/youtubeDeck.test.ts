import { describe, expect, it, vi } from "vitest";
import type { YouTubePlayerInstance } from "../../components/HiddenYouTubePlayer";
import { youtubeDeck, youtubeError } from "./youtubeDeck";

function fakePlayer() {
  return {
    destroy: vi.fn(),
    getCurrentTime: () => 42,
    getDuration: () => 200,
    pauseVideo: vi.fn(),
    playVideo: vi.fn(),
    seekTo: vi.fn(),
    nextVideo: vi.fn(),
    previousVideo: vi.fn(),
    getVideoData: () => ({}),
    loadVideoById: vi.fn(),
    cueVideoById: vi.fn(),
    mute: vi.fn(),
    unMute: vi.fn(),
    setVolume: vi.fn(),
    setPlaybackRate: vi.fn(),
  } satisfies YouTubePlayerInstance;
}

describe("youtubeDeck", () => {
  it("loads to play, or cues to wait", () => {
    const player = fakePlayer();
    const deck = youtubeDeck(player);
    deck.load({ videoId: "abc" }, { autoplay: true });
    expect(player.loadVideoById).toHaveBeenCalledWith({ videoId: "abc", startSeconds: 0 });
    expect(player.playVideo).toHaveBeenCalled();
    deck.load({ videoId: "def" }, { startSeconds: 30, autoplay: false });
    expect(player.cueVideoById).toHaveBeenCalledWith({ videoId: "def", startSeconds: 30 });
  });

  it("passes the controls through", () => {
    const player = fakePlayer();
    const deck = youtubeDeck(player);
    deck.seek(12);
    deck.setMuted(true);
    deck.setMuted(false);
    deck.setVolume(55);
    deck.setRate(1.25);
    expect(player.seekTo).toHaveBeenCalledWith(12, true);
    expect(player.mute).toHaveBeenCalledOnce();
    expect(player.unMute).toHaveBeenCalledOnce();
    expect(player.setVolume).toHaveBeenCalledWith(55);
    expect(player.setPlaybackRate).toHaveBeenCalledWith(1.25);
    expect(deck.position()).toBe(42);
    expect(deck.duration()).toBe(200);
  });

  it("is the same deck for the same player", () => {
    const player = fakePlayer();
    expect(youtubeDeck(player)).toBe(youtubeDeck(player));
    expect(youtubeDeck(player)).not.toBe(youtubeDeck(fakePlayer()));
  });

  it("says which errors mean the song can never play here", () => {
    expect(youtubeError(150)).toEqual({ message: "Embedded playback blocked by track owner.", unplayable: true });
    expect(youtubeError(5).unplayable).toBe(false);
    expect(youtubeError(999).message).toBe("Playback failed with error code 999.");
  });

  it("reports the numbers the player gives it", () => {
    const player: YouTubePlayerInstance = {
      ...fakePlayer(),
      getVideoData: () => ({ video_id: "abc" }),
      getVideoLoadedFraction: () => 0.42,
      getPlaybackQuality: () => "hd720",
      getPlaybackRate: () => 1.25,
    };
    expect(youtubeDeck(player).stats!()).toEqual({
      source: "youtube",
      videoId: "abc",
      loadedFraction: 0.42,
      quality: "hd720",
      rate: 1.25,
      bufferingEvents: 0,
    });
  });

  it("falls back to the speed it was set to, then to normal speed", () => {
    const player: YouTubePlayerInstance = {
      ...fakePlayer(),
      getPlaybackRate: () => {
        throw new Error("not ready");
      },
    };
    const deck = youtubeDeck(player);
    expect(deck.stats!().rate).toBe(1);
    deck.setRate(1.5);
    expect(deck.stats!().rate).toBe(1.5);
  });

  it("leaves out what the player doesn't report", () => {
    const player: YouTubePlayerInstance = {
      ...fakePlayer(),
      getVideoData: () => {
        throw new Error("not ready");
      },
      getVideoLoadedFraction: () => Number.NaN,
      getPlaybackQuality: () => "unknown",
    };
    expect(youtubeDeck(player).stats!()).toMatchObject({
      videoId: null,
      loadedFraction: null,
      quality: null,
    });
  });

  it("counts stalls after the song started playing, and starts over on the next", () => {
    let onStateChange: ((event: { data: number }) => void) | undefined;
    const player: YouTubePlayerInstance = {
      ...fakePlayer(),
      addEventListener: (_eventName, listener) => {
        onStateChange = listener;
      },
    };
    const deck = youtubeDeck(player);
    // The first load's buffering isn't a stall.
    onStateChange?.({ data: 3 });
    expect(deck.stats!().bufferingEvents).toBe(0);
    onStateChange?.({ data: 1 });
    // One spell, however many buffering reports it takes, then another.
    onStateChange?.({ data: 3 });
    onStateChange?.({ data: 3 });
    onStateChange?.({ data: 1 });
    onStateChange?.({ data: 3 });
    expect(deck.stats!().bufferingEvents).toBe(2);

    deck.load({ videoId: "next" }, { autoplay: true });
    expect(deck.stats!().bufferingEvents).toBe(0);
    onStateChange?.({ data: 3 });
    expect(deck.stats!().bufferingEvents).toBe(0);
  });
});
