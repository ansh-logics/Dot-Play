import type { SearchResult } from "@app/lib/search";

/**
 * The one song the whole site plays. Nothing about it is stored in the repo: the cover comes
 * from Apple's iTunes Search API and the synced lyrics from LyricsPlus/LRCLIB at page load,
 * the same public sources music apps use. Change these three lines to feature another song.
 */
export const SONG = {
  title: "Blinding Lights",
  artist: "The Weeknd",
  /** Seconds. */
  duration: 200,
};

/** A stable fake video ID, so the app's caches key the song consistently. */
export const SONG_ID = "site-blinding-lights";

const CACHE_KEY = "dm-site-song-cover";

/** Square cover art (1000px) from iTunes, cached for the session. */
export async function loadCover(): Promise<string> {
  try {
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached) return cached;
  } catch {
    // ignore
  }
  const url = `https://itunes.apple.com/search?${new URLSearchParams({
    term: `${SONG.title} ${SONG.artist}`,
    entity: "song",
    limit: "5",
    country: "us",
  })}`;
  const res = await fetch(url);
  const data = (await res.json()) as {
    results: Array<{ trackName: string; artistName: string; artworkUrl100: string }>;
  };
  const exact =
    data.results.find((r) => r.trackName === SONG.title && r.artistName === SONG.artist) ?? data.results[0];
  const cover = exact.artworkUrl100.replace(/\/\d+x\d+bb\.(jpg|png)$/, "/1000x1000bb.$1");
  try {
    sessionStorage.setItem(CACHE_KEY, cover);
  } catch {
    // ignore
  }
  return cover;
}

export function songTrack(cover: string): SearchResult {
  return { videoId: SONG_ID, title: SONG.title, artist: SONG.artist, thumbnailUrl: cover, itemType: "song" };
}

/**
 * Prepares the app's local caches before its modules load: no tick sounds or haptics on the
 * website, and the cover pre-registered so the app doesn't probe YouTube for artwork.
 */
export function seedAppStorage(cover: string) {
  try {
    localStorage.setItem("dot_feedback", JSON.stringify({ sound: false, haptics: false }));
    localStorage.setItem("dot_player_skin", "apple");
    localStorage.setItem("dot_highres_image_cache_v2", JSON.stringify({ [SONG_ID]: cover }));
  } catch {
    // Storage blocked: the app still works, it just probes for artwork once.
  }
}
