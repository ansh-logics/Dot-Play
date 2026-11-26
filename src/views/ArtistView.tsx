import { activateOnKey } from "../lib/a11y";
import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, ChevronLeft, CornerDownRight, ListEnd, Play, Shuffle } from "lucide-react";
import { ArtworkImage } from "../components/ArtworkImage";
import { ArtistLinks } from "../components/ArtistLinks";
import { SectionHeader } from "../components/SectionHeader";
import { SkeletonGrid } from "../components/SkeletonGrid";
import { CardGrid } from "../components/TrackCard";
import { cleanDisplayTitle } from "../lib/displayText";
import { useArtwork } from "../lib/imagePipeline";
import type { ArtistPage, PlaylistTrack, SearchResult } from "../lib/search";
import { useArtworkPalette } from "../lib/useArtworkPalette";
import type { BrowseProps } from "./types";

interface ArtistViewProps extends BrowseProps {
  /** The loaded channel page; null while it loads or when it failed. */
  artist: ArtistPage | null;
  isLoading: boolean;
  error: string | null;
  onBack: () => void;
  onSelectTrack: (track: SearchResult, contextList?: SearchResult[]) => void;
  onPlayNext: (track: SearchResult) => void;
  onAddToQueue: (track: SearchResult) => void;
}

type ArtistPageProps = Omit<ArtistViewProps, "artist" | "isLoading" | "error"> & {
  artist: ArtistPage;
};

function shuffled<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** What the page shows while the channel is still coming back, and when it can't. */
function ArtistLoading() {
  return (
    <div className="artist-loading-view">
      <span className="loading-spinner large" />
      <p className="loading-label">Loading artist...</p>
      <SkeletonGrid count={8} />
    </div>
  );
}

function ArtistError({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="artist-error-view">
      <p className="empty-message">{message}</p>
      <button type="button" className="back-nav-btn" onClick={onBack}>
        <ArrowLeft size={16} strokeWidth={2} />
        <span>Back</span>
      </button>
    </div>
  );
}

/**
 * An opened artist, in the album page's clothes: their photo washed out into a banner with
 * a circular avatar, the top songs as the track list, then the albums and singles as the
 * same horizontal shelf Home uses.
 */
