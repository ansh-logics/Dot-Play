import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PlaybackState } from "./engine/deck";
import { cleanDisplayTitle } from "./displayText";
import type { PlaybackClock } from "./playbackClock";
import { isTauriEnvironment, type SearchResult } from "./search";

/**
 * Discord status ("Listening to DOT Music") while music plays. Off until the listener turns it
 * on in Settings: it tells everyone on their Discord what they're listening to.
 */

const STORAGE_KEY = "dot_discord_presence";
const listeners = new Set<() => void>();

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = readEnabled();

export function isDiscordPresenceEnabled(): boolean {
  return enabled;
}

export function setDiscordPresenceEnabled(on: boolean): void {
  enabled = on;
  try {
    if (on) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
  if (!on) setStatus({ kind: "idle" });
  if (!on && isTauriEnvironment()) void invoke("stop_discord_presence").catch(() => {});
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useDiscordPresenceEnabled(): boolean {
  return useSyncExternalStore(subscribe, isDiscordPresenceEnabled);
}

/** What happened last time the status was sent, shown in Settings so a missing status explains itself. */
export type DiscordPresenceStatus =
  | { kind: "idle" }
  | { kind: "shown"; title: string }
  | { kind: "cleared" }
  | { kind: "no-discord" }
  | { kind: "error"; message: string };

let status: DiscordPresenceStatus = { kind: "idle" };
const statusListeners = new Set<() => void>();

function setStatus(next: DiscordPresenceStatus) {
  status = next;
  statusListeners.forEach((fn) => fn());
}

export function useDiscordPresenceStatus(): DiscordPresenceStatus {
  return useSyncExternalStore(
    (fn) => {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    () => status,
  );
}

/** Whether this build can show a Discord status (a desktop build with the app id set). */
export function useDiscordPresenceAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(isTauriEnvironment() ? null : false);
  useEffect(() => {
    if (!isTauriEnvironment()) return;
    let live = true;
    invoke<boolean>("discord_presence_available").then(
      (value) => live && setAvailable(value),
      () => live && setAvailable(false),
    );
    return () => {
      live = false;
    };
  }, []);
  return available;
}

export interface DiscordActivity {
  title: string;
  artist: string;
  album: string | null;
  artworkUrl: string | null;
  /** Unix milliseconds when the song would have started at the current speed. */
  startMs: number;
  endMs: number | null;
  url: string;
}

/**
 * The status for `track` at `position` seconds. The timestamps are where the song "started"
 * and will end on the wall clock, so Discord's own timer shows the right elapsed time; at a
 * speed other than 1× the song is shorter or longer in real time.
 */
export function buildDiscordActivity(
  track: Pick<SearchResult, "videoId" | "title" | "artist" | "thumbnailUrl">,
  position: number,
  duration: number,
  rate: number,
  now: number,
): DiscordActivity {
  const speed = rate > 0 ? rate : 1;
  const startMs = Math.round(now - (Math.max(0, position) * 1000) / speed);
  const art = track.thumbnailUrl && /^https:\/\//.test(track.thumbnailUrl) ? track.thumbnailUrl : null;
  return {
    title: cleanDisplayTitle(track.title),
    artist: track.artist,
    album: null,
    artworkUrl: art,
    startMs,
    endMs: duration > 0 ? Math.round(startMs + (duration * 1000) / speed) : null,
    url: `https://music.youtube.com/watch?v=${encodeURIComponent(track.videoId)}`,
  };
}

/** Republish after a seek that moves the song this far from where Discord thinks it is. */
const SEEK_TOLERANCE_S = 3;
/** While Discord isn't running, look for it again this often. */
const RETRY_MS = 30_000;

interface DiscordPresenceOptions {
  track: SearchResult | null | undefined;
  playerState: PlaybackState;
  clock: PlaybackClock;
  duration: number;
  rate: number;
}

/** Keeps the Discord status in step with playback: shown while playing, cleared on pause. */
export function useDiscordPresence({ track, playerState, clock, duration, rate }: DiscordPresenceOptions) {
  const on = useDiscordPresenceEnabled() && isTauriEnvironment();
  // Buffering mid-song shouldn't flicker the status off.
  const [playing, setPlaying] = useState(false);
  const nextPlaying = playerState === "playing" ? true : playerState === "buffering" ? playing : false;
  if (nextPlaying !== playing) setPlaying(nextPlaying);

  const sent = useRef<{ position: number; at: number; rate: number } | null>(null);
  const connected = useRef(true);
  const videoId = track?.videoId;
  const knownDuration = duration > 0 ? Math.round(duration) : 0;

  const publish = useEffectEvent(() => {
    if (!on) return;
    const failed = (error: unknown) => {
      console.warn("[DOT Music] Discord status update failed:", error);
      connected.current = false;
      setStatus({ kind: "error", message: String(error) });
    };
    if (!track || !playing) {
      sent.current = null;
      void invoke<boolean>("set_discord_activity", { activity: null }).then((ok) => {
        connected.current = ok;
        setStatus(ok ? { kind: "cleared" } : { kind: "no-discord" });
      }, failed);
      return;
    }
    const position = clock.get();
    sent.current = { position, at: performance.now(), rate };
    const activity = buildDiscordActivity(track, position, knownDuration, rate, Date.now());
    void invoke<boolean>("set_discord_activity", { activity }).then((ok) => {
      connected.current = ok;
      setStatus(ok ? { kind: "shown", title: activity.title } : { kind: "no-discord" });
    }, failed);
  });

  useEffect(() => {
    publish();
  }, [on, videoId, playing, knownDuration, rate]);

  // A seek (scrubber, arrow keys, "previous" restarting) moves Discord's timer too.
  useEffect(() => {
    if (!on) return;
    return clock.subscribe(() => {
      const last = sent.current;
      if (!last) return;
      const expected = last.position + ((performance.now() - last.at) / 1000) * last.rate;
      if (Math.abs(clock.get() - expected) > SEEK_TOLERANCE_S) publish();
    });
  }, [on, clock]);

  // Discord opened after the music started: pick it up within half a minute.
  useEffect(() => {
    if (!on || !playing) return;
    const timer = window.setInterval(() => {
      if (!connected.current) publish();
    }, RETRY_MS);
    return () => window.clearInterval(timer);
  }, [on, playing]);
}
