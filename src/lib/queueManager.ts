import {
  type SearchResult,
  type QueueSession,
  getQueueSession,
  saveQueueSession,
  isTauriEnvironment,
} from "./search.ts"

export type { QueueSession }

export const MAX_PLAYBACK_HISTORY = 50
const FALLBACK_STORAGE_KEY = "dot_music_queue_session"

export const DEFAULT_QUEUE_SESSION: QueueSession = {
  history: [],
  currentTrack: null,
  upcoming: [],
  currentTime: 0,
  isAutoplay: false,
}

/**
 * Ensures a track is valid and has a non-empty videoId.
 */
function isValidTrack(track: unknown): track is SearchResult {
  if (!track || typeof track !== "object") return false
  const t = track as SearchResult
  return typeof t.videoId === "string" && t.videoId.trim().length > 0
}

/**
 * Push track to history with fixed FIFO cap (MAX_PLAYBACK_HISTORY = 50).
 */
export function pushToHistory(history: SearchResult[], track: SearchResult): SearchResult[] {
  if (!isValidTrack(track)) return history
  const nextHistory = [...history, track]
  if (nextHistory.length > MAX_PLAYBACK_HISTORY) {
    return nextHistory.slice(nextHistory.length - MAX_PLAYBACK_HISTORY)
  }
  return nextHistory
}

/**
 * Validates and sanitizes a raw session object from storage or IPC.
 */
export function sanitizeSession(raw: unknown): QueueSession {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_QUEUE_SESSION }
  }

  const obj = raw as Partial<QueueSession>

  const history = Array.isArray(obj.history)
    ? obj.history.filter(isValidTrack).slice(-MAX_PLAYBACK_HISTORY)
    : []

  const currentTrack = isValidTrack(obj.currentTrack) ? obj.currentTrack : null

  // Ensure Upcoming has no duplicates
  const seenUpcoming = new Set<string>()
  const upcoming: SearchResult[] = []
  if (Array.isArray(obj.upcoming)) {
    for (const t of obj.upcoming) {
      if (isValidTrack(t) && !seenUpcoming.has(t.videoId)) {
        seenUpcoming.add(t.videoId)
        upcoming.push(t)
      }
    }
  }

  const currentTime = typeof obj.currentTime === "number" && !isNaN(obj.currentTime) && obj.currentTime >= 0
    ? obj.currentTime
    : 0

  const isAutoplay = Boolean(obj.isAutoplay)

  return {
    history,
    currentTrack,
    upcoming,
    currentTime,
    isAutoplay,
  }
}

/**
 * Adds a track to the end of Upcoming queue.
 * Disallows duplicates. Returns whether track was added.
 */
export function addToUpcoming(
  session: QueueSession,
  track: SearchResult,
): { session: QueueSession; added: boolean } {
  if (!isValidTrack(track)) return { session, added: false }

  const exists = session.upcoming.some((t) => t.videoId === track.videoId)
  if (exists) {
    return { session, added: false }
  }

  return {
    session: {
      ...session,
      upcoming: [...session.upcoming, track],
    },
    added: true,
  }
}

/**
 * Inserts a track immediately after Now Playing (i.e. at index 0 of Upcoming).
 * If no track is playing, sets it as currentTrack immediately.
 * Disallows duplicates if already in Upcoming.
 */
export function playNextUpcoming(
  session: QueueSession,
  track: SearchResult,
): { session: QueueSession; added: boolean; playedImmediate: boolean } {
  if (!isValidTrack(track)) {
    return { session, added: false, playedImmediate: false }
  }

  // If no track is currently playing, start it immediately
  if (!session.currentTrack) {
    return {
      session: {
        ...session,
        currentTrack: track,
        currentTime: 0,
        isAutoplay: false,
      },
      added: true,
      playedImmediate: true,
    }
  }

  const exists = session.upcoming.some((t) => t.videoId === track.videoId)
  if (exists) {
    return { session, added: false, playedImmediate: false }
  }

  return {
    session: {
      ...session,
      upcoming: [track, ...session.upcoming],
    },
    added: true,
    playedImmediate: false,
  }
}

/**
 * Appends a list of tracks (e.g. from a playlist) to Upcoming.
 * Deduplicates against existing items in Upcoming and between new items.
 */
export function appendTracksToUpcoming(
  session: QueueSession,
  tracks: SearchResult[],
): QueueSession {
  if (!tracks || tracks.length === 0) return session

  const existingIds = new Set(session.upcoming.map((t) => t.videoId))
  const newTracks: SearchResult[] = []

  for (const t of tracks) {
    if (isValidTrack(t) && !existingIds.has(t.videoId)) {
      existingIds.add(t.videoId)
      newTracks.push(t)
    }
  }

  if (newTracks.length === 0) return session

  return {
    ...session,
    upcoming: [...session.upcoming, ...newTracks],
  }
}

/**
 * Reorders Upcoming queue. Never affects Now Playing or History.
 */
