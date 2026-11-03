import { invoke } from "@tauri-apps/api/core"
import { getPlaylistDetails, type PlaylistDetails, type PlaylistTrack, type SearchResult } from "./search"

/** Mirrors the structs in import.rs. */
export interface ExternalTrack {
  title: string
  artist: string
  album?: string
  durationMs?: number
  coverUrl?: string
}

export interface ExternalPlaylist {
  source: ImportSource
  sourceUrl: string
  kind: string
  title: string
  description: string
  owner: string
  coverUrl: string
  /** How many songs the source has, when it lists fewer. */
  total?: number
  tracks: ExternalTrack[]
}

export interface TrackMatch {
  videoId: string
  title: string
  artist: string
  thumbnailUrl: string
  duration: string
  confidence: number
}

export interface LocalTrack extends ExternalTrack {
  match: TrackMatch | null
}

export interface LocalPlaylist {
  /** "local:…"; empty until saved. */
  id: string
  source: ImportSource
  sourceUrl: string
  kind: string
  title: string
  description: string
  owner: string
  /** A data URL once saved. */
  cover: string
  importedAt: number
  total?: number
  tracks: LocalTrack[]
}

export type ImportSource = "spotify" | "apple" | "deezer" | "youtube" | "text"

export const SOURCE_NAMES: Record<ImportSource, string> = {
  spotify: "Spotify",
  apple: "Apple Music",
  deezer: "Deezer",
  youtube: "YouTube Music",
  text: "a song list",
}

export const isLocalPlaylistId = (id: string) => id.startsWith("local:")

/** The `list=` ID of a YouTube or YouTube Music playlist link. */
function youtubePlaylistId(input: string): string | null {
  try {
    const url = new URL(input.trim())
    if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname)) return null
    return url.searchParams.get("list")
  } catch {
    return null
  }
}

function msFromDuration(text: string): number | undefined {
  const parts = text.split(":").map(Number)
  if (parts.length < 2 || parts.some(Number.isNaN)) return undefined
  return parts.reduce((total, part) => total * 60 + part, 0) * 1000
}

function durationFromMs(ms: number | undefined): string {
  if (!ms) return ""
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const hours = Math.floor(minutes / 60)
  const seconds = String(total % 60).padStart(2, "0")
  return hours ? `${hours}:${String(minutes % 60).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`
}

/**
 * Reads a playlist link or a pasted song list. YouTube playlists are already YouTube Music
 * songs, so they come back with every track matched.
 */
export async function readExternalPlaylist(input: string): Promise<{ playlist: ExternalPlaylist; matches?: TrackMatch[] }> {
  const listId = youtubePlaylistId(input)
  if (listId) {
    const details = await getPlaylistDetails(listId)
    const tracks = details.tracks.filter((t) => t.videoId)
    return {
      playlist: {
        source: "youtube",
        sourceUrl: input.trim(),
        kind: details.kind ?? "Playlist",
        title: details.title,
        description: details.description,
        owner: details.artist ?? details.author,
        coverUrl: details.thumbnailUrl,
        tracks: tracks.map((t) => ({ title: t.title, artist: t.artist, durationMs: msFromDuration(t.duration), coverUrl: t.thumbnailUrl })),
      },
      matches: tracks.map((t) => ({ ...t, confidence: 1 })),
    }
  }
  return { playlist: await invoke<ExternalPlaylist>("fetch_external_playlist", { input }) }
}

export const matchTrack = (track: ExternalTrack) => invoke<TrackMatch | null>("match_track", { track })

/**
 * Matches every song, a few at a time, reporting each one as it lands. A failed search
 * counts as "not found" rather than stopping the import. `signal` stops it early.
 */
export async function matchAll(
  tracks: ExternalTrack[],
  onResult: (index: number, match: TrackMatch | null) => void,
  signal: { cancelled: boolean },
  concurrency = 4,
): Promise<(TrackMatch | null)[]> {
  const results: (TrackMatch | null)[] = new Array(tracks.length).fill(null)
  let next = 0
  const worker = async () => {
    while (!signal.cancelled && next < tracks.length) {
      const index = next++
      let match: TrackMatch | null = null
      try {
        match = await matchTrack(tracks[index])
      } catch {
        match = null
      }
      if (signal.cancelled) return
      results[index] = match
      onResult(index, match)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tracks.length) }, worker))
  return results
}

export const listLocalPlaylists = () => invoke<LocalPlaylist[]>("list_local_playlists")
export const getLocalPlaylist = (id: string) => invoke<LocalPlaylist>("get_local_playlist", { id })
export const saveLocalPlaylist = (playlist: LocalPlaylist) => invoke<LocalPlaylist>("save_local_playlist", { playlist })
export const deleteLocalPlaylist = (id: string) => invoke<void>("delete_local_playlist", { id })

export function buildLocalPlaylist(source: ExternalPlaylist, matches: (TrackMatch | null)[]): LocalPlaylist {
  return {
    id: "",
    source: source.source,
    sourceUrl: source.sourceUrl,
    kind: source.kind,
    title: source.title || "Imported Playlist",
    description: source.description,
    owner: source.owner,
    cover: source.coverUrl,
    importedAt: Date.now(),
    total: source.total,
    tracks: source.tracks.map((t, i) => ({ ...t, match: matches[i] ?? null })),
  }
}

/** A saved import as the playlist page shows it. Songs keep their original names. */
export function toPlaylistDetails(local: LocalPlaylist): PlaylistDetails {
  const tracks: PlaylistTrack[] = local.tracks.map((t) => ({
    videoId: t.match?.videoId ?? "",
    title: t.title,
    artist: t.artist,
    duration: durationFromMs(t.durationMs) || t.match?.duration || "",
    thumbnailUrl: t.coverUrl || t.match?.thumbnailUrl || "",
    missing: !t.match,
  }))
  const found = tracks.filter((t) => !t.missing).length
  const count = `${tracks.length} ${tracks.length === 1 ? "song" : "songs"}`
  return {
    id: local.id,
    title: local.title,
    description: local.description,
    author: local.owner,
    artist: local.owner || undefined,
    kind: local.kind,
    thumbnailUrl: local.cover || tracks.find((t) => t.thumbnailUrl)?.thumbnailUrl || "",
    trackCount: found === tracks.length ? count : `${found} of ${count} found`,
    tracks,
    source: local.source,
  }
}

/** A saved import as a Library card. */
export function toCard(local: LocalPlaylist): SearchResult {
  return {
    videoId: "",
    title: local.title,
    artist: `From ${SOURCE_NAMES[local.source] ?? "elsewhere"} · ${local.tracks.length} songs`,
    thumbnailUrl: local.cover || local.tracks.find((t) => t.coverUrl)?.coverUrl || "",
    playlistId: local.id,
    itemType: "playlist",
  }
}
