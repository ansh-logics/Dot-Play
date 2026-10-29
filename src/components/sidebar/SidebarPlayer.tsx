import {
  ListMusic,
  Loader2,
  Maximize2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import { ArtworkImage } from "../ArtworkImage";
import { MiniVinyl } from "../vinyl/MiniVinyl";
import type { YouTubePlaybackState } from "../HiddenYouTubePlayer";
import { cleanDisplayTitle } from "../../lib/displayText";
import { formatTime } from "../../lib/formatTime";
import { useArtwork } from "../../lib/imagePipeline";
import type { SearchResult } from "../../lib/search";
import { useArtworkPalette } from "../../lib/useArtworkPalette";
import { usePlayerSkin } from "../../lib/usePlayerSkin";

interface SidebarPlayerProps {
  track: SearchResult;
  isQueueOpen: boolean;
  isPlayerReady: boolean;
  playerState: YouTubePlaybackState;
  currentTime: number;
  duration: number;
  playbackError: string | null;
  isMuted: boolean;
  onToggleQueue: () => void;
  onOpenNowPlaying: () => void;
  onBeginScrub: () => void;
  onScrub: (seconds: number) => void;
  onEndScrub: (seconds: number) => void;
  onToggleMute: () => void;
  onPrevious: () => void;
  onPlayPause: () => void;
  onNext: () => void;
  /** The queue list, rendered inside the card. */
  children: React.ReactNode;
}

function playButtonLabel(isPlayerReady: boolean, state: YouTubePlaybackState): string {
  if (!isPlayerReady) return "Loading...";
  if (state === "buffering") return "Buffering...";
  if (state === "playing") return "Pause";
  if (state === "ended") return "Replay";
  return "Play";
}

/** Now-playing card at the bottom of the sidebar, tinted from the artwork. */
export function SidebarPlayer({
  track,
  isQueueOpen,
  isPlayerReady,
  playerState,
  currentTime,
  duration,
  playbackError,
  isMuted,
  onToggleQueue,
  onOpenNowPlaying,
  onBeginScrub,
  onScrub,
  onEndScrub,
  onToggleMute,
  onPrevious,
  onPlayPause,
  onNext,
  children,
}: SidebarPlayerProps) {
  // Same URL the artwork below resolves to, so the tint matches the pixels on screen.
  const { currentUrl: artUrl } = useArtwork({
    sourceUrl: track.thumbnailUrl ?? "",
    videoId: track.videoId,
    variant: "hero",
    priority: true,
  });
  const palette = useArtworkPalette(artUrl);
  // The Vinyl player style carries over to the card: the artwork becomes a turning record.
  const isVinyl = usePlayerSkin() === "vinyl";
  const isBusy = playerState === "buffering" || !isPlayerReady;

  return (
    <div
      className={`sidebar-player-card ${isQueueOpen ? "queue-mode" : "hero-mode"}`}
      style={palette ? ({ "--tint": palette.colors[0] } as React.CSSProperties) : undefined}
      aria-label="Audio Player"
    >
      <div className={`sidebar-player-header ${isQueueOpen ? "queue-view" : "hero-view"}`}>
        <div
          className={`sidebar-artwork-container${isVinyl ? " is-vinyl" : ""}`}
          onClick={(e) => {
            if (e.altKey) onOpenNowPlaying();
            else onToggleQueue();
          }}
          role="button"
          tabIndex={0}
          title={isQueueOpen ? "Click to expand album artwork" : "Click to view upcoming queue"}
        >
          {isVinyl ? (
            <div className="sidebar-vinyl">
              <MiniVinyl isPlaying={playerState === "playing"} tiny={isQueueOpen}>
                <ArtworkImage
                  src={track.thumbnailUrl}
                  videoId={track.videoId}
                  alt={track.title}
                  variant="hero"
                  priority
                />
              </MiniVinyl>
            </div>
          ) : (
            <ArtworkImage
              src={track.thumbnailUrl}
              videoId={track.videoId}
              alt={track.title}
              className="sidebar-player-thumb"
              variant="hero"
              priority
            />
          )}
          <span className="sidebar-artwork-hint-badge">
            <ListMusic size={11} />
          </span>
          <button
            type="button"
            className="sidebar-expand-btn"
            onClick={(e) => {
              e.stopPropagation();
              onOpenNowPlaying();
            }}
            title="Open Now Playing (F)"
            aria-label="Open Now Playing"
          >
            <Maximize2 size={12} />
          </button>
        </div>
        <div className="sidebar-player-meta">
          <span className="sidebar-player-title" title={track.title}>
            {cleanDisplayTitle(track.title)}
          </span>
          <span
            className={`sidebar-player-artist ${playbackError ? "error" : ""}`}
            title={playbackError || track.artist}
          >
            {playbackError || track.artist}
          </span>
        </div>
      </div>

      <div className="sidebar-player-progress-wrap">
        <input
          type="range"
          className="sidebar-player-scrubber"
          min="0"
          max={duration || 0}
          step="0.1"
          value={Math.min(currentTime, duration || 0)}
          onPointerDown={onBeginScrub}
          onChange={(event) => onScrub(Number(event.target.value))}
          onPointerUp={(event) => onEndScrub(Number(event.currentTarget.value))}
          disabled={!isPlayerReady || duration <= 0}
          aria-label="Seek track"
        />
        <div className="sidebar-player-times">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <div className="sidebar-player-controls">
        <button
          type="button"
          className={`sidebar-ctrl-btn volume ${isMuted ? "active-muted" : ""}`}
          onClick={onToggleMute}
          title={isMuted ? "Unmute" : "Mute"}
          aria-label="Toggle mute"
        >
          {isMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>

        <button
          type="button"
          className="sidebar-ctrl-btn"
          onClick={onPrevious}
          disabled={!isPlayerReady}
          title="Previous track"
          aria-label="Previous"
        >
          <SkipBack size={15} fill="currentColor" />
        </button>

        <button
          type="button"
          className="sidebar-ctrl-btn play-pause"
          onClick={onPlayPause}
          disabled={isBusy}
          title={playButtonLabel(isPlayerReady, playerState)}
          aria-label={playerState === "playing" ? "Pause" : "Play"}
        >
          {isBusy ? (
            <Loader2 size={15} className="spin-icon" />
          ) : playerState === "playing" ? (
            <Pause size={15} fill="currentColor" strokeWidth={0} />
          ) : (
            <Play size={15} fill="currentColor" strokeWidth={0} style={{ marginLeft: 1 }} />
          )}
        </button>

        <button
          type="button"
          className="sidebar-ctrl-btn"
          onClick={onNext}
          disabled={!isPlayerReady}
          title="Next track"
          aria-label="Next"
        >
          <SkipForward size={15} fill="currentColor" />
        </button>

        <button
          type="button"
          className={`sidebar-ctrl-btn queue ${isQueueOpen ? "active" : ""}`}
          onClick={onToggleQueue}
          title={isQueueOpen ? "Hide queue" : "Show upcoming queue"}
          aria-label="Upcoming queue"
        >
          <ListMusic size={15} />
        </button>
      </div>

      {children}
    </div>
  );
}
