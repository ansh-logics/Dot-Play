import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { fetchLyricsMultiProvider, type TrackLyrics } from "../lib/lyrics";
import { lyricsPrefsVersion, subscribeLyricsPrefs } from "../lib/lyricsPrefs";
import { activeRowIndex, buildLyricRows } from "../components/now-playing/lyricRows";
import { useFrameLoop, useLyricClock } from "../components/now-playing/useLyricClock";
import { media, type NowPlaying } from "./types";

interface LyricsViewProps {
  np: NowPlaying;
  position: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function subscribeReducedMotion(onStoreChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (mq.addEventListener) {
    mq.addEventListener("change", onStoreChange);
    return () => mq.removeEventListener("change", onStoreChange);
  }
  mq.addListener(onStoreChange);
  return () => mq.removeListener(onStoreChange);
}

function getReducedMotionSnapshot() {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function getReducedMotionServerSnapshot() {
  return false;
}

function subscribeVisibility(onStoreChange: () => void) {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", onStoreChange);
  return () => document.removeEventListener("visibilitychange", onStoreChange);
}

function getVisibilitySnapshot() {
  return typeof document !== "undefined" ? document.hidden : false;
}

function getVisibilityServerSnapshot() {
  return false;
}

/**
 * Line-synced lyrics for the popover with word-by-word karaoke sweep on the active line.
 * Driven by an eased per-frame clock via refs to keep CPU near idle.
 */
export default function LyricsView({ np, position }: LyricsViewProps) {
  const key = np.videoId ?? `${np.title}::${np.artist}`;
  const [result, setResult] = useState<{ key: string; data: TrackLyrics | null } | null>(null);
  // A new provider order or pinned source (chosen in Now Playing) means a different lookup.
  const prefsVersion = useSyncExternalStore(subscribeLyricsPrefs, lyricsPrefsVersion);

  useEffect(() => {
    let cancelled = false;
    fetchLyricsMultiProvider(np.title, np.artist, np.duration || undefined, np.videoId ?? undefined)
      .then((data) => !cancelled && setResult({ key, data }))
      .catch(() => !cancelled && setResult({ key, data: null }));
    return () => {
      cancelled = true;
    };
    // A repeat call for the same track is answered from lyrics.ts's in-memory cache.
  }, [key, np.title, np.artist, np.duration, np.videoId, prefsVersion]);

  const data = result?.key === key ? result.data : null;
  const synced = Boolean(data && data.syncType !== "plain" && data.syncType !== "unavailable");
  const rows = useMemo(() => (synced && data ? buildLyricRows(data.lines) : []), [synced, data]);
  const active = synced ? activeRowIndex(rows, position) : -1;

  const reduceMotion = useSyncExternalStore(subscribeReducedMotion, getReducedMotionSnapshot, getReducedMotionServerSnapshot);
  const isHidden = useSyncExternalStore(subscribeVisibility, getVisibilitySnapshot, getVisibilityServerSnapshot);

  const clockNow = useLyricClock(position, np.isPlaying);

  const activeRow = synced && active >= 0 ? rows[active] : undefined;
  const activeWords = useMemo(
    () =>
      activeRow?.kind === "line" && activeRow.line.words && activeRow.line.words.length > 0
        ? activeRow.line.words
        : null,
    [activeRow],
  );

  const wordSpansRef = useRef<(HTMLElement | null)[]>([]);
  // The fill last written to each word span. Keyed by the element, so spans that remount
  // (a refetch, Reduce Motion toggled) are always written again rather than left dim.
  const lastFill = useRef(new WeakMap<HTMLElement, string>());

  const draw = useCallback(() => {
    if (!activeWords) return;
    const spans = wordSpansRef.current;
    const n = activeWords.length;
    const lastP = lastFill.current;
    const t = clockNow();
    for (let i = 0; i < n; i++) {
      const span = spans[i];
      if (!span) continue;
      const w = activeWords[i];
      const len = Math.max(w.endTime - w.startTime, 0.05);
      const p = clamp01((t - w.startTime) / len);
      const pStr = p <= 0 ? "0" : p >= 1 ? "1" : p.toFixed(3);
      if (lastP.get(span) !== pStr) {
        lastP.set(span, pStr);
        span.style.setProperty("--w", pStr);
      }
    }
  }, [activeWords, clockNow]);

  const looping = Boolean(synced && activeWords && !reduceMotion && np.isPlaying && !isHidden);
  useFrameLoop(draw, looping);

  // Paused or scrubbing while paused: update active row styles once on position change
  useEffect(() => {
    if (!looping) draw();
  }, [position, looping, draw]);

  // Set initial word fills as soon as active row switches
  useEffect(() => {
    draw();
  }, [active, draw]);

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
            {index === active && activeWords && !reduceMotion ? (
              activeWords.map((word, w) => {
                const lead = word.text.match(/^\s*/)?.[0] ?? "";
                const body = word.text.slice(lead.length);
                return (
                  <Fragment key={w}>
                    {lead}
                    <span
                      ref={(el) => {
                        wordSpansRef.current[w] = el;
                      }}
                      className="tray-lyric-word"
                    >
                      {body}
                    </span>
                  </Fragment>
                );
              })
            ) : (
              row.line.text
            )}
            {row.line.background?.text && <span className="tray-lyric-bg">{row.line.background.text}</span>}
          </button>
        ),
      )}
    </div>
  );
}
