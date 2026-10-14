import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import type { LyricWord, TrackLyrics } from "../../lib/lyrics";
import type { LyricsStatus } from "./useLyrics";
import { activeRowIndex, buildLyricRows, type LyricRow } from "./lyricRows";
import { useFrameLoop, useLyricClock } from "./useLyricClock";

interface LyricsPanelProps {
  data: TrackLyrics | null;
  status: LyricsStatus;
  currentTime: number;
  isPlaying: boolean;
  onSeek: (seconds: number) => void;
  reduceMotion: boolean;
}

const USER_SCROLL_PAUSE_MS = 3500;
/** Words held at least this long get a faint glow while sung (Apple's emphasis on long notes). */
const HELD_WORD_S = 1;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Timed words. On the active line each word is split into letter spans so the sweep can
 * fill and lift letter by letter; elsewhere words stay plain text (cheap, and identical wrap).
 */
function TimedWords({ words, letters }: { words: LyricWord[]; letters: boolean }) {
  return (
    <>
      {words.map((word, w) => {
        const held = word.endTime - word.startTime >= HELD_WORD_S;
        const lead = word.text.match(/^\s*/)?.[0] ?? "";
        const body = word.text.slice(lead.length);
        // The space goes *outside* the inline-block word, so a wrapped line doesn't start indented.
        return (
          <Fragment key={w}>
            {lead}
            <span className={`np-word ${held ? "is-held" : ""}`} aria-label={letters ? body : undefined}>
              {letters
                ? Array.from(body).map((ch, c) => (
                    <span key={c} className="np-ch" aria-hidden="true">
                      {ch}
                    </span>
                  ))
                : body}
            </span>
          </Fragment>
        );
      })}
    </>
  );
}

