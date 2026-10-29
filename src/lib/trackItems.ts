import type { SearchResult } from "./search";

/** True when the item is the playing song, or the playlist it came from. */
export function isActiveItem(
  item: SearchResult,
  currentVideoId: string | undefined,
  currentPlaylistId: string | undefined,
): boolean {
  return Boolean(
    (currentVideoId && currentVideoId === item.videoId) ||
      (currentPlaylistId && currentPlaylistId === item.playlistId),
  );
}

/** Items that can be queued (playlists and other links have no videoId). */
export const playableOnly = (items: SearchResult[]) => items.filter((i) => Boolean(i.videoId));
