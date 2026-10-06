import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./FullScreenPlayer.css";
import { type SearchResult } from "../lib/search";
import { type QueueSession } from "../lib/queueManager";
import { ArtworkImage } from "./ArtworkImage";
import {
  fetchLyricsMultiProvider,
  type RichLyricLine,
  type TrackLyrics,
} from "../lib/lyrics";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Minimize2,
  ListMusic,
  FileText,
  Activity,
  Shuffle,
  Repeat,
  Loader2,
} from "lucide-react";

export interface FullScreenPlayerProps {
  isOpen: boolean;
  onClose: () => void;
  currentTrack: SearchResult | null;
  session: QueueSession;
  isPlaying: boolean;
  isBuffering: boolean;
  currentTime: number;
  duration: number;
  isMuted: boolean;
  playbackError: string | null;
  onPlayPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (seconds: number) => void;
  onToggleMute: () => void;
  onSelectTrack: (track: SearchResult) => void;
  onContextMenu?: (
    e: React.MouseEvent,
    track: SearchResult,
    source: "upcoming" | "history",
  ) => void;
}

export const FullScreenPlayer: React.FC<FullScreenPlayerProps> = ({
  isOpen,
  onClose,
  currentTrack,
  session,
  isPlaying,
  isBuffering,
  currentTime,
  duration,
  isMuted,
  playbackError: _playbackError,
  onPlayPause,
  onNext,
  onPrevious,
  onSeek,
  onToggleMute,
  onSelectTrack,
  onContextMenu,
}) => {
  const [isIdle, setIsIdle] = useState(false);
  const [showQueuePanel, setShowQueuePanel] = useState(true);
  const [rightViewMode, setRightViewMode] = useState<"lyrics" | "visualizer">("lyrics");
  const [isShuffle, setIsShuffle] = useState(false);
  const [isRepeat, setIsRepeat] = useState(false);
  const [lyricsData, setLyricsData] = useState<TrackLyrics | null>(null);
  const [isLoadingLyrics, setIsLoadingLyrics] = useState(false);

  const idleTimerRef = useRef<number | null>(null);
  const lyricsScrollRef = useRef<HTMLDivElement | null>(null);

  // 1. Fetch real lyrics from community multi-provider stack for the active track
  useEffect(() => {
    if (!isOpen || !currentTrack) return;

    let isCancelled = false;
    setLyricsData(null);
    setIsLoadingLyrics(true);

    fetchLyricsMultiProvider(
      currentTrack.title,
      currentTrack.artist,
      duration,
      currentTrack.videoId,
    )
      .then((data: TrackLyrics) => {
        if (isCancelled) return;
        setLyricsData(data);
      })
      .catch((err: unknown) => {
        if (isCancelled) return;
        console.warn("[DOT Music] Failed to fetch lyrics:", err);
      })
      .finally(() => {
        if (!isCancelled) {
          setIsLoadingLyrics(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [
    isOpen,
    currentTrack,
    duration,
  ]);

  // 2. Mouse Inactivity Controller (autohide controls after 4.5s)
  const resetIdleTimer = useCallback(() => {
    setIsIdle(false);
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = window.setTimeout(() => {
      setIsIdle(true);
    }, 4500);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleMove = () => resetIdleTimer();
    window.addEventListener("pointermove", handleMove, { passive: true });
    window.addEventListener("keydown", handleMove, { passive: true });
    idleTimerRef.current = window.setTimeout(() => {
      setIsIdle(true);
    }, 4500);
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
      }
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("keydown", handleMove);
    };
  }, [isOpen, resetIdleTimer]);

  // 3. Keyboard Shortcuts inside Fullscreen
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "f" || e.key === "F") {
        if (!e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          onClose();
          return;
        }
      }
      if (e.code === "Space") {
        e.preventDefault();
        onPlayPause();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onSeek(Math.max(0, currentTime - 5));
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        onSeek(Math.min(duration || 0, currentTime + 5));
        return;
      }
      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        onToggleMute();
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose, onPlayPause, onSeek, onToggleMute, currentTime, duration]);

  // 4. Audio Equalizer Waveform Bars (24 bars with organic rhythm)
  const [eqHeights, setEqHeights] = useState<number[]>(() =>
    Array.from({ length: 24 }, () => 6),
  );

  useEffect(() => {
    if (!isOpen) return;

    let animId: number;
    let tick = 0;

    const updateVisualizer = () => {
      tick += 0.08;
      if (isPlaying) {
        setEqHeights((prev) =>
          prev.map((_, i) => {
            const wave1 = Math.sin(tick * 2.2 + i * 0.45);
            const wave2 = Math.cos(tick * 1.5 - i * 0.3);
            const beat = Math.abs(Math.sin(tick * 3));
            const height = Math.floor(
              6 + (wave1 * 0.5 + 0.5) * 14 + (wave2 * 0.5 + 0.5) * 6 + beat * 4,
            );
            return Math.min(28, Math.max(4, height));
          }),
        );
      } else {
        setEqHeights((prev) => prev.map((h) => Math.max(4, Math.floor(h * 0.85))));
      }
      animId = requestAnimationFrame(updateVisualizer);
    };

    animId = requestAnimationFrame(updateVisualizer);
    return () => cancelAnimationFrame(animId);
  }, [isOpen, isPlaying]);

  // 5. Real Lyric Lines from multi-provider stack
  const lines: RichLyricLine[] = useMemo(() => {
    if (lyricsData && lyricsData.lines.length > 0) {
      return lyricsData.lines;
    }
    return [];
  }, [lyricsData]);

  // Find active lyric line index
  const activeLyricIdx = useMemo(() => {
    if (lyricsData?.syncType === "plain" || lines.length === 0) return -1;
    for (let i = 0; i < lines.length; i++) {
      if (currentTime >= lines[i].startTime && currentTime < lines[i].endTime) {
        return i;
      }
    }
    return -1;
  }, [currentTime, lines, lyricsData?.syncType]);

  // Auto-scroll lyrics smoothly to keep active line centered
  useEffect(() => {
    if (!isOpen || rightViewMode !== "lyrics") return;
    const container = lyricsScrollRef.current;
    if (!container) return;

    const activeEl = container.querySelector(`[data-lyric-idx="${activeLyricIdx}"]`) as HTMLElement;
    if (activeEl) {
      const targetScroll = activeEl.offsetTop - container.clientHeight / 2 + activeEl.clientHeight / 2;
      container.scrollTo({ top: Math.max(0, targetScroll), behavior: "smooth" });
    }
  }, [activeLyricIdx, isOpen, rightViewMode]);

  // Timeline scrubber calculations
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  if (!isOpen || !currentTrack) return null;

  return (
    <div className={`fullscreen-player-root ${isIdle ? "idle" : ""}`}>
      {/* 1. Ambient Background Layer */}
      <div className="fullscreen-backdrop">
        {currentTrack.thumbnailUrl && (
          <div
            className="fullscreen-backdrop-art"
            style={{ backgroundImage: `url(${currentTrack.thumbnailUrl})` }}
          />
        )}
        <div className="fullscreen-backdrop-halo" />
        <div className="fullscreen-backdrop-grid" />
      </div>

      {/* 2. Top Bar */}
      <header className="fullscreen-topbar">
        <div className="fullscreen-topbar-left">
          <div className="fullscreen-brand-logo">
            <div className="brand-dot-logo">
              <span className="brand-red-dot" />
            </div>
            <div className="brand-title-wrap">
              <span className="brand-title">dot(.)music</span>
            </div>
          </div>
        </div>

        <div className="fullscreen-topbar-center">
          <div className="fullscreen-badge-pill">
            <span>
              {lyricsData?.hasWordTiming
                ? `${lyricsData.source.toUpperCase()} • APPLE-STYLE SYLLABLE SYNC`
                : lyricsData?.synced
                ? `${lyricsData.source.toUpperCase()} • LINE SYNCED`
                : lyricsData?.lines && lyricsData.lines.length > 0
                ? `${lyricsData.source.toUpperCase()} • PLAIN LYRICS`
                : "24-BIT HI-RES LOSSLESS"}
            </span>
          </div>
        </div>

        <div className="fullscreen-topbar-right">
          <button
            type="button"
            className={`fullscreen-icon-btn ${showQueuePanel ? "active" : ""}`}
            onClick={() => setShowQueuePanel((prev) => !prev)}
            title="Toggle Queue Panel"
          >
            <ListMusic size={14} />
            <span>QUEUE</span>
          </button>

          <button
            type="button"
            className={`fullscreen-icon-btn ${rightViewMode === "lyrics" ? "active" : ""}`}
            onClick={() => setRightViewMode((prev) => (prev === "lyrics" ? "visualizer" : "lyrics"))}
            title={rightViewMode === "lyrics" ? "Switch to Visualizer" : "Switch to Lyrics"}
          >
            {rightViewMode === "lyrics" ? <FileText size={14} /> : <Activity size={14} />}
            <span>{rightViewMode === "lyrics" ? "LYRICS" : "SPECTRUM"}</span>
          </button>

          <button
            type="button"
            className="fullscreen-icon-btn fullscreen-close-btn"
            onClick={onClose}
            title="Exit Fullscreen (Esc)"
          >
            <Minimize2 size={16} />
          </button>
        </div>
      </header>

      {/* 3. Main Stage Layout */}
      <main
        className={`fullscreen-stage ${!showQueuePanel ? "hide-queue" : ""} ${
          rightViewMode === "visualizer" ? "visualizer-view" : ""
        }`}
      >
        {/* Left: Floating Queue Panel */}
        {showQueuePanel && (
          <aside className="fullscreen-queue-panel">
            <div className="fullscreen-queue-header">
              <span className="fullscreen-queue-title">
                <ListMusic size={16} strokeWidth={2.5} />
                <span>Upcoming Queue</span>
              </span>
              <span className="fullscreen-queue-count">
                {session.upcoming.length + 1} TRACKS
              </span>
            </div>

            <div className="fullscreen-queue-list">
              {/* Currently Playing Track */}
              <div className="fullscreen-queue-item active" title={currentTrack.title}>
                <div className="fullscreen-queue-thumb">
                  <ArtworkImage
                    src={currentTrack.thumbnailUrl}
                    videoId={currentTrack.videoId}
                    alt={currentTrack.title}
                    variant="card"
                  />
                </div>
                <div className="fullscreen-queue-info">
                  <span className="fullscreen-queue-track-title">
                    {currentTrack.title}
                  </span>
                  <span className="fullscreen-queue-track-artist">
                    {currentTrack.artist}
                  </span>
                  <span className="fullscreen-queue-active-tag">
                    <span className="fullscreen-brand-dot" style={{ width: 5, height: 5 }} />
                    NOW PLAYING
                  </span>
                </div>
                <span className="fullscreen-queue-duration">
                  {formatTimestamp(duration)}
                </span>
              </div>

              {/* Upcoming Tracks */}
              {session.upcoming.map((track, idx) => (
                <div
                  key={`${track.videoId || track.title}-${idx}`}
                  className="fullscreen-queue-item"
                  onClick={() => onSelectTrack(track)}
                  onContextMenu={(e) => onContextMenu?.(e, track, "upcoming")}
                  title={`Play ${track.title}`}
                >
                  <div className="fullscreen-queue-thumb">
                    <ArtworkImage
                      src={track.thumbnailUrl}
                      videoId={track.videoId}
                      alt={track.title}
                      variant="card"
                    />
                  </div>
                  <div className="fullscreen-queue-info">
                    <span className="fullscreen-queue-track-title">{track.title}</span>
                    <span className="fullscreen-queue-track-artist">{track.artist}</span>
                  </div>
                  <span className="fullscreen-queue-duration">--:--</span>
                </div>
              ))}
            </div>
          </aside>
        )}

        {/* Center: Hero Artwork & Atmospheric Silhouette */}
        <section className="fullscreen-center-stage">
          <div className={`fullscreen-artwork-wrap ${isPlaying ? "playing" : ""}`}>
            <div className="fullscreen-artwork-inner">
              <ArtworkImage
                src={currentTrack.thumbnailUrl}
                videoId={currentTrack.videoId}
                alt={currentTrack.title}
                variant="hero"
                priority
                className="fullscreen-artwork-img"
              />
            </div>
          </div>
        </section>

        {/* Right: Large Synchronized Typography Lyrics OR Spectrum Visualizer */}
        <aside className="fullscreen-lyrics-panel">
          {rightViewMode === "lyrics" ? (
            isLoadingLyrics ? (
              <div className="fullscreen-lyrics-loading">
                <Loader2 size={18} className="spin-icon" style={{ color: "var(--accent-red, #d71921)" }} />
                <span>DISCOVERING RICH-SYNCED LYRICS...</span>
              </div>
            ) : lines.length > 0 ? (
              <>
                <div className="fullscreen-provider-attribution">
                  <div className="fullscreen-provider-pill">
                    <span className="fullscreen-provider-dot" />
                    <span>
                      {lyricsData?.source ? lyricsData.source.toUpperCase() : "COMMUNITY"}
                      {lyricsData?.syncType === "word"
                        ? " • SYLLABLE GLOW"
                        : lyricsData?.syncType === "line"
                        ? " • SYNCED"
                        : " • PLAIN"}
                    </span>
                  </div>
                  {lyricsData?.isrc && (
                    <span
                      style={{ opacity: 0.7 }}
                      title="International Standard Recording Code"
                    >
                      ISRC: {lyricsData.isrc}
                    </span>
                  )}
                </div>
                <div className="fullscreen-lyrics-scroll" ref={lyricsScrollRef}>
                  {lines.map((line, idx) => {
                    const isActive = idx === activeLyricIdx;
                    const distance = Math.abs(idx - activeLyricIdx);
                    const proximityClass =
                      lyricsData?.syncType === "plain"
                        ? "plain"
                        : isActive
                        ? "active"
                        : distance === 1
                        ? "near"
                        : distance === 2
                        ? "mid"
                        : "far";

                    return (
                      <div
                        key={line.id}
                        data-lyric-idx={idx}
                        className={`fullscreen-lyric-line ${proximityClass}`}
                        onClick={lyricsData?.syncType === "plain" ? undefined : () => onSeek(line.startTime)}
                        title={lyricsData?.syncType === "plain" ? undefined : `Jump to ${formatTimestamp(line.startTime)}`}
                      >
                        {line.words && line.words.length > 0 ? (
                          <span className="fullscreen-karaoke-words">
                            {line.words.map((word, wIdx) => {
                              let state = "upcoming";
                              if (currentTime >= word.endTime || (!isActive && idx < activeLyricIdx)) {
                                state = "passed";
                              } else if (currentTime >= word.startTime && currentTime <= word.endTime && isActive) {
                                state = "singing";
                              }
                              return (
                                <span
                                  key={wIdx}
                                  className={`fullscreen-karaoke-word ${state}`}
                                >
                                  {word.text}
                                </span>
                              );
                            })}
                          </span>
                        ) : (
                          <span className="fullscreen-lyric-text">{line.text}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="fullscreen-visualizer-panel">
                <div className="fullscreen-badge-pill" style={{ marginBottom: 8 }}>
                  <Activity size={13} />
                  <span>
                    {lyricsData?.source === "instrumental"
                      ? "INSTRUMENTAL TRACK"
                      : "LYRICS UNAVAILABLE"}
                  </span>
                </div>
                <span className="fullscreen-no-lyrics-hint">
                  Enjoy the dynamic soundwave spectrum
                </span>
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-end",
                    gap: 6,
                    height: 180,
                    padding: "16px 20px 0",
                  }}
                >
                  {eqHeights.map((h, i) => (
                    <div
                      key={i}
                      style={{
                        width: 8,
                        height: `${h * 5}px`,
                        maxHeight: 160,
                        background:
                          i % 5 === 0
                            ? "var(--accent-red, #d71921)"
                            : "rgba(255, 255, 255, 0.4)",
                        borderRadius: 4,
                        boxShadow:
                          i % 5 === 0 ? "0 0 10px rgba(215, 25, 33, 0.8)" : "none",
                        transition: "height 0.08s ease",
                      }}
                    />
                  ))}
                </div>
              </div>
            )
          ) : (
            <div className="fullscreen-visualizer-panel">
              <div className="fullscreen-badge-pill" style={{ marginBottom: 12 }}>
                <Activity size={13} />
                <span>DYNAMIC AUDIO SPECTRUM</span>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 6,
                  height: 180,
                  padding: "0 20px",
                }}
              >
                {eqHeights.map((h, i) => (
                  <div
                    key={i}
                    style={{
                      width: 8,
                      height: `${h * 5}px`,
                      maxHeight: 160,
                      background:
                        i % 5 === 0
                          ? "var(--accent-red, #d71921)"
                          : "rgba(255, 255, 255, 0.4)",
                      borderRadius: 4,
                      boxShadow:
                        i % 5 === 0 ? "0 0 10px rgba(215, 25, 33, 0.8)" : "none",
                      transition: "height 0.08s ease",
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </aside>
      </main>

      {/* 4. Monumental Typography (Bottom Right) */}
      <div className="fullscreen-track-hero-meta">
        <h1 className="fullscreen-hero-title" title={currentTrack.title}>
          {currentTrack.title}
        </h1>
        <p className="fullscreen-hero-subtitle">
          {currentTrack.artist} // {currentTrack.itemType || "DOT MUSIC"}
        </p>
      </div>

      {/* 5. Center Floating Control Capsule & Scrubber */}
      <div className="fullscreen-control-capsule-wrapper">
        {/* Timeline Scrubber Bar */}
        <div className="fullscreen-timeline-wrap">
          <span className="fullscreen-timeline-time">
            {formatTimestamp(currentTime)}
          </span>

          <div
            className="fullscreen-scrubber-track"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const clickX = e.clientX - rect.left;
              const ratio = Math.max(0, Math.min(1, clickX / rect.width));
              const targetTime = ratio * (duration || 0);
              onSeek(targetTime);
            }}
          >
            <div
              className="fullscreen-scrubber-progress"
              style={{ width: `${progressPercent}%` }}
            />
            <div
              className="fullscreen-scrubber-thumb"
              style={{ left: `${progressPercent}%` }}
            />
          </div>

          <span className="fullscreen-timeline-time">
            {formatTimestamp(duration)}
          </span>
        </div>

        {/* Floating Capsule Dock */}
        <div className="fullscreen-capsule-container">
          <div className="fullscreen-capsule-controls">
            <button
              type="button"
              className={`fullscreen-capsule-btn ${isShuffle ? "active" : ""}`}
              onClick={() => setIsShuffle((prev) => !prev)}
              title="Shuffle"
            >
              <Shuffle size={14} />
            </button>

            <button
              type="button"
              className="fullscreen-capsule-btn"
              onClick={onPrevious}
              title="Previous Track (Cmd+Left)"
            >
              <SkipBack size={15} fill="currentColor" />
            </button>

            <button
              type="button"
              className="fullscreen-capsule-play-btn"
              onClick={onPlayPause}
              disabled={isBuffering}
              title={isPlaying ? "Pause (Space)" : "Play (Space)"}
            >
              {isBuffering ? (
                <Loader2 size={18} className="spin-icon" />
              ) : isPlaying ? (
                <Pause size={18} fill="currentColor" strokeWidth={0} />
              ) : (
                <Play size={18} fill="currentColor" strokeWidth={0} style={{ marginLeft: 2 }} />
              )}
            </button>

            <button
              type="button"
              className="fullscreen-capsule-btn"
              onClick={onNext}
              title="Next Track (Cmd+Right)"
            >
              <SkipForward size={15} fill="currentColor" />
            </button>

            <button
              type="button"
              className={`fullscreen-capsule-btn ${isRepeat ? "active" : ""}`}
              onClick={() => setIsRepeat((prev) => !prev)}
              title="Repeat"
            >
              <Repeat size={14} />
            </button>
          </div>

          <div className="fullscreen-capsule-sep" />

          {/* Volume Control */}
          <div className="fullscreen-capsule-volume">
            <button
              type="button"
              className="fullscreen-capsule-btn"
              onClick={onToggleMute}
              title={isMuted ? "Unmute (M)" : "Mute (M)"}
            >
              {isMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}
