import { useEffect, useEffectEvent, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen as listenEvent } from "@tauri-apps/api/event";
import type { YouTubePlaybackState } from "../components/HiddenYouTubePlayer";
import { cleanDisplayTitle } from "./displayText";
import { cleanArtistName } from "./lyrics";
import type { PlaybackClock } from "./playbackClock";
import { isTauriEnvironment, type SearchResult } from "./search";

/**
 * Scrobbling: tells Last.fm / ListenBrainz what was listened to. This side decides when a
 * listen counts; Rust (src-tauri/src/scrobble) queues and sends it.
 *
 * The rule is Last.fm's: a song longer than 30 seconds counts once half of it, or 4 minutes,
 * has actually been heard. Paused time doesn't count, and neither does music skipped over by
 * seeking. The listen is stamped with when the song started.
 */

export const MIN_SONG_S = 30;
export const MAX_THRESHOLD_S = 240;
/** Position steps bigger than this between readings are seeks, not listening. */
const MAX_STEP_S = 2;

/** Seconds that must be heard before a song counts, or null when it never does. */
export function scrobbleThreshold(duration: number): number | null {
  if (!(duration > 0)) return MAX_THRESHOLD_S;
  if (duration <= MIN_SONG_S) return null;
  return Math.min(duration / 2, MAX_THRESHOLD_S);
}

/** Counts the seconds of a song actually heard, from successive position readings. */
export function createListenTracker() {
  let last: number | null = null;
  let heard = 0;
  return {
    /** Returns true when the song started over (repeat one, or "previous" restarting it). */
    update(position: number, playing: boolean): boolean {
      if (!Number.isFinite(position)) return false;
      const prev = last;
      last = position;
      if (prev === null) return false;
      if (position < 1.5 && prev > 10) {
        heard = 0;
        return true;
      }
      const step = position - prev;
      if (playing && step > 0 && step <= MAX_STEP_S) heard += step;
      return false;
    },
    reset(position: number | null = null) {
      last = position;
      heard = 0;
    },
    get heard() {
      return heard;
    },
  };
}

export interface ScrobbleListen {
  artist: string;
  track: string;
  album?: string;
  duration?: number;
  /** Unix seconds when the song started. */
  startedAt: number;
  videoId?: string;
}

/** What gets sent: the title without "(Official Video)", the artist without " - Topic". */
export function buildListen(track: Pick<SearchResult, "videoId" | "title" | "artist">, duration: number, startedAt: number): ScrobbleListen {
  return {
    artist: cleanArtistName(track.artist).cleanArtist || track.artist.trim(),
    track: cleanDisplayTitle(track.title),
    duration: duration > 0 ? Math.round(duration) : undefined,
    startedAt: Math.round(startedAt),
    videoId: track.videoId,
  };
}

// ---- Connection status, shared with Settings --------------------------------------------

export interface ScrobbleStatus {
  lastfmAvailable: boolean;
  lastfmUser: string | null;
  listenbrainzUser: string | null;
  pending: number;
}

/** The services signed in, refreshed whenever Rust says something changed. */
export function useScrobbleStatus(): ScrobbleStatus | null {
  const [status, setStatus] = useState<ScrobbleStatus | null>(null);
  useEffect(() => {
    if (!isTauriEnvironment()) return;
    let live = true;
    const refresh = () =>
      void invoke<ScrobbleStatus>("scrobble_status").then(
        (next) => live && setStatus(next),
        () => {},
      );
    refresh();
    let unlisten: (() => void) | undefined;
    void listenEvent("scrobble-status-changed", refresh).then((fn) => (live ? (unlisten = fn) : fn()));
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);
  return status;
}

// ---- Watching playback -----------------------------------------------------------------

interface ScrobblerOptions {
  track: SearchResult | null | undefined;
  playerState: YouTubePlaybackState;
  clock: PlaybackClock;
  duration: number;
}

/** Sends "now playing" when a song starts and the listen once it counts. */
export function useScrobbler({ track, playerState, clock, duration }: ScrobblerOptions) {
  const status = useScrobbleStatus();
  const on = Boolean(status && ((status.lastfmAvailable && status.lastfmUser) || status.listenbrainzUser));
  const playing = playerState === "playing";

  const [tracker] = useState(createListenTracker);
  /** This play of the current song: when it started, and what has been sent for it. */
  const play = useRef<{ videoId: string; startedAt: number | null; nowPlaying: boolean; scrobbled: boolean } | null>(null);
  const videoId = track?.videoId;

  const startPlay = useEffectEvent((id: string) => {
    play.current = { videoId: id, startedAt: null, nowPlaying: false, scrobbled: false };
    tracker.reset(clock.get());
  });

  // A new song (or the same one started over) is a new play.
  useEffect(() => {
    if (videoId) startPlay(videoId);
  }, [videoId]);

  const onTick = useEffectEvent(() => {
    const current = play.current;
    if (!on || !track || !current || current.videoId !== track.videoId) return;
    const position = clock.get();
    if (tracker.update(position, playing)) {
      startPlay(track.videoId);
      return;
    }
    if (!playing) return;
    if (current.startedAt === null) current.startedAt = Date.now() / 1000 - position;
    if (!current.nowPlaying) {
      current.nowPlaying = true;
      void invoke("scrobble_now_playing", { listen: buildListen(track, duration, current.startedAt) }).catch(() => {});
    }
    const threshold = scrobbleThreshold(duration);
    if (!current.scrobbled && threshold !== null && tracker.heard >= threshold) {
      current.scrobbled = true;
      void invoke("scrobble_listen", { listen: buildListen(track, duration, current.startedAt) }).catch((error) =>
        console.warn("[DOT Music] Scrobble failed:", error),
      );
    }
  });

  useEffect(() => clock.subscribe(onTick), [clock]);
  // Starting playback (no tick yet) should still send "now playing" promptly.
  useEffect(() => {
    if (playing) onTick();
  }, [playing, on]);
}