export function LyricsPanel({ data, status, currentTime, isPlaying, onSeek, reduceMotion }: LyricsPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrollUntil = useRef(0);
  const synced = status === "synced";
  const rows = useMemo<LyricRow[]>(() => {
    const lines = data?.lines ?? [];
    return synced
      ? buildLyricRows(lines)
      : lines.map((line) => ({ kind: "line" as const, key: `line-${line.id}`, start: line.startTime, line }));
  }, [data, synced]);

  const activeIdx = synced ? activeRowIndex(rows, currentTime) : -1;
  // Before anything has started, frame the upcoming row (intro dots or the first line).
  const focusIdx = synced ? Math.max(activeIdx, 0) : -1;

  // ---- Scrolling ------------------------------------------------------------
  const centreFocus = useCallback(
    (behavior: ScrollBehavior) => {
      const container = scrollRef.current;
      if (!container || focusIdx < 0 || Date.now() < userScrollUntil.current) return;
      const el = container.querySelector<HTMLElement>(`[data-row="${focusIdx}"]`);
      if (!el) return;
      const top = el.offsetTop - container.clientHeight * 0.4 + el.clientHeight / 2;
      container.scrollTo({ top: Math.max(0, top), behavior });
    },
    [focusIdx],
  );

  // New song: never inherit the previous song's scroll position.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    userScrollUntil.current = 0;
    container.scrollTop = 0;
    centreFocus("auto");
    // Only on new lyrics; following the active line is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    centreFocus(reduceMotion ? "auto" : "smooth");
  }, [centreFocus, reduceMotion]);

  // Lines rewrap when the web font arrives or the column resizes; re-centre instantly so a
  // paused song doesn't sit with its current line off-centre.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const recentre = () => centreFocus("auto");
    const ro = new ResizeObserver(recentre);
    ro.observe(container);
    document.fonts?.addEventListener("loadingdone", recentre);
    void document.fonts?.ready.then(recentre);
    return () => {
      ro.disconnect();
      document.fonts?.removeEventListener("loadingdone", recentre);
    };
  }, [centreFocus, status]);

  // ---- Per-frame word sweep / interlude progress -----------------------------
  const now = useLyricClock(currentTime, isPlaying);
  const activeRow = activeIdx >= 0 ? rows[activeIdx] : undefined;
  // Lead words then backing-vocal words: the same order their spans appear in the DOM.
  const activeWords = useMemo(
    () =>
      activeRow?.kind === "line" && (activeRow.line.words?.length || activeRow.line.background?.words?.length)
        ? [...(activeRow.line.words ?? []), ...(activeRow.line.background?.words ?? [])]
        : undefined,
    [activeRow],
  );
  const animates = synced && (activeRow?.kind === "interlude" || Boolean(activeWords?.length));

  const draw = useCallback(() => {
    const container = scrollRef.current;
    if (!container || !activeRow) return;
    const el = container.querySelector<HTMLElement>(`[data-row="${activeIdx}"]`);
    if (!el) return;
    const t = now();
    if (activeRow.kind === "interlude") {
      el.style.setProperty("--p", clamp01((t - activeRow.start) / (activeRow.end - activeRow.start)).toFixed(4));
      return;
    }
    if (!activeWords) return;
    const spans = el.querySelectorAll<HTMLElement>(".np-word");
    activeWords.forEach((word, i) => {
      const span = spans[i];
      if (!span) return;
      const len = Math.max(word.endTime - word.startTime, 0.05);
      const p = clamp01((t - word.startTime) / len);
      const chars = span.querySelectorAll<HTMLElement>(".np-ch");
      const n = chars.length;
      // Letter j fills over its 1/n share of the word: l = clamp(p·n − j). The rise follows
      // sin(π·l), peaking mid-fill and settling, so a small wave travels through the word.
      for (let j = 0; j < n; j++) {
        const l = clamp01(p * n - j);
        const st = chars[j].style;
        st.setProperty("--l", l.toFixed(3));
        st.setProperty("--ls", l >= 0.5 ? "1" : "0");
        st.setProperty("--r", reduceMotion ? "0" : Math.sin(Math.PI * l).toFixed(3));
      }
    });
  }, [activeIdx, activeRow, activeWords, now, reduceMotion]);

  const looping = animates && isPlaying;
  useFrameLoop(draw, looping);
  // Paused (e.g. scrubbing while paused): no frame loop, so redraw on each time update instead.
  useEffect(() => {
    if (!looping) draw();
  }, [currentTime, looping, draw]);

  // ---- Render ------------------------------------------------------------------
  if (status === "loading") {
    return (
      <div className="np-lyrics-state" aria-live="polite">
        <span className="np-lyrics-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        Finding lyrics…
      </div>
    );
  }

  if (status === "unavailable" || status === "idle") {
    return (
      <div className="np-lyrics-state" aria-live="polite">
        {data?.source === "instrumental" ? "Instrumental" : "No lyrics for this track"}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className={`np-lyrics ${synced ? "is-synced" : "is-plain"}`}
      onWheel={() => {
        userScrollUntil.current = Date.now() + USER_SCROLL_PAUSE_MS;
      }}
      aria-label="Lyrics"
    >
      <div className="np-lyrics-pad" aria-hidden="true" />
      {rows.map((row, idx) => {
        const distance = Math.abs(idx - focusIdx);
        const isActive = idx === activeIdx;

        if (row.kind === "interlude") {
          return (
            <div
              key={row.key}
              data-row={idx}
              className={`np-interlude ${isActive ? "is-active" : ""}`}
              aria-hidden="true"
            >
              <span className="np-interlude-dots">
                {[0, 1, 2].map((i) => (
                  <i key={i} style={{ "--i": i } as CSSProperties} />
                ))}
              </span>
            </div>
          );
        }

        const { line } = row;
        const state = !synced ? "plain" : isActive ? "active" : distance <= 1 ? "near" : distance === 2 ? "mid" : "far";
        return (
          <p
            key={row.key}
            data-row={idx}
            className={`np-lyric np-lyric--${state}`}
            onClick={synced ? () => onSeek(line.startTime) : undefined}
          >
            {synced && line.words && line.words.length > 0 ? (
              <TimedWords words={line.words} letters={isActive} />
            ) : (
              line.text
            )}
            {line.background && (
              <span className="np-bg">
                {synced && line.background.words && line.background.words.length > 0 ? (
                  <TimedWords words={line.background.words} letters={isActive} />
                ) : (
                  line.background.text
                )}
              </span>
            )}
          </p>
        );
      })}
      <div className="np-lyrics-pad" aria-hidden="true" />
    </div>
  );
}
