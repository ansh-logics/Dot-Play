import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { asPlain, type LyricWord, type TrackLyrics } from "../../lib/lyrics";
import type { LyricsStatus } from "./useLyrics";
import { activeRowIndex, buildLyricRows, type LyricRow } from "./lyricRows";
import { useFrameLoop, useLyricClock } from "./useLyricClock";
import { sampleSpring, SPRING_DURATION_S, springKeyframes, type SpringState } from "./lyricSpring";
import { formatOffset, OFFSET_STEP_S } from "../../lib/lyricOffsets";
import { useLyricOffset, usePlainPreference } from "./lyricsPreferences";

interface LyricsPanelProps {
  data: TrackLyrics | null;
  status: LyricsStatus;
  currentTime: number;
  isPlaying: boolean;
  onSeek: (seconds: number) => void;
  reduceMotion: boolean;
  /** Hidden behind the open queue sheet: skip the per-frame letter writes. */
  paused?: boolean;
  /** The song, so a choice to read its lyrics as plain text is remembered for it. */
  trackKey?: string;
}

const USER_SCROLL_PAUSE_MS = 3500;
/**
 * The view starts moving to the next line this long before it is sung, so the (smooth) scroll
 * lands as the line starts instead of chasing it. The highlight itself still changes on time.
 */
const SCROLL_LEAD_S = 0.4;
/** Rows behind the move (below it going forward, above it going back) start this much later
 *  each, up to GLIDE_STAGGER_ROWS, so the lines follow one another instead of moving as a block. */
const GLIDE_STAGGER_S = 0.05;
const GLIDE_STAGGER_ROWS = 4;

/** Each row's spring while it moves: where it started, how fast, and its stagger. */
const rowSprings = new WeakMap<HTMLElement, { animation: Animation } & SpringState & { delay: number }>();

/** A row's painted vertical offset ("0px 12px" → 12): the compositor can be ahead of JS. */
function paintedOffset(el: HTMLElement): number | null {
  const value = getComputedStyle(el).translate;
  if (!value || value === "none") return null;
  const parts = value.split(" ");
  return parts.length > 1 ? Number.parseFloat(parts[1]) || 0 : 0;
}

/**
 * Moves the lyrics so `top` is the scroll position. The scroll position jumps, invisibly:
 * every row is shifted back by the same amount, then springs to its place (lyricSpring.ts).
 * A row still moving from the last line change keeps its position, speed and remaining
 * stagger, so quick lines flow on instead of restarting.
 */
function glideTo(container: HTMLElement, top: number, focusIdx: number, animate: boolean) {
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-row]"));
  const stopAll = () =>
    rows.forEach((el) => {
      const run = rowSprings.get(el);
      if (run) {
        run.animation.cancel();
        rowSprings.delete(el);
        el.style.removeProperty("will-change");
      }
    });
  const currentTop = container.scrollTop;
  const forward = top >= currentTop;
  const retargeting = rows.some((el) => rowSprings.has(el));

  // Read every row's pose before anything is cancelled or scrolled.
  const poses = rows.map((el) => {
    const run = rowSprings.get(el);
    if (!run) {
      const row = Number(el.dataset.row);
      const steps = forward ? row - focusIdx : focusIdx - row;
      const delay = !retargeting && steps > 0 ? Math.min(steps, GLIDE_STAGGER_ROWS) * GLIDE_STAGGER_S : 0;
      return { el, position: 0, velocity: 0, delay, moving: false };
    }
    const elapsed = Number(run.animation.currentTime ?? 0) / 1000;
    const pose = sampleSpring(run.position, run.velocity, Math.max(0, elapsed - run.delay));
    return {
      el,
      position: paintedOffset(el) ?? pose.position,
      velocity: pose.velocity,
      // Keep an in-flight cascade's remaining waits; a settled row doesn't start a new one.
      delay: Math.max(0, run.delay - elapsed),
      moving: true,
    };
  });
  // Moving rows add to the scroll range; measure it without them.
  stopAll();
  const target = Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
  const delta = target - currentTop;

  // Instant: reduced motion, or a jump too far to read as a move (a seek, a new song).
  if (!animate || Math.abs(delta) > container.clientHeight * 1.5) {
    container.scrollTop = target;
    return;
  }
  if (Math.abs(delta) < 0.5 && !poses.some((p) => p.moving)) return;

  // Only rows in the swept view (or already moving) need a spring.
  const viewStart = Math.min(currentTop, target) - 200;
  const viewEnd = Math.max(currentTop, target) + container.clientHeight + 200;
  const started: Animation[] = [];
  for (const { el, position: from, velocity, delay, moving } of poses) {
    const position = from + delta;
    const offscreen = el.offsetTop + el.offsetHeight < viewStart || el.offsetTop > viewEnd;
    if ((!moving && offscreen) || (Math.abs(position) < 0.1 && Math.abs(velocity) < 0.1)) continue;
    el.style.setProperty("will-change", "translate");
    const animation = el.animate(springKeyframes(position, velocity), {
      duration: SPRING_DURATION_S * 1000,
      delay: delay * 1000,
      fill: "both",
      easing: "linear",
    });
    animation.pause();
    animation.currentTime = 0;
    rowSprings.set(el, { animation, position, velocity, delay });
    animation.onfinish = () => {
      if (rowSprings.get(el)?.animation !== animation) return;
      animation.cancel();
      rowSprings.delete(el);
      el.style.removeProperty("will-change");
    };
    started.push(animation);
  }
  // Shift the rows and scroll in the same frame, then let the springs run.
  container.scrollTop = target;
  started.forEach((animation) => animation.play());
}
/** Words held at least this long get a faint glow while sung (Apple's emphasis on long notes). */
const HELD_WORD_S = 1;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Scripts whose letters combine or join while being shaped: Indic vowel signs and conjuncts,
 * Arabic joining, Thai/Khmer clusters, RTL ordering. Splitting their words into per-letter
 * boxes breaks the shaping (stray marks get drawn on dotted circles), so such words stay whole
 * and the fill sweeps across them instead.
 */
