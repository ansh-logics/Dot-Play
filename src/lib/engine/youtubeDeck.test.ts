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
});
