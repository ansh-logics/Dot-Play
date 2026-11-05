import { describe, expect, it } from "vitest";
import { buildLocalPlaylist, isLocalPlaylistId, toCard, toPlaylistDetails, type ExternalPlaylist, type TrackMatch } from "./imports";

const source: ExternalPlaylist = {
  source: "spotify",
  sourceUrl: "https://open.spotify.com/playlist/x",
  kind: "Playlist",
  title: "Road Trip",
  description: "",
  owner: "Ansh",
  coverUrl: "https://i.scdn.co/cover",
  tracks: [
    { title: "Found", artist: "A", durationMs: 185_000, coverUrl: "https://i.scdn.co/a" },
    { title: "Missing", artist: "B", durationMs: 3_725_000 },
  ],
};

const match: TrackMatch = {
  videoId: "abcdefghijk",
  title: "Found (Official)",
  artist: "A",
  thumbnailUrl: "https://lh3.googleusercontent.com/t",
  duration: "3:05",
  confidence: 0.9,
};

describe("imported playlists", () => {
  const local = { ...buildLocalPlaylist(source, [match, null]), id: "local:abc" };

  it("keeps the source's details and each song's match", () => {
    expect(local.title).toBe("Road Trip");
    expect(local.cover).toBe("https://i.scdn.co/cover");
    expect(local.tracks.map((t) => t.match?.videoId ?? null)).toEqual(["abcdefghijk", null]);
  });

  it("shows on the playlist page with the original names, missing songs marked", () => {
    const details = toPlaylistDetails(local);
    expect(details.tracks.map((t) => [t.title, t.videoId, Boolean(t.missing)])).toEqual([
      ["Found", "abcdefghijk", false],
      ["Missing", "", true],
    ]);
    expect(details.tracks.map((t) => t.duration)).toEqual(["3:05", "1:02:05"]);
    expect(details.trackCount).toBe("1 of 2 songs found");
    expect(details.source).toBe("spotify");
  });

  it("appears in the Library as a playlist card", () => {
    const card = toCard(local);
    expect(card.playlistId).toBe("local:abc");
    expect(card.itemType).toBe("playlist");
    expect(card.artist).toBe("From Spotify · 2 songs");
  });

  it("recognises local ids", () => {
    expect(isLocalPlaylistId("local:abc")).toBe(true);
    expect(isLocalPlaylistId("PL123")).toBe(false);
  });

  it("names an untitled import", () => {
    expect(buildLocalPlaylist({ ...source, title: "" }, []).title).toBe("Imported Playlist");
  });
});
