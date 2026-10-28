import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { flushSync } from "react-dom";
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
import { Disc3, ListMusic, MessageSquareQuote, Minimize2 } from "lucide-react";
import "./NowPlaying.css";
import { ArtworkImage } from "../ArtworkImage";
import { useArtwork } from "../../lib/imagePipeline";
import { useArtworkPalette } from "../../lib/useArtworkPalette";
import { cleanDisplayTitle } from "../../lib/displayText";
import type { SearchResult } from "../../lib/search";
import type { QueueSession } from "../../lib/queueManager";
import type { PlaybackModes } from "../../lib/playbackModes";
import { NowPlayingBackdrop } from "./NowPlayingBackdrop";
import { LyricsPanel } from "./LyricsPanel";
import { ControlDeck } from "./ControlDeck";
import { QueuePanel, type QueueContextMenuHandler } from "./QueuePanel";
import { useLyrics } from "./useLyrics";
import { SkinWheel } from "./SkinWheel";
import { VinylRecord } from "./VinylRecord";
import { loadSkin, saveSkin, type PlayerSkinId } from "../../lib/playerSkins";

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
  const [skin, setSkin] = useState<PlayerSkinId>(loadSkin);
  const [wheelOpen, setWheelOpen] = useState(false);
  const edgeTimer = useRef<number | null>(null);
  // Theme switching. Reveals never overlap: if one is running, the latest choice waits and
  // plays when it finishes (overlapping view transitions get cancelled abruptly = flicker).
  const skinRef = useRef(skin);
  const switching = useRef(false);
  // WebKit runs the reveal's clip-path animation on the main thread, so the lyric letter
  // sweep (per-frame style writes) is paused for its ~0.65s to keep the circle smooth.
  const [revealing, setRevealing] = useState(false);
  const queuedSkin = useRef<PlayerSkinId | null>(null);

  const revealSkin = useCallback(
    (id: PlayerSkinId) => {
      const doc = document as Document & {
        startViewTransition?: (cb: () => Promise<void> | void) => { finished: Promise<void> };
      };
      if (id === skinRef.current) return;
      if (reduceMotion || typeof doc.startViewTransition !== "function") {
        skinRef.current = id;
        setSkin(id);
        return;
      }
      switching.current = true;
      setRevealing(true);
      const npRoot = rootRef.current;
      // The new style pours out of the wheel: a circle reveal centred on its disc.
      const disc = document.querySelector(".np-wheel-disc")?.getBoundingClientRect();
      const html = document.documentElement;
      html.style.setProperty("--np-reveal-x", `${disc ? disc.left + disc.width / 2 : 40}px`);
      html.style.setProperty("--np-reveal-y", `${disc ? disc.top + disc.height / 2 : window.innerHeight / 2}px`);
      // Freeze the skins' own CSS fades so the revealed area shows the final look, not a blend.
      npRoot?.classList.add("np-switching");
      const transition = doc.startViewTransition(async () => {
        flushSync(() => {
          skinRef.current = id;
          setSkin(id);
        });
        // The new skin may mount fresh <img>s (e.g. Vinyl's label). The old frame stays on
        // screen while this promise is pending, so wait briefly for them to decode.
        const imgs = Array.from(npRoot?.querySelectorAll("img") ?? []).filter((img) => !img.complete);
        await Promise.race([
          Promise.all(imgs.map((img) => img.decode().catch(() => undefined))),
          new Promise((r) => window.setTimeout(r, 300)),
        ]);
      });
      void transition.finished.finally(() => {
        npRoot?.classList.remove("np-switching");
        switching.current = false;
        setRevealing(false);
        const next = queuedSkin.current;
        queuedSkin.current = null;
        if (next && next !== skinRef.current) revealSkin(next);
      });
    },
    [reduceMotion],
  );

  const chooseSkin = useCallback(
    (id: PlayerSkinId) => {
      saveSkin(id);
      if (switching.current) {
        queuedSkin.current = id;
        return;
      }
      revealSkin(id);
    },
    [revealSkin],
  );
  const { data: lyrics, status: lyricsStatus } = useLyrics(track, props.duration);
  const hasLyrics = lyricsStatus === "synced" || lyricsStatus === "plain" || lyricsStatus === "loading";
  const showLyrics = lyricsOn && hasLyrics;
  const layoutKey = `${showLyrics}-${compact}`;

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
  const [geom, setGeom] = useState({ height: 0, closedY: 0, mini: 0 });
  const y = useMotionValue(10_000);
  const closedYMV = useMotionValue(1);
  const miniH = useMotionValue(0);
  // The stage behind the open sheet is faded out; pausing its per-frame lyric work while the
  // sheet moves or stays open keeps the main thread free for the sheet animation.
  const [stageLive, setStageLive] = useState(true);
  const sheetOpenRef = useRef(false);
  const dragControls = useDragControls();
  const measured = geom.height > 0;

  const measure = useCallback(() => {
    // The compact row has a fixed height and is always laid out; while collapsed the controls
    // slide up over it (transform only), so it isn't part of the visible peek. Nothing here
    // changes size during the sheet animation, so this only re-runs on real resizes.
    const mini = miniRef.current?.offsetHeight ?? 0;
    const peek = (peekRef.current?.offsetHeight ?? 140) - mini;
    const vh = window.innerHeight;
    const height = Math.round(Math.max(peek + 220, Math.min(vh * 0.8, 780)));
    const closedY = height - peek;
    setGeom((g) =>
      g.height === height && g.closedY === closedY && g.mini === mini ? g : { height, closedY, mini },
    );
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
    miniH.set(geom.mini);
    const target = sheetOpen ? 0 : geom.closedY;
    if (firstPlacement.current) {
      firstPlacement.current = false;
      y.set(geom.height);
      if (reduceMotion) y.set(target);
      else animate(y, target, { ...SHEET_SPRING, delay: 0.05 });
    } else if (y.isAnimating()) {
      // Never snap mid-animation (that reads as a jump); retarget the running spring instead.
      animate(y, target, { ...SHEET_SPRING, velocity: y.getVelocity() });
    } else {
      y.set(target);
    }
    // sheetOpen intentionally excluded: open/close animate via setSheet below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geom]);

  const setSheet = useCallback(
    (open: boolean, velocity = 0) => {
      setSheetOpen(open);
      sheetOpenRef.current = open;
      if (open) setStageLive(false);
      const target = open ? 0 : closedYMV.get();
      const controls = reduceMotion
        ? animate(y, target, { duration: 0.18 })
        : animate(y, target, { ...SHEET_SPRING, velocity });
      // Resume the stage's lyric animation only once the sheet has settled closed.
      if (!open) void controls.then(() => setStageLive(!sheetOpenRef.current));
    },
    [closedYMV, reduceMotion, y],
  );

  const progress = useTransform([y, closedYMV], ([v, c]: number[]) => (c > 0 ? Math.min(1, Math.max(0, 1 - v / c)) : 0));
  const stageOpacity = useTransform(progress, [0, 1], [1, 0.14]);
  const stageScale = useTransform(progress, [0, 1], [1, 0.94]);
  const stageY = useTransform(progress, [0, 1], [0, -28]);
  const miniOpacity = useTransform(progress, [0.45, 1], [0, 1]);
  // Collapsed, the controls and queue sit one mini-row higher (over the hidden mini row).
  // Animated with transforms only: animating the row's height re-laid-out the card each frame.
  const contentShift = useTransform([progress, miniH], ([p, m]: number[]) => -(1 - p) * m);
  const queueOpacity = useTransform(progress, [0.25, 0.85], [0, 1]);

  const closeWheel = useCallback(() => setWheelOpen(false), []);

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
        // Innermost first: style wheel, then queue sheet, then the player itself.
        if (wheelOpen) setWheelOpen(false);
        else if (sheetOpen) setSheet(false);
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
      } else if (key === "t") {
        e.preventDefault();
        setWheelOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sheetOpen, wheelOpen, setSheet, onClose]);

  useEffect(() => {
    if (sheetOpen) listScrollRef.current?.querySelector<HTMLElement>("[role='tab'][aria-selected='true']")?.focus({ preventScroll: true });
  }, [sheetOpen]);

  return (
    <motion.div
      ref={rootRef}
      className="np-root"
      data-skin={skin}
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

      {/* Hover the left edge to summon the style wheel. */}
      <div
        className="np-wheel-hotzone"
        aria-hidden="true"
        onPointerEnter={() => {
          edgeTimer.current = window.setTimeout(() => setWheelOpen(true), 250);
        }}
        onPointerLeave={() => {
          if (edgeTimer.current) window.clearTimeout(edgeTimer.current);
        }}
      />
      <SkinWheel
        open={wheelOpen}
        skin={skin}
        onSelect={chooseSkin}
        onClose={closeWheel}
        reduceMotion={reduceMotion}
      />

      <header className="np-topbar">
        <button
          type="button"
          className={`np-icon-btn ${wheelOpen ? "is-active" : ""}`}
          onClick={() => setWheelOpen((v) => !v)}
          aria-pressed={wheelOpen}
          aria-label="Player style"
          title="Player style (T)"
        >
          <Disc3 size={20} />
        </button>
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
            <motion.div
              layout={!reduceMotion}
              // Only re-measure when the arrangement really changes. Without this, Motion
              // measured on every render (10×/s from the time updates) and "corrected" for the
              // stage's own scale while the sheet moved, which jittered.
              layoutDependency={layoutKey}
              className="np-art-wrap"
              transition={{ type: "spring", stiffness: 300, damping: 34 }}
            >
              {skin === "vinyl" ? (
                <VinylRecord
                  track={track}
                  isPlaying={props.isPlaying}
                  currentTime={props.currentTime}
                  duration={props.duration}
                  reduceMotion={reduceMotion}
                />
              ) : (
                <ArtworkImage
                  key={track.videoId}
                  src={track.thumbnailUrl}
                  videoId={track.videoId}
                  alt={`${track.title} artwork`}
                  className="np-art"
                  variant="hero"
                  priority
                />
              )}
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
                    paused={!stageLive || revealing}
                  />
                </motion.section>
              )}
            </AnimatePresence>
          </div>
          <motion.div layout={!reduceMotion} layoutDependency={layoutKey} className="np-meta">
            <h1 className="np-title" title={track.title}>
              {cleanDisplayTitle(track.title)}
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
          style={{ y, height: measured ? geom.height : undefined, visibility: measured ? "visible" : "hidden" }}
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
          {/* Darkens the glass as the sheet opens. Fading this layer's opacity is compositor-only;
              animating the card's own background-color repainted its backdrop blur every frame. */}
          <motion.div className="np-card-shade" style={{ opacity: progress }} aria-hidden="true" />
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
            <motion.div ref={miniRef} className="np-mini" style={{ opacity: miniOpacity }} aria-hidden={!sheetOpen}>
              <ArtworkImage src={track.thumbnailUrl} videoId={track.videoId} alt="" className="np-mini-art" variant="hero" />
              <div className="np-mini-text">
                <span className="np-mini-title">{cleanDisplayTitle(track.title)}</span>
                <span className="np-mini-artist">{track.artist}</span>
              </div>
            </motion.div>
            <motion.div style={{ y: contentShift }}>
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
            </motion.div>
          </div>
          <motion.div ref={listScrollRef} className="np-card-body" style={{ opacity: queueOpacity, y: contentShift }}>
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
