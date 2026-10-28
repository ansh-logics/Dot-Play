import { useEffect, useMemo, useRef, useState } from "react";
import { fetchLyricsMultiProvider, type TrackLyrics } from "../lib/lyrics";
import { activeRowIndex, buildLyricRows } from "../components/now-playing/lyricRows";
import { media, type NowPlaying } from "./types";

interface LyricsViewProps {
  np: NowPlaying;
  position: number;
}

/**
 * Line-synced lyrics for the popover. Loaded only when this view is opened (it's a lazy
 * chunk); `get_lyrics` serves repeat songs from the on-disk cache. Line-level highlight
 * only, so it stays near idle on the CPU.
 */
export default function LyricsView({ np, position }: LyricsViewProps) {
  const key = np.videoId ?? `${np.title}::${np.artist}`;
  const [result, setResult] = useState<{ key: string; data: TrackLyrics | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchLyricsMultiProvider(np.title, np.artist, np.duration || undefined, np.videoId ?? undefined)
      .then((data) => !cancelled && setResult({ key, data }))
      .catch(() => !cancelled && setResult({ key, data: null }));
    return () => {
      cancelled = true;
    };
    // A repeat call for the same track is answered from lyrics.ts's in-memory cache.
  }, [key, np.title, np.artist, np.duration, np.videoId]);

  const data = result?.key === key ? result.data : null;
  const synced = data && data.syncType !== "plain" && data.syncType !== "unavailable";
  const rows = useMemo(() => (synced && data ? buildLyricRows(data.lines) : []), [synced, data]);
  const active = synced ? activeRowIndex(rows, position) : -1;

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-row="${active}"]`);
    if (!list || !el) return;
    // Scroll only the list (scrollIntoView would also scroll any page embedding the player).
    const box = list.getBoundingClientRect();
    const row = el.getBoundingClientRect();
    list.scrollTo({ top: list.scrollTop + row.top - box.top - (box.height - row.height) / 2, behavior: "smooth" });
  }, [active]);

  if (!result || result.key !== key) {
    return <div className="tray-panel tray-panel--empty"><p className="tray-panel-empty-sub">Loading lyrics…</p></div>;
  }
  if (!data || data.lines.length === 0 || data.syncType === "unavailable") {
    return <div className="tray-panel tray-panel--empty"><p className="tray-panel-empty-title">No lyrics</p></div>;
  }

  if (!synced) {
    return (
      <div className="tray-panel tray-lyrics tray-lyrics--plain">
        {data.lines.map((line) => (
          <p key={line.id} className="tray-lyric">{line.text}</p>
        ))}
      </div>
    );
  }

  return (
    <div className="tray-panel tray-lyrics" ref={listRef}>
      {rows.map((row, index) =>
        row.kind === "interlude" ? (
          <p key={row.key} data-row={index} className={`tray-lyric tray-lyric--dots${index === active ? " is-active" : ""}`}>
            •••
          </p>
        ) : (
          <button
            key={row.key}
            type="button"
            data-row={index}
            className={`tray-lyric${index === active ? " is-active" : index < active ? " is-past" : ""}`}
            onClick={() => media({ action: "seek", position: row.start })}
          >
            {row.line.text}
            {row.line.background?.text && <span className="tray-lyric-bg">{row.line.background.text}</span>}
          </button>
        ),
      )}
    </div>
  );
}
