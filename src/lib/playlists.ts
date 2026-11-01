import { invoke } from "@tauri-apps/api/core"

/** One of the user's playlists in the "Save to playlist" picker. Mirrors `PlaylistOption` in library.rs. */
export interface PlaylistOption {
  playlistId: string
  title: string
  /** Whether the song is already in it. */
  contains: boolean
  privacy: "PUBLIC" | "UNLISTED" | "PRIVATE" | null
}

/** The user's own playlists, each marked with whether it already holds the song. */
export const getPlaylistsForSong = (videoId: string) =>
  invoke<PlaylistOption[]>("get_playlists_for_song", { videoId })

/** Adds the song to the playlist, or takes it out (`add: false`). */
export const setSongInPlaylist = (playlistId: string, videoId: string, add: boolean) =>
  invoke<void>("set_song_in_playlist", { playlistId, videoId, add })

export type PlaylistPrivacy = NonNullable<PlaylistOption["privacy"]>

/** Creates a playlist (optionally with songs in it) and returns its ID. */
export const createPlaylist = (title: string, privacy: PlaylistPrivacy, videoIds: string[] = []) =>
  invoke<string>("create_playlist", { title, privacy, videoIds })
