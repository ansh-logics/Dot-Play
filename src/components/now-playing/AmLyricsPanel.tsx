import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AmLyrics } from "@uimaxbai/am-lyrics";
import { asPlain, type TrackLyrics } from "../../lib/lyrics";
import { formatOffset, OFFSET_STEP_S } from "../../lib/lyricOffsets";
import type { LyricsStatus } from "./useLyrics";
import { useFrameLoop, useLyricClock } from "./useLyricClock";
import { useLyricOffset, usePlainPreference, useRomanizePreference, useTranslatePreference } from "./lyricsPreferences";
import { ALTERNATES_SUPPORTED, translationNote } from "../../lib/lyricAlternates";
import { useLyricAlternates } from "./useLyricAlternates";
import { lyricsToTtml } from "./lyricsTtml";

/**
 * Now Playing's lyrics column, drawn by am-lyrics (github.com/uimaxbai/am-lyrics, MPL-2.0),
 * the Apple-Music-style component BitChord uses: spring-driven line motion, word wipe,
 * duets and backing vocals. DOT Music still finds the lyrics; am-lyrics only shows them, from
 * the TTML handed to it (lyricsTtml.ts), so it never fetches anything itself. Romanization
 * and translation come from the Mac itself (lyricAlternates.ts) and ride along in that TTML.
 */

/** am-lyrics' caption switches: private in its types, but plain reactive properties. */
type CaptionSwitches = { showRomanization: boolean; showTranslation: boolean };

interface AmLyricsPanelProps {
  data: TrackLyrics | null;
  status: LyricsStatus;
  currentTime: number;
  isPlaying: boolean;
  onSeek: (seconds: number) => void;
  reduceMotion: boolean;
  /** Hidden behind the open queue sheet: stop feeding it time. */
  paused?: boolean;
  trackKey?: string;
  /** The timing nudge and "show as text" switch (Now Playing has them; immersive doesn't). */
  tools?: boolean;
  /** Extra rules for am-lyrics' shadow root, after DOT Music's own (sizes, spacing). */
  shadowCss?: string;
  /** Font for the lines; the app's heading font when not given. */
  fontFamily?: string;
  /** Extra class on the outer box. */
  className?: string;
  /** Opens the "Wrong lyrics?" source picker; left out where it can't be shown. */
  onOpenLyricsPicker?: () => void;
}

/**
 * Inside am-lyrics' shadow root:
 * - its toolbar (romanise, translate, download) goes: translation would use Google's
 *   unofficial endpoint, and DOT Music picks the lyrics itself;
 * - its footer stays in the layout but unseen (it measures its scroll range to the footer;
 *   removing it stops the lyrics following the song);
 * - the lines around the current one are dimmed further than am-lyrics does (0.8 down to
 *   0.5, then 0.4, 0.32 and 0.26 for the rest): without its blur, the next line in a light
 *   colour (Vinyl's cream) read as bright as the one being sung;
 * - a caption keeps its line break (romanized line above the translated one);
 * - sizes follow DOT Music's lyrics column, with the current line about a third down.
 */
const SHADOW_CSS = `
.lyrics-header { display: none !important; }
.lyrics-footer { visibility: hidden !important; pointer-events: none !important; }
.lyrics-translation-container { white-space: pre-line; }
.lyrics-container .lyrics-line:not(.active):not(.pre-active):not(.lyrics-gap) { opacity: 0.26; }
.lyrics-container .lyrics-line.next-active-line:not(.active):not(.pre-active):not(.lyrics-gap),
.lyrics-container .lyrics-line.post-active-line:not(.active):not(.pre-active):not(.lyrics-gap),
.lyrics-container .lyrics-line.lyrics-activest:not(.active):not(.pre-active):not(.lyrics-gap) { opacity: 0.5; }
.lyrics-container .lyrics-line.prev-2:not(.active):not(.pre-active),
.lyrics-container .lyrics-line.next-2:not(.active):not(.pre-active) { opacity: 0.4; }
.lyrics-container .lyrics-line.prev-3:not(.active):not(.pre-active),
.lyrics-container .lyrics-line.next-3:not(.active):not(.pre-active) { opacity: 0.32; }
.lyrics-container {
  --lyplus-font-size-base: clamp(22px, 2.6vw, 40px);
  --am-lyrics-line-height: 1.18;
  --am-lyrics-line-spacing: calc(clamp(22px, 2.6vw, 40px) * 0.62);
  --lyrics-scroll-padding-top: 34%;
  --am-lyrics-inline-padding: 0px;
}
`;

