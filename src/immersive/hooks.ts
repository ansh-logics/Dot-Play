import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { fetchLyricsMultiProvider, type TrackLyrics } from "../lib/lyrics";
import { buildLyricRows, type LyricRow } from "../components/now-playing/lyricRows";
import {
  defaultView,
  listDisplays,
  loadDisplayChoices,
  saveDisplayChoice,
  type ImmersiveDisplay,
  type ImmersiveState,
  type ImmersiveView,
} from "../lib/immersive";
import type { NowPlaying } from "../tray/types";

/** Set by Rust before the page loads (see src-tauri/src/immersive.rs). */
export interface ScreenInfo {
  index: number;
  count: number;
  screenKey: string;
  trigger: "manual" | "idle";
}

declare global {
  interface Window {
    __IMMERSIVE__?: ScreenInfo;
  }
}

export const SCREEN: ScreenInfo = window.__IMMERSIVE__ ?? {
  index: 0,
  count: 1,
  screenKey: "preview",
  trigger: "manual",
};

/** The track and the main window's state, as the menu bar popover gets them. */
export function useImmersiveData() {
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [state, setState] = useState<ImmersiveState | null>(null);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const keep = (fn: () => void) => (disposed ? fn() : unlisteners.push(fn));

    void invoke<NowPlaying | null>("get_now_playing")
      .then((value) => !disposed && setNp(value))
      .catch(() => {});
    void Promise.all([
      listen<NowPlaying | null>("now-playing", ({ payload }) => setNp(payload)).then(keep),
      listen<ImmersiveState>("immersive-state", ({ payload }) => setState(payload)).then(keep),
    ]).then(() => {
      if (!disposed) void emitTo("main", "immersive-ready").catch(() => {});
    });
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  return { np, state };
}

export interface DisplaysState {
  /** Every connected display, in immersive mode's order. */
  displays: ImmersiveDisplay[];
  off: Set<string>;
  /** How many displays show immersive mode right now. */
  count: number;
}

/** The displays and which of them show immersive mode, kept in step across all displays. */
export function useDisplays(): DisplaysState {
  const [displays, setDisplays] = useState<ImmersiveDisplay[]>([]);
  const [off, setOff] = useState(
    () => new Set(Object.entries(loadDisplayChoices()).filter(([, c]) => c === "off").map(([key]) => key)),
  );
  const [count, setCount] = useState(SCREEN.count);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listDisplays().then((list) => !disposed && setDisplays(list));
    void listen<{ off: string[]; count: number }>("immersive-displays", ({ payload }) => {
      setOff(new Set(payload.off));
      setCount(payload.count);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return { displays, off, count };
}

/** The current time, updated on each second boundary. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, 1000 - (Date.now() % 1000) + 5);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);
  return now;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });

/** "9:41" in the user's 12- or 24-hour style, without AM/PM (as on the lock screen). */
export function clockParts(now: Date) {
  const parts = timeFormat.formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "";
  return { hour, minute, date: dateFormat.format(now) };
}

/** The view this display shows; switching it here is remembered for the display. */
export function useScreenView(): [ImmersiveView, (view: ImmersiveView) => void] {
  const [view, setView] = useState<ImmersiveView>(() => {
    const saved = loadDisplayChoices()[SCREEN.screenKey];
    return saved && saved !== "off" ? saved : defaultView(SCREEN.index);
  });
  const choose = (next: ImmersiveView) => {
    setView(next);
    saveDisplayChoice(SCREEN.screenKey, next);
  };
  return [view, choose];
}

export type LyricsResult =
  | { status: "loading" }
  | { status: "none" }
  | { status: "synced"; rows: LyricRow[] };

/** Line-synced lyrics for the track; only fetched while `wanted`. */
export function useLyricRows(np: NowPlaying | null, wanted: boolean): LyricsResult {
  const key = np ? (np.videoId ?? `${np.title}::${np.artist}`) : null;
  const [result, setResult] = useState<{ key: string; data: TrackLyrics | null } | null>(null);

  const title = np?.title ?? "";
  const artist = np?.artist ?? "";
  const duration = np?.duration ?? 0;
  const videoId = np?.videoId ?? undefined;
  useEffect(() => {
    if (!key || !wanted) return;
    let cancelled = false;
    fetchLyricsMultiProvider(title, artist, duration || undefined, videoId)
      .then((data) => !cancelled && setResult({ key, data }))
      .catch(() => !cancelled && setResult({ key, data: null }));
    return () => {
      cancelled = true;
    };
    // A repeat call for the same track is answered from lyrics.ts's cache.
  }, [key, wanted, title, artist, duration, videoId]);

  const data = result?.key === key ? result.data : undefined;
  const synced = data && data.syncType !== "plain" && data.syncType !== "unavailable";
  const rows = useMemo(() => (synced && data ? buildLyricRows(data.lines) : []), [synced, data]);

  if (data === undefined) return { status: "loading" };
  if (!synced || rows.length === 0) return { status: "none" };
  return { status: "synced", rows };
}

/**
 * A sharper copy of the cover for a cover drawn `px` device pixels wide. Album covers on
 * Google's image hosts come at any size asked for; video frames go up to the 1280px master.
 * Returns null when there's nothing sharper to ask for.
 */
export function sharperCoverUrl(url: string | null, px: number): string | null {
  if (!url) return null;
  if (/googleusercontent\.com|ggpht\.com/.test(url)) {
    const size = Math.min(2048, Math.ceil(px / 256) * 256);
    const sharper = url.replace(/=w\d+-h\d+/, `=w${size}-h${size}`).replace(/=s\d+(?=-|$)/, `=s${size}`);
    return sharper !== url ? sharper : null;
  }
  if (/i\.ytimg\.com\/vi\/[^/]+\/(hq|mq|sd)default\.jpg/.test(url)) {
    return url.replace(/(hq|mq|sd)default\.jpg/, "maxresdefault.jpg");
  }
  return null;
}
