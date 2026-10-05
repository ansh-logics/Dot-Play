export interface TrackMetadata {
  videoId: string;
  title: string;
  artist: string;
  thumbnailUrl: string;
  duration?: string;
  playlistId?: string;
  itemType?: "song" | "playlist";
  verifiedArtwork?: boolean;
  updatedAt: number;
}

const STORAGE_KEY = "dot_music_track_metadata_cache";
const MAX_CACHE_ENTRIES = 1200;

// Primary in-memory index: videoId -> TrackMetadata
const trackMap = new Map<string, TrackMetadata>();

// Secondary in-memory index: normalized "title - artist" -> videoId
const nameMap = new Map<string, string>();

/**
 * Normalizes title and artist into a clean lookup key.
 * Removes extra whitespace, punctuation, "(Official Video)", etc.
 */
export function normalizeTrackKey(title: string, artist = ""): string {
  const cleanTitle = (title || "")
    .toLowerCase()
    .replace(/\s*\(.*?official.*?\)/gi, "")
    .replace(/\s*\[.*?official.*?\]/gi, "")
    .replace(/\s*\(.*?audio.*?\)/gi, "")
    .replace(/\s*\(.*?video.*?\)/gi, "")
    .replace(/\s*\(.*?from\s+.*?\)/gi, "")
    .replace(/[^\w\s]/gi, "")
    .trim();

  const cleanArtist = (artist || "")
    .toLowerCase()
    .replace(/[^\w\s]/gi, "")
    .trim();

  return `${cleanTitle}___${cleanArtist}`;
}

// Initialize cache from localStorage
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const list: TrackMetadata[] = JSON.parse(raw);
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && item.videoId) {
          trackMap.set(item.videoId, item);
          if (item.title) {
            nameMap.set(normalizeTrackKey(item.title, item.artist), item.videoId);
          }
        }
      }
    }
  }
} catch {
  // Ignore storage access error
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const all = Array.from(trackMap.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_CACHE_ENTRIES);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
      // Storage quota or error
    }
  }, 1000);
}

/**
 * Retrieves a track from cache by videoId, or by title & artist.
 */
export function getCachedTrack(
  videoId?: string,
  title?: string,
  artist?: string
): TrackMetadata | null {
  if (videoId && trackMap.has(videoId)) {
    return trackMap.get(videoId)!;
  }

  if (title) {
    const key = normalizeTrackKey(title, artist);
    const resolvedId = nameMap.get(key);
    if (resolvedId && trackMap.has(resolvedId)) {
      return trackMap.get(resolvedId)!;
    }
  }

  return null;
}

/**
 * Gets cached verified high-res artwork URL for a track if available.
 */
export function getCachedArtwork(
  videoId?: string,
  title?: string,
  artist?: string
): string | null {
  const track = getCachedTrack(videoId, title, artist);
  if (track && track.thumbnailUrl) {
    return track.thumbnailUrl;
  }
  return null;
}

/**
 * Adds or updates a single track in the cache.
 */
export function cacheTrack(
  item: Partial<TrackMetadata> & { videoId?: string; title?: string }
): TrackMetadata | null {
  const videoId = item.videoId?.trim();
  const title = item.title?.trim();
  if (!videoId && !title) return null;

  const key = videoId || `custom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const existing = trackMap.get(key);

  const merged: TrackMetadata = {
    videoId: key,
    title: title || existing?.title || "Unknown Track",
    artist: item.artist || existing?.artist || "YouTube Music",
    thumbnailUrl:
      item.thumbnailUrl ||
      existing?.thumbnailUrl ||
      (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : ""),
    duration: item.duration || existing?.duration,
    playlistId: item.playlistId || existing?.playlistId,
    itemType: item.itemType || existing?.itemType || "song",
    verifiedArtwork: item.verifiedArtwork ?? existing?.verifiedArtwork ?? false,
    updatedAt: Date.now(),
  };

  trackMap.set(key, merged);
  if (merged.title) {
    nameMap.set(normalizeTrackKey(merged.title, merged.artist), key);
  }

  schedulePersist();
  return merged;
}

/**
 * Bulk saves tracks to the cache (e.g. from feed or search results).
 */
export function cacheTracks(
  tracks: Array<Partial<TrackMetadata> & { videoId?: string; title?: string }>
): void {
  if (!Array.isArray(tracks) || tracks.length === 0) return;

  for (const t of tracks) {
    if (!t) continue;
    const videoId = t.videoId?.trim();
    const title = t.title?.trim();
    if (!videoId && !title) continue;

    const key = videoId || `custom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const existing = trackMap.get(key);

    const merged: TrackMetadata = {
      videoId: key,
      title: title || existing?.title || "Unknown Track",
      artist: t.artist || existing?.artist || "YouTube Music",
      thumbnailUrl:
        t.thumbnailUrl ||
        existing?.thumbnailUrl ||
        (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : ""),
      duration: t.duration || existing?.duration,
      playlistId: t.playlistId || existing?.playlistId,
      itemType: t.itemType || existing?.itemType || "song",
      verifiedArtwork: t.verifiedArtwork ?? existing?.verifiedArtwork ?? false,
      updatedAt: Date.now(),
    };

    trackMap.set(key, merged);
    if (merged.title) {
      nameMap.set(normalizeTrackKey(merged.title, merged.artist), key);
    }
  }

  schedulePersist();
}

/**
 * Marks that an artwork URL successfully loaded and is verified.
 */
export function markArtworkVerified(videoId: string, workingUrl: string): void {
  if (!videoId || !workingUrl) return;
  const existing = trackMap.get(videoId);
  if (existing) {
    existing.thumbnailUrl = workingUrl;
    existing.verifiedArtwork = true;
    existing.updatedAt = Date.now();
  } else {
    trackMap.set(videoId, {
      videoId,
      title: "",
      artist: "",
      thumbnailUrl: workingUrl,
      verifiedArtwork: true,
      updatedAt: Date.now(),
    });
  }
  schedulePersist();
}

/**
 * Quick search into cached tracks by title or artist.
 */
export function findTracksInCache(query: string): TrackMetadata[] {
  const clean = query.trim().toLowerCase();
  if (!clean) return [];

  const matches: TrackMetadata[] = [];
  for (const item of trackMap.values()) {
    if (
      item.title.toLowerCase().includes(clean) ||
      item.artist.toLowerCase().includes(clean)
    ) {
      matches.push(item);
      if (matches.length >= 20) break;
    }
  }
  return matches;
}

/**
 * Clears account-specific library and playlist metadata from the cache on logout,
 * while preserving general public track artwork and metadata.
 */
export function clearAccountSpecificCache(): void {
  for (const [key, item] of Array.from(trackMap.entries())) {
    if (item.itemType === "playlist" || item.playlistId) {
      trackMap.delete(key);
      if (item.title) {
        nameMap.delete(normalizeTrackKey(item.title, item.artist));
      }
    }
  }
  schedulePersist();
}