let loadElement: Promise<unknown> | null = null;
/** Loads (and registers) am-lyrics the first time lyrics are shown: about 170 KB. */
function ensureElement(): Promise<unknown> {
  loadElement ??= import("@uimaxbai/am-lyrics/am-lyrics.js").then(() => customElements.whenDefined("am-lyrics"));
  return loadElement;
}

function appFont(): string {
  const font = getComputedStyle(document.documentElement).getPropertyValue("--font-heading").trim();
  return font || "-apple-system, BlinkMacSystemFont, sans-serif";
}

export function AmLyricsPanel({
  data: sourceData,
  status: sourceStatus,
  currentTime,
  isPlaying,
  onSeek,
  reduceMotion,
  paused = false,
  trackKey,
  tools = true,
  shadowCss = "",
  fontFamily,
  className,
  onOpenLyricsPicker,
}: AmLyricsPanelProps) {
  const [preferPlain, togglePlain] = usePlainPreference(trackKey);
  const [offset, setOffset] = useLyricOffset(trackKey);
  const canChoose = sourceStatus === "synced" && Boolean(sourceData) && Boolean(trackKey);
  const showPlain = canChoose && preferPlain;
  const data = useMemo(() => (showPlain && sourceData ? asPlain(sourceData) : sourceData), [showPlain, sourceData]);
  const status: LyricsStatus = showPlain ? "plain" : sourceStatus;
  const synced = status === "synced";
  const [romanizeOn, toggleRomanize] = useRomanizePreference(trackKey);
  const [translateOn, toggleTranslate] = useTranslatePreference(trackKey);
  const alternates = useLyricAlternates(data, ALTERNATES_SUPPORTED && translateOn);
  const romanized = romanizeOn ? alternates.romanized : null;
  const translations = translateOn && alternates.translation?.status === "translated" ? alternates.translation.lines : null;
  const ttml = useMemo(
    () => (data && data.lines.length > 0 ? lyricsToTtml(data, { romanized, translations }) : null),
    [data, romanized, translations],
  );
  const visible = (status === "synced" || status === "plain") && ttml !== null;

  const host = useRef<HTMLDivElement>(null);
  /** The <am-lyrics> element, once created; `ready` re-renders when it exists. */
  const elementRef = useRef<AmLyrics | null>(null);
  const [ready, setReady] = useState(false);

  // Latest values for the element's event handler and its creation, which outlive renders.
  const seekRef = useRef({ onSeek, offset: synced ? offset : 0 });
  const ttmlRef = useRef(ttml);
  const lookRef = useRef({ shadowCss, fontFamily });
  useEffect(() => {
    seekRef.current = { onSeek, offset: synced ? offset : 0 };
    ttmlRef.current = ttml;
    lookRef.current = { shadowCss, fontFamily };
  });

  // Created by hand with its lyrics already set: am-lyrics starts loading the moment it is
  // attached, and with no lyrics it would ask its own providers (and could overwrite ours).
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let el: AmLyrics | null = null;
    const onLineClick = (event: Event) => {
      const ms = (event as CustomEvent<{ timestamp?: number }>).detail?.timestamp;
      if (typeof ms !== "number" || !Number.isFinite(ms)) return;
      const { onSeek: seek, offset: nudge } = seekRef.current;
      seek(Math.max(0, ms / 1000 - nudge));
    };
    void ensureElement().then(() => {
      if (disposed || !host.current) return;
      el = document.createElement("am-lyrics") as AmLyrics;
      el.ttml = ttmlRef.current ?? undefined;
      el.noAutoAlternates = true;
      // Captions (romanization and translation, both in the translation block) show whenever
      // the TTML carries them; with noAutoAlternates it never asks Google for its own.
      Object.assign(el as unknown as CaptionSwitches, { showRomanization: false, showTranslation: true });
      // No blur on the lines around the current one: WebKit draws a coloured seam along the
      // edge of a blurred line (the same reason LyricsPanel dims with opacity only). The
      // dimming stays; only the softening goes.
      el.noBlur = true;
      el.autoScroll = true;
      el.interpolate = true;
      el.highlightColor = "#ffffff";
      el.fontFamily = lookRef.current.fontFamily || appFont();
      el.className = "np-am-lyrics";
      el.addEventListener("line-click", onLineClick);
      host.current.append(el);
      void el.updateComplete.then(() => {
        const root = el?.shadowRoot;
        if (!root || disposed) return;
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(SHADOW_CSS + lookRef.current.shadowCss);
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      });
      elementRef.current = el;
      setReady(true);
    });
    return () => {
      disposed = true;
      el?.removeEventListener("line-click", onLineClick);
      el?.remove();
      elementRef.current = null;
      setReady(false);
    };
  }, [visible]);

  // New lyrics (another song, or plain/synced switched) go to the same element.
  useEffect(() => {
    const el = elementRef.current;
    if (ready && el && ttml && el.ttml !== ttml) el.ttml = ttml;
  }, [ready, ttml]);

  useEffect(() => {
    const el = elementRef.current;
    if (ready && el) el.reducedMotion = reduceMotion;
  }, [ready, reduceMotion]);

  // Time, in milliseconds, from the same steered clock the rest of the player uses, nudged by
  // the listener's per-song offset. Every frame while playing; once on each change otherwise.
  const clockNow = useLyricClock(currentTime, isPlaying);
  const appliedOffset = synced ? offset : 0;
  const draw = useCallback(() => {
    const el = elementRef.current;
    if (!ready || !el) return;
    el.paused = !isPlaying;
    el.currentTime = Math.max(0, (clockNow() + appliedOffset) * 1000);
  }, [ready, isPlaying, clockNow, appliedOffset]);
  const running = ready && isPlaying && !paused;
  useFrameLoop(draw, running);
  useEffect(() => {
    if (!running) draw();
  }, [currentTime, running, draw]);

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

  if (!visible) {
    return (
      <div className="np-lyrics-state" aria-live="polite">
        {data?.source === "instrumental" ? "Instrumental" : "No lyrics for this track"}
        {tools && trackKey && onOpenLyricsPicker && (
          <button type="button" className="np-lyrics-mode" onClick={onOpenLyricsPicker}>
            Wrong lyrics?
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={className ? `np-lyrics-shell ${className}` : "np-lyrics-shell"}>
      <div ref={host} className="np-am-lyrics-host" aria-label="Lyrics" />
      {tools && trackKey && (canChoose || ALTERNATES_SUPPORTED || onOpenLyricsPicker) && (
        <div className={`np-lyrics-tools ${offset !== 0 ? "has-offset" : ""}`}>
          {translateOn && (alternates.translating || translationNote(alternates.translation)) && (
            <span className="np-lyrics-note" role="status">
              {alternates.translating ? "Translating on this Mac…" : translationNote(alternates.translation)}
            </span>
          )}
          {alternates.romanized && (
            <button type="button" className={`np-lyrics-mode${romanizeOn ? " is-on" : ""}`} aria-pressed={romanizeOn} onClick={toggleRomanize}>
              Romanize
            </button>
          )}
          {ALTERNATES_SUPPORTED && (
            <button type="button" className={`np-lyrics-mode${translateOn ? " is-on" : ""}`} aria-pressed={translateOn} onClick={toggleTranslate}>
              Translate
            </button>
          )}
          {canChoose && synced && (
            <div className="np-lyrics-offset" role="group" aria-label="Lyrics timing for this song">
              <button type="button" onClick={() => setOffset(offset - OFFSET_STEP_S)} aria-label="Show lyrics later" title="Lyrics later">
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
              <button type="button" onClick={() => setOffset(offset + OFFSET_STEP_S)} aria-label="Show lyrics sooner" title="Lyrics sooner">
                +
              </button>
            </div>
          )}
          {canChoose && (
            <button type="button" className="np-lyrics-mode" onClick={togglePlain}>
              {showPlain ? "Show synced lyrics" : "Out of sync? Show as text"}
            </button>
          )}
          {onOpenLyricsPicker && (
            <button type="button" className="np-lyrics-mode" onClick={onOpenLyricsPicker}>
              Wrong lyrics?
            </button>
          )}
        </div>
      )}
    </div>
  );
}
