import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import {
  AnimatePresence,
  LayoutGroup,
  animate,
  motion,
  useDragControls,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type PanInfo,
} from "motion/react";
import { ListMusic, MessageSquareQuote, Minimize2 } from "lucide-react";
import "./NowPlaying.css";
import { ArtworkImage } from "../ArtworkImage";
import { useArtwork } from "../../lib/imagePipeline";
import { useArtworkPalette } from "../../lib/useArtworkPalette";
import type { SearchResult } from "../../lib/search";
import type { QueueSession } from "../../lib/queueManager";
import type { PlaybackModes } from "../../lib/playbackModes";
import { NowPlayingBackdrop } from "./NowPlayingBackdrop";
import { LyricsPanel } from "./LyricsPanel";
import { ControlDeck } from "./ControlDeck";
import { QueuePanel, type QueueContextMenuHandler } from "./QueuePanel";
import { useLyrics } from "./useLyrics";

export interface NowPlayingProps {
  isOpen: boolean;
  onClose: () => void;
  session: QueueSession;
  isPlaying: boolean;
  isBuffering: boolean;
  isReady: boolean;
  currentTime: number;
  duration: number;
  playbackError: string | null;
  volume: number;
  isMuted: boolean;
  modes: PlaybackModes;
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (seconds: number) => void;
  onToggleMute: () => void;
  onVolumeChange: (volume: number) => void;
  onCycleRepeat: () => void;
  onToggleAutoplay: () => void;
  onToggleShuffle: () => void;
  onSelectTrack: (track: SearchResult) => void;
  onReorderUpcoming: (upcoming: SearchResult[]) => void;
  onRemoveUpcoming: (index: number) => void;
  onClearUpcoming: () => void;
  onPlayNext: (track: SearchResult) => void;
  onAddToQueue: (track: SearchResult) => void;
  onContextMenu?: QueueContextMenuHandler;
}

const SHEET_SPRING = { type: "spring", stiffness: 380, damping: 38, mass: 0.9 } as const;
const FLICK_VELOCITY = 500;
const NO_DRAG = "button, a, input, [role='slider'], [role='tab'], [data-no-sheet-drag]";

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export function NowPlaying(props: NowPlayingProps) {
  return <AnimatePresence>{props.isOpen && props.session.currentTrack && <NowPlayingScreen {...props} />}</AnimatePresence>;
}

