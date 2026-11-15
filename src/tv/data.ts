import { invoke } from "@tauri-apps/api/core"

/** A song as the TV shows and plays it. */
export interface Track {
  videoId: string
  title: string
  artist: string
  thumb: string
}

/** Something on a shelf: a song to play, or a playlist or album to open. */
export interface ShelfItem extends Track {
  playlistId?: string
}

export interface Shelf {
  title: string
  items: ShelfItem[]
}

export interface Playlist {
  id: string
  title: string
  subtitle: string
  thumb: string
  tracks: Array<Track & { duration: string }>
}

/** Mirrors `SearchResult`, `HomeFeedResponse` and `PlaylistDetails` in models.rs. */
interface RawItem {
  videoId: string
  title: string
  artist: string
  thumbnailUrl: string
  playlistId?: string
  itemType?: string
}
interface RawFeed {
  sections: Array<{ title: string; items: RawItem[] }>
}
interface RawPlaylist {
  id: string
  title: string
  author: string
  artist?: string
  kind?: string
  year?: string
  thumbnailUrl: string
  trackCount: string
  tracks: Array<{ videoId: string; title: string; artist: string; duration: string; thumbnailUrl: string }>
}

/** A TV with 1 GB of memory: a shelf shows this many, and the screen this many shelves. */
const MAX_PER_SHELF = 14
const MAX_SHELVES = 9

function shelves(feed: RawFeed): Shelf[] {
  return feed.sections
    .map((section) => ({
      title: section.title,
      items: section.items
        .filter((item) => item.playlistId || item.videoId)
        .slice(0, MAX_PER_SHELF)
        .map((item) => ({
          videoId: item.videoId,
          title: item.title,
          artist: item.artist,
          thumb: item.thumbnailUrl,
          // A song can carry the id of the album it is on; only playlists and albums open.
          playlistId: item.itemType === "playlist" || !item.videoId ? item.playlistId : undefined,
        })),
    }))
    .filter((shelf) => shelf.items.length > 0)
}

/** Your playlists first (when signed in), then what YouTube Music suggests. */
export async function loadShelves(signedIn: boolean): Promise<Shelf[]> {
  const [library, home] = await Promise.allSettled([
    signedIn ? invoke<RawFeed>("get_library_playlists") : Promise.resolve<RawFeed>({ sections: [] }),
    invoke<RawFeed>("get_home_feed"),
  ])
  if (library.status === "rejected" && home.status === "rejected") throw new Error(String(home.reason))
  const mine = library.status === "fulfilled" ? shelves(library.value) : []
  const suggested = home.status === "fulfilled" ? shelves(home.value) : []
  return [...mine.map((shelf) => ({ ...shelf, title: shelf.title || "Your playlists" })), ...suggested].slice(0, MAX_SHELVES)
}

export async function loadPlaylist(playlistId: string): Promise<Playlist> {
  const raw = await invoke<RawPlaylist>("get_playlist_details", { playlistId })
  const subtitle = [raw.kind, raw.artist || raw.author, raw.year, raw.trackCount].filter(Boolean).join(" · ")
  return {
    id: raw.id,
    title: raw.title,
    subtitle,
    thumb: raw.thumbnailUrl,
    tracks: raw.tracks
      .filter((track) => track.videoId)
      .map((track) => ({
        videoId: track.videoId,
        title: track.title,
        artist: track.artist,
        thumb: track.thumbnailUrl || raw.thumbnailUrl,
        duration: track.duration,
      })),
  }
}

/** Counts a play in the account's YouTube Music history (best effort). */
export const recordPlay = (videoId: string, duration: number, elapsed: number) =>
  void invoke("record_playback", { videoId, duration, elapsed }).catch(() => {})