export function reorderUpcoming(
  session: QueueSession,
  fromIndex: number,
  toIndex: number,
): QueueSession {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= session.upcoming.length ||
    toIndex >= session.upcoming.length
  ) {
    return session
  }

  const nextUpcoming = [...session.upcoming]
  const [moved] = nextUpcoming.splice(fromIndex, 1)
  nextUpcoming.splice(toIndex, 0, moved)

  return {
    ...session,
    upcoming: nextUpcoming,
  }
}

/**
 * Removes track at index from Upcoming queue.
 */
export function removeUpcoming(session: QueueSession, index: number): QueueSession {
  if (index < 0 || index >= session.upcoming.length) return session

  return {
    ...session,
    upcoming: session.upcoming.filter((_, idx) => idx !== index),
  }
}

/**
 * Clears the Upcoming queue.
 */
export function clearUpcoming(session: QueueSession): QueueSession {
  return {
    ...session,
    upcoming: [],
  }
}

/**
 * Plays a track immediately:
 * - Moves current track to History (capped at 50 FIFO).
 * - Removes selected track from Upcoming if present (preserving all other Upcoming tracks).
 * - Sets track as Now Playing with currentTime 0.
 * - If contextUpcoming is provided, copies those items into Upcoming.
 */
export function playTrackImmediate(
  session: QueueSession,
  track: SearchResult,
  options?: {
    contextUpcoming?: SearchResult[]
    isAutoplay?: boolean
  },
): QueueSession {
  if (!isValidTrack(track)) return session

  let nextHistory = session.history
  if (session.currentTrack && session.currentTrack.videoId) {
    nextHistory = pushToHistory(session.history, session.currentTrack)
  }

  let nextUpcoming: SearchResult[]
  if (options?.contextUpcoming && options.contextUpcoming.length > 0) {
    // Copy playlist/context tracks into Upcoming starting after the selected track
    const trackIdx = options.contextUpcoming.findIndex((t) => t.videoId === track.videoId)
    const candidates =
      trackIdx !== -1
        ? options.contextUpcoming.slice(trackIdx + 1)
        : options.contextUpcoming.filter((t) => t.videoId !== track.videoId)

    const seen = new Set<string>([track.videoId])
    nextUpcoming = []
    for (const t of candidates) {
      if (isValidTrack(t) && !seen.has(t.videoId)) {
        seen.add(t.videoId)
        nextUpcoming.push(t)
      }
    }
  } else {
    // Leave all other Upcoming tracks in their existing order, just remove the selected track
    nextUpcoming = session.upcoming.filter((t) => t.videoId !== track.videoId)
  }

  return {
    ...session,
    history: nextHistory,
    currentTrack: track,
    upcoming: nextUpcoming,
    currentTime: 0,
    isAutoplay: options?.isAutoplay ?? false,
  }
}

/**
 * Natural completion handler:
 * - Moves Now Playing to History (capped at 50 FIFO).
 * - If Upcoming has tracks: takes first track, sets as Now Playing, starts it.
 * - If Upcoming is empty: indicates that autoplay fallback recommendation is needed.
 */
export function advanceOnTrackEnd(
  session: QueueSession,
): {
  session: QueueSession
  nextTrack: SearchResult | null
  needsAutoplay: boolean
} {
  let nextHistory = session.history
  if (session.currentTrack && session.currentTrack.videoId) {
    nextHistory = pushToHistory(session.history, session.currentTrack)
  }

  if (session.upcoming.length > 0) {
    const nextTrack = session.upcoming[0]
    const remainingUpcoming = session.upcoming.slice(1)
    return {
      session: {
        ...session,
        history: nextHistory,
        currentTrack: nextTrack,
        upcoming: remainingUpcoming,
        currentTime: 0,
        isAutoplay: false,
      },
      nextTrack,
      needsAutoplay: false,
    }
  }

  return {
    session: {
      ...session,
      history: nextHistory,
      currentTrack: null,
      currentTime: 0,
      isAutoplay: false,
    },
    nextTrack: null,
    needsAutoplay: true,
  }
}

/**
 * Loads persisted queue session on app startup.
 * First tries native Tauri backend, then localStorage fallback.
 */
export async function loadPersistedSession(): Promise<QueueSession> {
  if (isTauriEnvironment()) {
    try {
      const nativeSession = await getQueueSession()
      if (nativeSession) {
        return sanitizeSession(nativeSession)
      }
    } catch (e) {
      console.warn("[DOT Music] Failed to load queue session from Tauri:", e)
    }
  }

  try {
    const raw = localStorage.getItem(FALLBACK_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return sanitizeSession(parsed)
    }
  } catch (e) {
    console.warn("[DOT Music] Failed to load queue session from localStorage:", e)
  }

  return { ...DEFAULT_QUEUE_SESSION }
}

/**
 * Persists queue session to disk via Tauri (with atomic write),
 * with localStorage fallback.
 */
export async function persistQueueSession(session: QueueSession): Promise<void> {
  // Always mirror to localStorage for resilience
  try {
    localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(session))
  } catch (e) {
    console.warn("[DOT Music] Failed to persist queue to localStorage:", e)
  }

  if (isTauriEnvironment()) {
    try {
      await saveQueueSession(session)
    } catch (e) {
      console.error("[DOT Music] Failed to persist queue session via Tauri:", e)
    }
  }
}
