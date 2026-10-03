import { invoke } from "@tauri-apps/api/core"

export interface SearchResult {
  videoId: string
  title: string
  artist: string
  thumbnailUrl: string
  playlistId?: string
  itemType?: "playlist" | "song"
}

export interface PlaylistTrack {
  videoId: string
  title: string
  artist: string
  duration: string
  thumbnailUrl: string
}

export interface PlaylistDetails {
  id: string
  title: string
  description: string
  author: string
  thumbnailUrl: string
  trackCount: string
  tracks: PlaylistTrack[]
}

export interface HomeSection {
  title: string
  items: SearchResult[]
}

export interface HomeFeedResponse {
  sections: HomeSection[]
  continuationToken?: string
}

// Curated demo catalog used as fallback when running in standard browser without an API key
const DEMO_CATALOG: SearchResult[] = [
  {
    videoId: "jfKfPfyJRdk",
    title: "lofi hip hop radio - beats to relax/study to",
    artist: "Lofi Girl",
    thumbnailUrl: "https://i.ytimg.com/vi/jfKfPfyJRdk/hqdefault.jpg",
  },
  {
    videoId: "5qap5aO4i9A",
    title: "Lofi Hip Hop Radio - Beats to Sleep/Chill to",
    artist: "Lofi Girl",
    thumbnailUrl: "https://i.ytimg.com/vi/5qap5aO4i9A/hqdefault.jpg",
  },
  {
    videoId: "21X5lGlDOfg",
    title: "NASA Earth From Space - ISS Live Stream",
    artist: "NASA",
    thumbnailUrl: "https://i.ytimg.com/vi/21X5lGlDOfg/hqdefault.jpg",
  },
  {
    videoId: "kJQP7kiw5Fk",
    title: "Luis Fonsi - Despacito ft. Daddy Yankee",
    artist: "Luis Fonsi",
    thumbnailUrl: "https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg",
  },
  {
    videoId: "fJ9rUzIMcZQ",
    title: "Queen - Bohemian Rhapsody (Official Video)",
    artist: "Queen Official",
    thumbnailUrl: "https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg",
  },
]

export function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export async function openLoginWindow(clean = false): Promise<void> {
  if (isTauriEnvironment()) {
    await invoke("open_login_window", { clean })
  }
}

export async function getAuthStatus(): Promise<boolean> {
  if (isTauriEnvironment()) {
    return await invoke<boolean>("get_auth_status")
  }
  return false
}

export async function logoutUser(): Promise<void> {
  if (isTauriEnvironment()) {
    await invoke("logout")
  }
}

export interface UserProfile {
  name: string
  email: string
  avatarUrl: string
}

export async function getUserProfile(): Promise<UserProfile | null> {
  if (isTauriEnvironment()) {
    try {
      return await invoke<UserProfile | null>("get_user_profile")
    } catch {
      return null
    }
  }
  return null
}

export async function getHomeFeed(): Promise<HomeFeedResponse> {
  if (isTauriEnvironment()) {
    try {
      return await invoke<HomeFeedResponse>("get_home_feed")
    } catch {
      return { sections: [] }
    }
  }
  return {
    sections: [
      {
        title: "Featured Tracks",
        items: DEMO_CATALOG,
      },
    ],
  }
}

export async function getHomeFeedContinuation(
  continuation: string,
): Promise<HomeFeedResponse> {
  if (isTauriEnvironment() && continuation) {
    try {
      return await invoke<HomeFeedResponse>("get_home_feed_continuation", {
        continuation,
      })
    } catch {
      return { sections: [] }
    }
  }
  return { sections: [] }
}

export async function getPlaylistDetails(
  playlistId: string,
): Promise<PlaylistDetails> {
  if (isTauriEnvironment() && playlistId) {
    return await invoke<PlaylistDetails>("get_playlist_details", {
      playlistId,
    })
  }
  throw new Error("Tauri environment not available")
}

export async function getHistory(): Promise<HomeFeedResponse> {
  if (isTauriEnvironment()) {
    try {
      return await invoke<HomeFeedResponse>("get_history")
    } catch {
      return { sections: [] }
    }
  }
  return { sections: [] }
}

const RECENT_SEARCHES_KEY = "dot_music_recent_searches"
const MAX_RECENT_SEARCHES = 12

export function getRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveRecentSearch(query: string): string[] {
  const trimmed = query.trim()
  if (!trimmed) return getRecentSearches()
  try {
    const current = getRecentSearches()
    const filtered = current.filter(
      (q) => q.toLowerCase() !== trimmed.toLowerCase(),
    )
    const updated = [trimmed, ...filtered].slice(0, MAX_RECENT_SEARCHES)
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated))
    return updated
  } catch {
    return []
  }
}

export function removeRecentSearch(query: string): string[] {
  try {
    const current = getRecentSearches()
    const updated = current.filter(
      (q) => q.toLowerCase() !== query.toLowerCase(),
    )
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated))
    return updated
  } catch {
    return []
  }
}

export function clearRecentSearches(): void {
  try {
    localStorage.removeItem(RECENT_SEARCHES_KEY)
  } catch {
    // ignore
  }
}

/**
 * Searches YouTube tracks.
 * - In Tauri Desktop: delegates to native Rust backend (no CORS, live search without API key).
 * - In Browser with API key: uses YouTube Data API v3.
 * - In Browser without API key: falls back to local demo catalog.
 */
export async function searchTracks(
  query: string,
  apiKey?: string,
): Promise<SearchResult[]> {
  const cleanQuery = query.trim()
  if (!cleanQuery) return []

  // 1. If running inside Tauri desktop app, use Rust native search
  if (isTauriEnvironment()) {
    try {
      return await invoke<SearchResult[]>("search_tracks", { query: cleanQuery })
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "Tauri native search failed.",
      )
    }
  }

  // 2. If running in pure web browser with an API key, use Data API v3
  if (apiKey) {
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      maxResults: "5",
      q: cleanQuery,
      key: apiKey,
    })

    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/search?${params.toString()}`,
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as {
        error?: { message?: string }
      }
      throw new Error(
        errorData.error?.message ?? "YouTube search request failed.",
      )
    }

    const data = await response.json() as {
      items?: Array<{
        id?: { videoId?: string }
        snippet?: {
          channelTitle?: string
          thumbnails?: { medium?: { url?: string }; default?: { url?: string } }
          title?: string
        }
      }>
    }

    return (data.items ?? [])
      .filter((item) => item.id?.videoId && item.snippet?.title)
      .map((item) => ({
        videoId: item.id!.videoId!,
        title: item.snippet!.title!,
        artist: item.snippet!.channelTitle ?? "Unknown Artist",
        thumbnailUrl:
          item.snippet!.thumbnails?.medium?.url ??
          item.snippet!.thumbnails?.default?.url ??
          "",
      }))
  }

  // 3. Fallback for pure web browser without API key: search local demo catalog
  const lowerQuery = cleanQuery.toLowerCase()
  return DEMO_CATALOG.filter(
    (item) =>
      item.title.toLowerCase().includes(lowerQuery) ||
      item.artist.toLowerCase().includes(lowerQuery),
  )
}
