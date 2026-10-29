import type { HomeSection, SearchResult } from "./search";

/**
 * Listening history = songs played in dot(.)music (kept here, with the time of each
 * play) + YouTube Music's history (pulled down, one way). The app never relies on
 * its plays reaching YouTube: record_playback is best effort, so local plays are
 * kept for good and merged with YouTube's list; a song in both shows once.
 */
export interface LocalPlay {
  track: SearchResult;
  playedAt: number;
}

export interface StoredHistory {
  /** YouTube's history shelves as of the last successful sync. */
  youtube: HomeSection[];
  /** Songs played in dot(.)music, newest first. */
  localPlays: LocalPlay[];
  /** When `youtube` was last fetched (ms); null before the first sync or when signed out. */
  syncedAt: number | null;
}

const STORAGE_KEY = "dot_music_listening_history_v1";
const MAX_LOCAL_PLAYS = 200;
const MAX_YOUTUBE_ITEMS = 300;
/** YouTube's history is re-fetched when the saved copy is older than this. */
export const HISTORY_REFRESH_MS = 5 * 60 * 1000;

export const EMPTY_HISTORY: StoredHistory = { youtube: [], localPlays: [], syncedAt: null };

const isTrack = (t: unknown): t is SearchResult =>
  typeof t === "object" && t !== null && typeof (t as SearchResult).videoId === "string";

export function loadStoredHistory(): StoredHistory {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_HISTORY;
    const parsed = JSON.parse(raw) as Partial<StoredHistory>;
    return {
      youtube: Array.isArray(parsed.youtube)
        ? parsed.youtube
            .filter((s) => s && typeof s.title === "string" && Array.isArray(s.items))
            .map((s) => ({ title: s.title, items: s.items.filter(isTrack) }))
        : [],
      localPlays: Array.isArray(parsed.localPlays)
        ? parsed.localPlays
            .filter((p) => p && isTrack(p.track) && typeof p.playedAt === "number")
            .slice(0, MAX_LOCAL_PLAYS)
        : [],
      syncedAt: typeof parsed.syncedAt === "number" ? parsed.syncedAt : null,
    };
  } catch {
    return EMPTY_HISTORY;
  }
}

export function saveStoredHistory(history: StoredHistory): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Storage full or unavailable: the in-memory copy still works this session.
  }
}

export function clearStoredHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Keeps YouTube's shelves within a size that stays cheap to store and render. */
export function trimYoutubeHistory(sections: HomeSection[]): HomeSection[] {
  let budget = MAX_YOUTUBE_ITEMS;
  const out: HomeSection[] = [];
  for (const section of sections) {
    if (budget <= 0) break;
    const items = section.items.slice(0, budget);
    budget -= items.length;
    if (items.length > 0) out.push({ title: section.title, items });
  }
  return out;
}

export function addLocalPlay(plays: LocalPlay[], track: SearchResult, playedAt: number): LocalPlay[] {
  return [{ track, playedAt }, ...plays.filter((p) => p.track.videoId !== track.videoId)].slice(
    0,
    MAX_LOCAL_PLAYS,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** The shelf a local play belongs in, named the way YouTube Music names its shelves. */
function shelfTitle(playedAt: number, now: number): string {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (playedAt >= startOfToday) return "Today";
  if (playedAt >= startOfToday - DAY_MS) return "Yesterday";
  if (playedAt >= startOfToday - 7 * DAY_MS) return "This week";
  if (playedAt >= startOfToday - 14 * DAY_MS) return "Last week";
  const date = new Date(playedAt);
  const month = date.toLocaleDateString("en-US", { month: "long" });
  return date.getFullYear() === new Date(now).getFullYear() ? month : `${month} ${date.getFullYear()}`;
}

/** Sort key for a shelf title, newest first; titles it can't read sort last. */
function shelfRank(title: string, now: number): number {
  const fixed = ["today", "yesterday", "this week", "last week"].indexOf(title.toLowerCase());
  if (fixed !== -1) return fixed;
  const match = /^([a-z]+)(?:\s+(\d{4}))?$/i.exec(title.trim());
  const monthIndex = match ? MONTHS.indexOf(match[1].toLowerCase()) : -1;
  if (!match || monthIndex === -1) return Number.MAX_SAFE_INTEGER;
  const current = new Date(now);
  let year = match[2] ? Number(match[2]) : current.getFullYear();
  if (!match[2] && monthIndex > current.getMonth()) year -= 1;
  const monthsAgo = (current.getFullYear() - year) * 12 + (current.getMonth() - monthIndex);
  return 4 + Math.max(0, monthsAgo);
}

/**
 * Merged shelves, newest first. Every local play is grouped into a YouTube-style shelf
 * (Today, Yesterday, This week, Last week, then months); in a shelf both sources share,
 * local plays go first since they carry exact times. Each song appears once, at its
 * most recent shelf.
 */
export function mergeHistory(history: StoredHistory, now = Date.now()): HomeSection[] {
  const merged: HomeSection[] = history.youtube.map((s) => ({ title: s.title, items: [...s.items] }));

  const localShelves: HomeSection[] = [];
  for (const play of history.localPlays) {
    const title = shelfTitle(play.playedAt, now);
    const last = localShelves[localShelves.length - 1];
    if (last?.title === title) last.items.push(play.track);
    else localShelves.push({ title, items: [play.track] });
  }

  // Local shelves are newest first; place each by rank, or join YouTube's shelf of that name.
  // Shelf titles are compared case-insensitively ("This week" vs "This Week").
  let floor = 0;
  for (const local of localShelves) {
    const match = merged.find((s) => s.title.toLowerCase() === local.title.toLowerCase());
    if (match) {
      match.items.unshift(...local.items);
      floor = merged.indexOf(match) + 1;
      continue;
    }
    const rank = shelfRank(local.title, now);
    let at = floor;
    while (at < merged.length && shelfRank(merged[at].title, now) <= rank) at++;
    merged.splice(at, 0, local);
    floor = at + 1;
  }

  const seen = new Set<string>();
  return merged
    .map((section) => ({
      title: section.title,
      items: section.items.filter((item) => {
        const key = item.videoId || item.playlistId;
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    }))
    .filter((section) => section.items.length > 0);
}
