import { useEffect, useRef, useState } from "react";
import { fetchLyricsMultiProvider, type TrackLyrics } from "../../lib/lyrics";
import type { SearchResult } from "../../lib/search";

export type LyricsStatus = "idle" | "loading" | "synced" | "plain" | "unavailable";

/**
 * Fetches lyrics once per track. Waits briefly for the real duration (providers
 * match on it) but doesn't refetch every time the duration value updates.
 */
export function useLyrics(track: SearchResult | null, duration: number) {
  // Results are tagged with the track they belong to; "loading" is simply
  // "the latest result isn't for the current track yet".
  const [result, setResult] = useState<{ videoId: string; data: TrackLyrics | null } | null>(null);
  const durationRef = useRef(duration);
  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  const videoId = track?.videoId;
  const title = track?.title ?? "";
  const artist = track?.artist ?? "";
  const hasDuration = duration > 0;

  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;
    // Give the player up to 1.5s to report a duration before searching without it.
    const timer = window.setTimeout(
      () => {
        fetchLyricsMultiProvider(title, artist, durationRef.current, videoId)
          .then((data) => {
            if (!cancelled) setResult({ videoId, data });
          })
          .catch((err: unknown) => {
            console.warn("[DOT Music] Failed to fetch lyrics:", err);
            if (!cancelled) setResult({ videoId, data: null });
          });
      },
      hasDuration ? 0 : 1500,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [videoId, title, artist, hasDuration]);

  const current = result && result.videoId === videoId ? result.data : null;
  let status: LyricsStatus;
  if (!videoId) status = "idle";
  else if (!result || result.videoId !== videoId) status = "loading";
  else if (!current || current.lines.length === 0 || current.syncType === "unavailable") status = "unavailable";
  else status = current.syncType === "plain" ? "plain" : "synced";

  return { data: current, status };
}