const SHAPED_SCRIPT =
  /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Tibetan}\p{Script=Myanmar}\p{Script=Khmer}\p{Script=Mongolian}]/u;
const RTL_SCRIPT = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Hebrew}]/u;

const graphemes =
  typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** Visible characters (grapheme clusters), so accents and emoji aren't torn apart. */
const splitLetters = (text: string) =>
  graphemes ? Array.from(graphemes.segment(text), (s) => s.segment) : Array.from(text);

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
              {!letters ? (
                body
              ) : SHAPED_SCRIPT.test(body) ? (
                // One "letter" for the whole word: the sweep runs across it as a gradient.
                <span className={`np-ch np-ch--whole ${RTL_SCRIPT.test(body) ? "is-rtl" : ""}`} aria-hidden="true">
                  {body}
                </span>
              ) : (
                splitLetters(body).map((ch, c) => (
                  <span key={c} className="np-ch" aria-hidden="true">
                    {ch}
                  </span>
                ))
              )}
            </span>
          </Fragment>
        );
      })}
    </>
  );
}

export function LyricsPanel({
  data: sourceData,
  status: sourceStatus,
  currentTime,
  isPlaying,
  onSeek,
  reduceMotion,
  paused = false,
  trackKey,
}: LyricsPanelProps) {
  // Synced lyrics can be off for some songs; the listener may read them as plain text.
  const [preferPlain, togglePlain] = usePlainPreference(trackKey);
  const [offset, setOffset] = useLyricOffset(trackKey);
  const canChoose = sourceStatus === "synced" && Boolean(sourceData) && Boolean(trackKey);
  const showPlain = canChoose && preferPlain;
  const data = useMemo(() => (showPlain && sourceData ? asPlain(sourceData) : sourceData), [showPlain, sourceData]);
  const status: LyricsStatus = showPlain ? "plain" : sourceStatus;
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrollUntil = useRef(0);
  const synced = status === "synced";
  const rows = useMemo<LyricRow[]>(() => {
    const lines = data?.lines ?? [];
    return synced
      ? buildLyricRows(lines)
      : lines.map((line) => ({ kind: "line" as const, key: `line-${line.id}`, start: line.startTime, line }));
  }, [data, synced]);

  // The song's position as the lyrics see it, nudged by the listener's per-song offset.
  const lyricTime = currentTime + (synced ? offset : 0);
  const activeIdx = synced ? activeRowIndex(rows, lyricTime) : -1;
  // Before anything has started, frame the upcoming row (intro dots or the first line). While
  // playing, the frame moves a moment early (SCROLL_LEAD_S).
  const leadIdx = synced && isPlaying ? activeRowIndex(rows, lyricTime + SCROLL_LEAD_S) : activeIdx;
  const focusIdx = synced ? Math.max(leadIdx, activeIdx, 0) : -1;
  // Scrolling the lyrics by hand: auto-follow pauses and every line is readable, not dimmed.
  const [browsing, setBrowsing] = useState(false);
  const browseTimer = useRef<number | null>(null);

  // ---- Scrolling ------------------------------------------------------------
  const centreFocus = useCallback(
    (behavior: ScrollBehavior) => {
      const container = scrollRef.current;
      if (!container || focusIdx < 0 || Date.now() < userScrollUntil.current) return;
      const el = container.querySelector<HTMLElement>(`[data-row="${focusIdx}"]`);
      if (!el) return;
      const top = el.offsetTop - container.clientHeight * 0.4 + el.clientHeight / 2;
      glideTo(container, top, focusIdx, behavior === "smooth");
    },
    [focusIdx],
  );

  // Back to following the song once the listener stops scrolling.
  const browse = useCallback(() => {
    userScrollUntil.current = Date.now() + USER_SCROLL_PAUSE_MS;
    setBrowsing(true);
    if (browseTimer.current) window.clearTimeout(browseTimer.current);
    browseTimer.current = window.setTimeout(() => {
      browseTimer.current = null;
      // Clear the pause first, or the re-centre below would still see it.
      userScrollUntil.current = 0;
      setBrowsing(false);
    }, USER_SCROLL_PAUSE_MS);
  }, []);
  useEffect(() => () => {
    if (browseTimer.current) window.clearTimeout(browseTimer.current);
  }, []);
  useEffect(() => {
    if (!browsing) centreFocus(reduceMotion ? "auto" : "smooth");
    // Only when browsing ends; following the line otherwise is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browsing]);

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
  const clockNow = useLyricClock(currentTime, isPlaying);
  const appliedOffset = synced ? offset : 0;
  const now = useCallback(() => clockNow() + appliedOffset, [clockNow, appliedOffset]);
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

  const looping = animates && isPlaying && !paused;
  useFrameLoop(draw, looping);
  // Paused (e.g. scrubbing while paused): no frame loop, so redraw on each time update instead.
  useEffect(() => {
    if (!looping && !paused) draw();
  }, [currentTime, looping, paused, draw]);

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
    <div className="np-lyrics-shell">
      <div
        ref={scrollRef}
        className={`np-lyrics ${synced ? "is-synced" : "is-plain"} ${synced && browsing ? "is-browsing" : ""}`}
        onWheel={browse}
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
          // Duets: the other voice's lines sit on the far side.
          const end = synced && line.side === "end";
          return (
            <p
              key={row.key}
              data-row={idx}
              className={`np-lyric np-lyric--${state} ${end ? "np-lyric--end" : ""}`}
              onClick={synced ? () => onSeek(Math.max(0, line.startTime - offset)) : undefined}
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
      {canChoose && (
        <div className={`np-lyrics-tools ${offset !== 0 ? "has-offset" : ""}`}>
          {synced && (
            <div className="np-lyrics-offset" role="group" aria-label="Lyrics timing for this song">
              <button
                type="button"
                onClick={() => setOffset(offset - OFFSET_STEP_S)}
                aria-label="Show lyrics later"
                title="Lyrics later"
              >
                −
              </button>
              <button
                type="button"
                className="np-lyrics-offset-value"
                onClick={() => setOffset(0)}
                disabled={offset === 0}
                aria-label={offset === 0 ? "Lyrics timing as found" : `Lyrics timing ${formatOffset(offset)}; reset`}
                title={offset === 0 ? "Lyrics timing as found" : "Reset timing"}
              >
                {formatOffset(offset)}
              </button>
              <button
                type="button"
                onClick={() => setOffset(offset + OFFSET_STEP_S)}
                aria-label="Show lyrics sooner"
                title="Lyrics sooner"
              >
                +
              </button>
            </div>
          )}
          <button type="button" className="np-lyrics-mode" onClick={togglePlain}>
            {showPlain ? "Show synced lyrics" : "Out of sync? Show as text"}
          </button>
        </div>
      )}
    </div>
  );
}
