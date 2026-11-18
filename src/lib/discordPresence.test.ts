import { describe, expect, it } from "vitest";
import { buildDiscordActivity } from "./discordPresence";

const track = {
  videoId: "abc_123",
  title: "Song (Official Video)",
  artist: "Artist",
  thumbnailUrl: "https://i.ytimg.com/vi/abc_123/hqdefault.jpg",
};

describe("buildDiscordActivity", () => {
  it("places the start and end on the wall clock", () => {
    const a = buildDiscordActivity(track, 30, 200, 1, 1_000_000);
    expect(a.startMs).toBe(970_000);
    expect(a.endMs).toBe(1_170_000);
    expect(a.url).toBe("https://music.youtube.com/watch?v=abc_123");
  });

  it("shortens the song in real time at a faster speed", () => {
    const a = buildDiscordActivity(track, 30, 200, 2, 1_000_000);
    expect(a.startMs).toBe(985_000);
    expect(a.endMs).toBe(1_085_000);
  });

  it("leaves out the end while the length is unknown, and non-https artwork", () => {
    const a = buildDiscordActivity({ ...track, thumbnailUrl: "data:image/png;base64,xyz" }, 0, 0, 1, 5000);
    expect(a.endMs).toBeNull();
    expect(a.artworkUrl).toBeNull();
  });
});