function NowPlayingScreen(props: NowPlayingProps) {
  const { session, onClose } = props;
  const track = session.currentTrack!;
  const reduceMotion = useReducedMotion() ?? false;
  const compact = useMediaQuery("(max-width: 819px), (max-height: 599px)");

  const [lyricsOn, setLyricsOn] = useState(() => !window.matchMedia("(max-width: 819px), (max-height: 599px)").matches);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { data: lyrics, status: lyricsStatus } = useLyrics(track, props.duration);
  const hasLyrics = lyricsStatus === "synced" || lyricsStatus === "plain" || lyricsStatus === "loading";
  const showLyrics = lyricsOn && hasLyrics;

  // Same resolution ArtworkImage uses, so colours and letterbox zoom match the pixels on screen.
  const { currentUrl: artworkUrl } = useArtwork({
    sourceUrl: track.thumbnailUrl,
    videoId: track.videoId,
    variant: "hero",
    priority: true,
  });
  const palette = useArtworkPalette(artworkUrl);

  // ---- Sheet geometry -------------------------------------------------------
  const rootRef = useRef<HTMLDivElement>(null);
  const peekRef = useRef<HTMLDivElement>(null);
  const miniRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const [geom, setGeom] = useState({ height: 0, closedY: 0 });
  const y = useMotionValue(10_000);
  const closedYMV = useMotionValue(1);
  const dragControls = useDragControls();
  const measured = geom.height > 0;

  const measure = useCallback(() => {
    // The compact row grows as the sheet opens; it isn't part of the collapsed peek.
    const peek = (peekRef.current?.offsetHeight ?? 140) - (miniRef.current?.offsetHeight ?? 0);
    const vh = window.innerHeight;
    const height = Math.round(Math.max(peek + 220, Math.min(vh * 0.8, 780)));
    const closedY = height - peek;
    setGeom((g) => (g.height === height && g.closedY === closedY ? g : { height, closedY }));
  }, []);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (peekRef.current) ro.observe(peekRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  // Keep the card parked correctly when geometry changes; slide it in on first measure.
  const firstPlacement = useRef(true);
  useLayoutEffect(() => {
    if (!measured) return;
    closedYMV.set(geom.closedY);
    const target = sheetOpen ? 0 : geom.closedY;
    if (firstPlacement.current) {
      firstPlacement.current = false;
      y.set(geom.height);
      if (reduceMotion) y.set(target);
      else animate(y, target, { ...SHEET_SPRING, delay: 0.05 });
    } else {
      y.set(target);
    }
    // sheetOpen intentionally excluded: open/close animate via setSheet below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geom]);

  const setSheet = useCallback(
    (open: boolean, velocity = 0) => {
      setSheetOpen(open);
      const target = open ? 0 : closedYMV.get();
      if (reduceMotion) animate(y, target, { duration: 0.18 });
      else animate(y, target, { ...SHEET_SPRING, velocity });
    },
    [closedYMV, reduceMotion, y],
  );

  const progress = useTransform([y, closedYMV], ([v, c]: number[]) => (c > 0 ? Math.min(1, Math.max(0, 1 - v / c)) : 0));
  const stageOpacity = useTransform(progress, [0, 1], [1, 0.14]);
  const stageScale = useTransform(progress, [0, 1], [1, 0.94]);
  const stageY = useTransform(progress, [0, 1], [0, -28]);
  const miniHeight = useTransform(progress, [0, 1], [0, 76]);
  const miniOpacity = useTransform(progress, [0.45, 1], [0, 1]);
  const queueOpacity = useTransform(progress, [0.25, 0.85], [0, 1]);
  const cardTint = useTransform(progress, [0, 1], ["rgba(255, 255, 255, 0.10)", "rgba(24, 24, 28, 0.42)"]);

  const grabStart = useRef(0);
  const onCardPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(NO_DRAG)) return;
    dragControls.start(e);
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const c = closedYMV.get();
    if (info.velocity.y < -FLICK_VELOCITY) setSheet(true, info.velocity.y);
    else if (info.velocity.y > FLICK_VELOCITY) setSheet(false, info.velocity.y);
    else setSheet(y.get() < c / 2, info.velocity.y);
  };

  // Trackpad: two-finger swipe up on the collapsed card opens it; overscrolling
  // the top of the open list closes it.
  const wheelAccum = useRef(0);
  const wheelTimer = useRef<number | null>(null);
  const onCardWheel = (e: WheelEvent<HTMLDivElement>) => {
    const list = (e.target as HTMLElement).closest<HTMLElement>(".np-queue-list");
    if (sheetOpen && list && list.scrollTop > 0) return;
    if (sheetOpen && list && e.deltaY > 0) return;
    wheelAccum.current += e.deltaY;
    if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(() => (wheelAccum.current = 0), 180);
    if (!sheetOpen && wheelAccum.current > 40) {
      wheelAccum.current = 0;
      setSheet(true);
    } else if (sheetOpen && wheelAccum.current < -60) {
      wheelAccum.current = 0;
      setSheet(false);
    }
  };

  // ---- Keyboard ------------------------------------------------------------
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    rootRef.current?.focus({ preventScroll: true });
    return () => previouslyFocused?.focus?.({ preventScroll: true });
  }, []);

  useEffect(() => {
    // Capture phase so Esc is handled here before the app's global handler.
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".music-context-menu")) return; // let open menus close first
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (sheetOpen) setSheet(false);
        else onClose();
        return;
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "q") {
        e.preventDefault();
        setSheet(!sheetOpen);
      } else if (key === "l") {
        e.preventDefault();
        setLyricsOn((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sheetOpen, setSheet, onClose]);

  useEffect(() => {
    if (sheetOpen) listScrollRef.current?.querySelector<HTMLElement>("[role='tab'][aria-selected='true']")?.focus({ preventScroll: true });
  }, [sheetOpen]);

  return (
    <motion.div
      ref={rootRef}
      className="np-root"
      role="dialog"
      aria-modal="true"
      aria-label={`Now playing: ${track.title} by ${track.artist}`}
      tabIndex={-1}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0.12 : 0.32, ease: [0.22, 1, 0.36, 1] }}
      style={{
        ["--np-sheet-peek" as string]: `${measured ? geom.height - geom.closedY : 140}px`,
        ["--np-art-zoom" as string]: palette?.zoom ?? 1,
      }}
    >
      <NowPlayingBackdrop palette={palette} artworkUrl={artworkUrl} />

      <header className="np-topbar">
        <button
          type="button"
          className={`np-icon-btn ${showLyrics ? "is-active" : ""}`}
          onClick={() => setLyricsOn((v) => !v)}
          disabled={!hasLyrics}
          aria-pressed={showLyrics}
          aria-label="Lyrics"
          title={hasLyrics ? (showLyrics ? "Hide lyrics (L)" : "Show lyrics (L)") : "No lyrics for this track"}
        >
          <MessageSquareQuote size={20} />
        </button>
        <button
          type="button"
          className={`np-icon-btn ${sheetOpen ? "is-active" : ""}`}
          onClick={() => setSheet(!sheetOpen)}
          aria-expanded={sheetOpen}
          aria-controls="np-card"
          aria-label="Queue"
          title={sheetOpen ? "Hide queue (Q)" : "Show queue (Q)"}
        >
          <ListMusic size={21} />
        </button>
      </header>

      <motion.main
        className={`np-stage ${showLyrics ? "has-lyrics" : "art-only"} ${compact && showLyrics ? "lyrics-only" : ""}`}
        style={{ opacity: stageOpacity, scale: stageScale, y: stageY }}
        initial={reduceMotion ? false : { scale: 0.97 }}
        animate={{ scale: 1 }}
        aria-hidden={sheetOpen}
      >
        <LayoutGroup>
          <div className="np-stage-row">
            <motion.div layout={!reduceMotion} className="np-art-wrap" transition={{ type: "spring", stiffness: 300, damping: 34 }}>
              <ArtworkImage
                key={track.videoId}
                src={track.thumbnailUrl}
                videoId={track.videoId}
                alt={`${track.title} artwork`}
                className="np-art"
                variant="hero"
                priority
              />
            </motion.div>
            <AnimatePresence mode="popLayout">
              {showLyrics && (
                <motion.section
                  key="lyrics"
                  className="np-lyrics-col"
                  initial={{ opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 24 }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <LyricsPanel
                    data={lyrics}
                    status={lyricsStatus}
                    currentTime={props.currentTime}
                    isPlaying={props.isPlaying}
                    onSeek={props.onSeek}
                    reduceMotion={reduceMotion}
                  />
                </motion.section>
              )}
            </AnimatePresence>
          </div>
          <motion.div layout={!reduceMotion} className="np-meta">
            <h1 className="np-title" title={track.title}>
              {track.title}
            </h1>
            <p className={`np-artist ${props.playbackError ? "is-error" : ""}`} title={props.playbackError ?? track.artist}>
              {props.playbackError ?? track.artist}
            </p>
          </motion.div>
        </LayoutGroup>
      </motion.main>

      <div className="np-card-dock">
        <motion.div
          id="np-card"
          className={`np-card ${sheetOpen ? "is-open" : ""}`}
          role="region"
          aria-label="Player controls and queue"
          style={{ y, height: measured ? geom.height : undefined, backgroundColor: cardTint, visibility: measured ? "visible" : "hidden" }}
          drag="y"
          dragListener={false}
          dragControls={dragControls}
          dragConstraints={{ top: 0, bottom: geom.closedY }}
          dragElastic={0.06}
          dragMomentum={false}
          onDragEnd={onDragEnd}
          onPointerDown={onCardPointerDown}
          onWheel={onCardWheel}
        >
          <div ref={peekRef} className="np-card-peek">
            <div
              className="np-grabber"
              aria-hidden="true"
              onPointerDown={(e) => (grabStart.current = e.clientY)}
              onClick={(e) => {
                // A tap toggles; the tail end of a drag doesn't.
                if (Math.abs(e.clientY - grabStart.current) < 4) setSheet(!sheetOpen);
              }}
            >
              <span />
            </div>
            <motion.div ref={miniRef} className="np-mini" style={{ height: miniHeight, opacity: miniOpacity }} aria-hidden={!sheetOpen}>
              <ArtworkImage src={track.thumbnailUrl} videoId={track.videoId} alt="" className="np-mini-art" variant="hero" />
              <div className="np-mini-text">
                <span className="np-mini-title">{track.title}</span>
                <span className="np-mini-artist">{track.artist}</span>
              </div>
            </motion.div>
            <ControlDeck
              currentTime={props.currentTime}
              duration={props.duration}
              isPlaying={props.isPlaying}
              isBuffering={props.isBuffering}
              isReady={props.isReady}
              volume={props.volume}
              isMuted={props.isMuted}
              modes={props.modes}
              onPlayPause={props.onPlayPause}
              onNext={props.onNext}
              onPrevious={props.onPrevious}
              onSeek={props.onSeek}
              onToggleMute={props.onToggleMute}
              onVolumeChange={props.onVolumeChange}
              onCycleRepeat={props.onCycleRepeat}
              onToggleAutoplay={props.onToggleAutoplay}
              onToggleShuffle={props.onToggleShuffle}
            />
          </div>
          <motion.div ref={listScrollRef} className="np-card-body" style={{ opacity: queueOpacity }}>
            <QueuePanel
              session={session}
              autoplay={props.modes.autoplay}
              isOpen={sheetOpen}
              onSelectTrack={props.onSelectTrack}
              onReorderUpcoming={props.onReorderUpcoming}
              onRemoveUpcoming={props.onRemoveUpcoming}
              onClearUpcoming={props.onClearUpcoming}
              onPlayNext={props.onPlayNext}
              onAddToQueue={props.onAddToQueue}
              onContextMenu={props.onContextMenu}
            />
          </motion.div>
        </motion.div>
      </div>

      <button type="button" className="np-minimize" onClick={onClose} aria-label="Close now playing" title="Close (Esc)">
        <Minimize2 size={20} />
      </button>
    </motion.div>
  );
}
