import { memo } from "react";
import { ArrowLeft, CornerDownRight, ListPlus, Play } from "lucide-react";
import { ArtworkImage } from "../components/ArtworkImage";
import type { PlaylistDetails, SearchResult } from "../lib/search";
import type { CardContextMenuHandler } from "./types";

interface PlaylistViewProps {
  playlist: PlaylistDetails;
  currentVideoId: string | undefined;
  onBack: () => void;
  onSelectTrack: (track: SearchResult, contextList?: SearchResult[]) => void;
  onAppendToQueue: (tracks: SearchResult[]) => void;
  onPlayNext: (track: SearchResult) => void;
  onAddToQueue: (track: SearchResult) => void;
  onContextMenu: CardContextMenuHandler;
}

/** An opened playlist: header with Play All / Add to Queue, then the track list. */
export const PlaylistView = memo(function PlaylistView({
  playlist,
  currentVideoId,
  onBack,
  onSelectTrack,
  onAppendToQueue,
  onPlayNext,
  onAddToQueue,
  onContextMenu,
}: PlaylistViewProps) {
  const { tracks } = playlist;
  return (
    <div className="playlist-detail-view">
      <div className="playlist-nav-bar">
        <button type="button" className="back-nav-btn" onClick={onBack}>
          <ArrowLeft size={16} strokeWidth={2} />
          <span>Back to Home</span>
        </button>
      </div>

      <header className="playlist-header">
        <div className="playlist-cover-wrap">
          <ArtworkImage
            src={playlist.thumbnailUrl}
            alt={playlist.title}
            className="playlist-cover"
            variant="hero"
            priority
          />
        </div>

        <div className="playlist-info">
          <span className="playlist-badge">PLAYLIST</span>
          <h1 className="playlist-title">{playlist.title}</h1>
          <p className="playlist-meta">
            <span className="playlist-author">{playlist.author}</span>
            {playlist.trackCount && (
              <>
                <span className="meta-separator">•</span>
                <span>{playlist.trackCount}</span>
              </>
            )}
            {tracks.length > 0 && (
              <>
                <span className="meta-separator">•</span>
                <span>{tracks.length} songs</span>
              </>
            )}
          </p>

          {playlist.description && <p className="playlist-description">{playlist.description}</p>}

          <div className="playlist-actions">
            <button
              type="button"
              className="playlist-play-all-btn"
              onClick={() => {
                const first = tracks[0];
                if (!first) return;
                onSelectTrack(
                  {
                    videoId: first.videoId,
                    title: first.title,
                    artist: first.artist,
                    thumbnailUrl: first.thumbnailUrl,
                    playlistId: playlist.id,
                  },
                  tracks,
                );
              }}
              disabled={tracks.length === 0}
            >
              <Play size={15} fill="currentColor" strokeWidth={0} />
              <span>Play All</span>
            </button>
            <button
              type="button"
              className="playlist-queue-all-btn"
              onClick={() => {
                if (tracks.length > 0) onAppendToQueue(tracks);
              }}
              disabled={tracks.length === 0}
              title="Add all songs to queue"
            >
              <ListPlus size={14} />
              <span>Add to Queue</span>
            </button>
          </div>
        </div>
      </header>

      <section className="playlist-tracks-section">
        <div className="tracklist-header-row">
          <span className="col-num">#</span>
          <span className="col-title">Title</span>
          <span className="col-artist">Artist</span>
          <span className="col-time">Duration</span>
        </div>

        <div className="tracklist-rows">
          {tracks.map((track, idx) => {
            const isTrackActive = currentVideoId === track.videoId;
            const trackItem: SearchResult = {
              videoId: track.videoId,
              title: track.title,
              artist: track.artist,
              thumbnailUrl: track.thumbnailUrl,
              playlistId: playlist.id,
              itemType: "song",
            };
            return (
              <div
                key={track.videoId || idx}
                className={`tracklist-row ${isTrackActive ? "active" : ""}`}
                onClick={() => onSelectTrack(trackItem, tracks)}
                onContextMenu={(e) =>
                  onContextMenu(e, trackItem, "playlist", { contextList: tracks })
                }
              >
                <span className="col-num">
                  {isTrackActive ? <Play size={12} fill="currentColor" strokeWidth={0} /> : idx + 1}
                </span>
                <div className="col-title-wrap">
                  <ArtworkImage
                    src={track.thumbnailUrl}
                    videoId={track.videoId}
                    alt={track.title}
                    className="track-row-thumb"
                    variant="thumbnail"
                  />
                  <span className="track-row-title">{track.title}</span>
                </div>
                <span className="col-artist">{track.artist}</span>
                <div className="col-time-actions">
                  <div className="track-row-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="track-row-action-btn"
                      onClick={() => onPlayNext(track)}
                      title="Play Next"
                      aria-label="Play Next"
                    >
                      <CornerDownRight size={13} />
                    </button>
                    <button
                      type="button"
                      className="track-row-action-btn"
                      onClick={() => onAddToQueue(track)}
                      title="Add to Queue"
                      aria-label="Add to Queue"
                    >
                      <ListPlus size={13} />
                    </button>
                  </div>
                  <span className="col-time">{track.duration}</span>
                </div>
              </div>
            );
          })}
        </div>

        {tracks.length === 0 && (
          <p className="empty-message">No playable tracks found in this playlist.</p>
        )}
      </section>
    </div>
  );
});