function ArtistPageView({
  artist,
  currentVideoId,
  currentPlaylistId,
  onBack,
  onSelectTrack,
  onPlayNext,
  onAddToQueue,
  onCardClick,
  onContextMenu,
}: ArtistPageProps) {
  const { songs } = artist;

  // Same URL the avatar resolves to, so the colours match the pixels on screen.
  const { currentUrl: artUrl } = useArtwork({
    sourceUrl: artist.thumbnailUrl,
    artworkKey: artist.id,
    variant: "hero",
    priority: true,
  });
  const palette = useArtworkPalette(artUrl || undefined);

  const rootRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const [condensed, setCondensed] = useState(false);

  // The banner behaves exactly like the album one: parallax on scroll, then the slim bar.
  useEffect(() => {
    const root = rootRef.current;
    const hero = heroRef.current;
    const scroller = hero?.closest<HTMLElement>(".app-main-content");
    if (!root || !hero || !scroller) return;
    const place = () => {
      const rect = scroller.getBoundingClientRect();
      root.style.setProperty("--bar-top", `${rect.top}px`);
      root.style.setProperty("--bar-left", `${rect.left}px`);
      root.style.setProperty("--bar-width", `${scroller.clientWidth}px`);
    };
    const resize = new ResizeObserver(place);
    resize.observe(scroller);
    let frame = 0;
    const update = () => {
      frame = 0;
      const height = hero.offsetHeight || 1;
      const progress = Math.min(1, Math.max(0, scroller.scrollTop / height));
      hero.style.setProperty("--hero-progress", progress.toFixed(3));
      setCondensed(progress > 0.82);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    scroller.scrollTop = 0;
    place();
    update();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      resize.disconnect();
    };
  }, [artist.id]);

  const toItem = (track: PlaylistTrack): SearchResult => ({
    videoId: track.videoId,
    title: track.title,
    artist: track.artist,
    artists: track.artists,
    thumbnailUrl: track.thumbnailUrl,
    playlistId: artist.songsPlaylistId,
    itemType: "song",
  });
  const songItems = songs.map(toItem);
  const playFrom = (list: PlaylistTrack[]) => {
    if (list.length > 0) onSelectTrack(toItem(list[0]), list.map(toItem));
  };

  const tint = palette
    ? ({
        "--hero-c1": palette.colors[0],
        "--hero-c2": palette.colors[1],
        "--hero-c3": palette.colors[2],
        "--hero-base": palette.base,
      } as CSSProperties)
    : undefined;

  return (
    <div ref={rootRef} className="artist-view" style={tint}>
      <div className={`album-sticky-bar ${condensed ? "is-shown" : ""}`} aria-hidden={!condensed}>
        <button
          type="button"
          className="album-glass-btn is-small"
          onClick={onBack}
          aria-label="Back"
          tabIndex={condensed ? 0 : -1}
        >
          <ChevronLeft size={16} />
        </button>
        <ArtworkImage src={artist.thumbnailUrl} alt="" className="album-sticky-art is-round" variant="thumbnail" />
        <span className="album-sticky-title">{artist.name}</span>
        <button
          type="button"
          className="album-play-btn is-small"
          onClick={() => playFrom(songs)}
          disabled={songs.length === 0}
          aria-label={`Play ${artist.name}`}
          tabIndex={condensed ? 0 : -1}
        >
          <Play size={14} fill="currentColor" strokeWidth={0} />
        </button>
      </div>

      <header ref={heroRef} className="album-hero artist-hero">
        <div className="album-hero-backdrop" aria-hidden="true">
          {artUrl && <img className="album-hero-blur" src={artUrl} alt="" referrerPolicy="no-referrer" />}
          <div className="album-hero-tint" />
          <div className="album-hero-fade" />
        </div>

        <button type="button" className="album-glass-btn album-back" onClick={onBack} aria-label="Back" title="Back">
          <ChevronLeft size={18} />
        </button>

        <div className="album-hero-content">
          <div className="artist-avatar">
            <ArtworkImage
              src={artist.thumbnailUrl}
              alt={artist.name}
              className="artist-avatar-img"
              variant="hero"
              priority
            />
          </div>

          <div className="album-info">
            <span className="album-kind">Artist</span>
            <h1 className="album-title" title={artist.name}>
              {artist.name}
            </h1>
            {artist.subscribers && <p className="artist-subscribers">{artist.subscribers}</p>}
            {artist.description && <p className="artist-description">{artist.description}</p>}

            <div className="album-actions">
              <button
                type="button"
                className="album-play-btn"
                onClick={() => playFrom(songs)}
                disabled={songs.length === 0}
                aria-label="Play"
                title="Play"
              >
                <Play size={20} fill="currentColor" strokeWidth={0} />
              </button>
              <button
                type="button"
                className="album-glass-btn"
                onClick={() => playFrom(shuffled(songs))}
                disabled={songs.length < 2}
                aria-label="Shuffle"
                title="Shuffle"
              >
                <Shuffle size={17} />
              </button>
            </div>
          </div>
        </div>
      </header>

      <section className="playlist-tracks-section">
        <SectionHeader title="Top songs" />
        <div className="tracklist-header-row">
          <span className="col-num">#</span>
          <span className="col-title">Title</span>
          <span className="col-artist">Artist</span>
          <span className="col-time">Duration</span>
        </div>

        <div className="tracklist-rows">
          {songs.map((track, idx) => {
            const isTrackActive = currentVideoId === track.videoId;
            const trackItem = toItem(track);
            return (
              <div
                key={`${track.videoId}-${idx}`}
                className={`tracklist-row ${isTrackActive ? "active" : ""}`}
                onClick={() => onSelectTrack(trackItem, songItems)}
                onKeyDown={activateOnKey(() => onSelectTrack(trackItem, songItems))}
                role="button"
                tabIndex={0}
                aria-label={`Play ${track.title} by ${track.artist}`}
                aria-current={isTrackActive ? "true" : undefined}
                onContextMenu={(e) => onContextMenu(e, trackItem, "playlist", { contextList: songItems })}
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
                  <span className="track-row-title">{cleanDisplayTitle(track.title)}</span>
                </div>
                <span className="col-artist">
                  <ArtistLinks artist={track.artist} artists={track.artists} />
                </span>
                <div className="col-time-actions">
                  <div className="track-row-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="track-row-action-btn"
                      onClick={() => onPlayNext(trackItem)}
                      title="Play Next"
                      aria-label="Play Next"
                    >
                      <CornerDownRight size={13} />
                    </button>
                    <button
                      type="button"
                      className="track-row-action-btn"
                      onClick={() => onAddToQueue(trackItem)}
                      title="Add to Queue"
                      aria-label="Add to Queue"
                    >
                      <ListEnd size={13} />
                    </button>
                  </div>
                  <span className="col-time">{track.duration}</span>
                </div>
              </div>
            );
          })}
        </div>

        {songs.length === 0 && <p className="empty-message">No songs to show for this artist.</p>}
      </section>

      {artist.albums.length > 0 && (
        <section className="content-section">
          <SectionHeader title="Albums" />
          <CardGrid
            items={artist.albums}
            className="artist-shelf"
            currentVideoId={currentVideoId}
            currentPlaylistId={currentPlaylistId}
            onCardClick={onCardClick}
            onContextMenu={onContextMenu}
          />
        </section>
      )}

      {artist.singles.length > 0 && (
        <section className="content-section">
          <SectionHeader title="Singles & EPs" />
          <CardGrid
            items={artist.singles}
            className="artist-shelf"
            currentVideoId={currentVideoId}
            currentPlaylistId={currentPlaylistId}
            onCardClick={onCardClick}
            onContextMenu={onContextMenu}
          />
        </section>
      )}
    </div>
  );
}

/** The artist behind an opened page: loading, failure, then the page itself. */
export const ArtistView = memo(function ArtistView({
  artist,
  isLoading,
  error,
  onBack,
  ...page
}: ArtistViewProps) {
  if (isLoading) return <ArtistLoading />;
  if (error) return <ArtistError message={error} onBack={onBack} />;
  if (!artist) return null;
  return <ArtistPageView artist={artist} onBack={onBack} {...page} />;
});
