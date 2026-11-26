import { memo, useEffect, useState } from "react";
import { formatRate } from "../../lib/playbackExtras";
import type { TrackLyrics } from "../../lib/lyrics";
import type { DeckStatsSnapshot } from "../../lib/usePlayback";
import type { LyricsStatus } from "./useLyrics";
import "./StatsForNerds.css";

export interface StatsForNerdsProps {
  /** Read once on open and once a second while visible; it only asks the active deck. */
  getStats: () => DeckStatsSnapshot;
  /** The lyrics Now Playing already loaded for this song. */
  lyrics: TrackLyrics | null;
  lyricsStatus?: LyricsStatus;
  onClose: () => void;
}

/** "SimpMusic · word", or "none" when there are no lyrics to time. */
function lyricsLabel(lyrics: TrackLyrics | null, status: LyricsStatus | undefined): string {
  if (status === "loading") return "loading…";
  if (!lyrics || lyrics.lines.length === 0 || lyrics.syncType === "unavailable") return "none";
  const provider = lyrics.source && lyrics.source !== "unavailable" ? lyrics.source : null;
  return provider ? `${provider} · ${lyrics.syncType}` : lyrics.syncType;
}

function percent(fraction: number | null): string {
  if (fraction === null) return "—";
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

/**
 * The technical panel: only what the player actually reports. There is deliberately no
 * bitrate row claiming a number the YouTube player never gives us.
 */
export const StatsForNerds = memo(function StatsForNerds({
  getStats,
  lyrics,
  lyricsStatus,
  onClose,
}: StatsForNerdsProps) {
  const [stats, setStats] = useState<DeckStatsSnapshot>(getStats);

  // Refresh only while the panel is mounted; the view mounts it only while it is open.
  useEffect(() => {
    setStats(getStats());
    const timer = window.setInterval(() => setStats(getStats()), 1000);
    return () => window.clearInterval(timer);
  }, [getStats]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const deck = stats.deck;
  const deckLabel = stats.deckLabel
    ? stats.crossfading
      ? `${stats.deckLabel} · crossfading`
      : stats.deckLabel
    : "—";
  const rows: Array<[string, string]> = [
    ["Source", deck ? (deck.source === "youtube" ? "YouTube" : deck.source) : "—"],
    ["Video ID", deck?.videoId ?? "—"],
    ["Deck", deckLabel],
    ["Playback speed", deck ? formatRate(deck.rate) : "—"],
    // Buffered and quality only when the player reports them (the bridge player doesn't).
    ...(deck?.loadedFraction != null ? [["Buffered", percent(deck.loadedFraction)] as [string, string]] : []),
    ...(deck?.quality ? [["Quality", deck.quality] as [string, string]] : []),
    // Times playback stalled after the song started (the initial load isn't counted).
    ["Stalls", deck ? String(deck.bufferingEvents) : "—"],
    ["Lyrics", lyricsLabel(lyrics, lyricsStatus)],
    ["Audio", "YouTube stream · bitrate not exposed by the player"],
  ];

  return (
    <div className="np-stats" role="dialog" aria-label="Stats for nerds">
      <div className="np-stats-head">
        <span className="np-stats-title">Stats for nerds</span>
        <button type="button" className="np-stats-close" onClick={onClose} aria-label="Close stats" title="Close (Esc)">
          ×
        </button>
      </div>
      <dl className="np-stats-rows">
        {rows.map(([label, value]) => (
          <div className="np-stats-row" key={label}>
            <dt>{label}</dt>
            <dd title={value}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
});
