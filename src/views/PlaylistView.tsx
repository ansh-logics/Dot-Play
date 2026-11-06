import { activateOnKey } from "../lib/a11y";
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, CornerDownRight, ListEnd, Play, Search, Shuffle, Trash2, Upload } from "lucide-react";
import { ArtworkImage } from "../components/ArtworkImage";
import { cleanDisplayTitle } from "../lib/displayText";
import { useArtwork } from "../lib/imagePipeline";
import { SOURCE_NAMES, type ImportSource } from "../lib/imports";
import type { PlaylistDetails, PlaylistTrack, SearchResult } from "../lib/search";
import { useArtworkPalette } from "../lib/useArtworkPalette";
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
  /** Imported playlists: a song that wasn't found was clicked. */
  onFindMissing?: (track: PlaylistTrack) => void;
  /** Imported playlists: keep it on YouTube Music too, or delete the local copy. */
  importActions?: { onSaveToYouTube?: () => void; onDelete: () => void };
}

const ALBUM_KINDS = ["Album", "Single", "EP"];

/** "3:45" or "1:02:03" → seconds; 0 when unreadable. */
function durationSeconds(text: string): number {
  const parts = text.split(":").map(Number);
  if (parts.length < 2 || parts.some(Number.isNaN)) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function formatTotal(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

function shuffled<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * An opened album or playlist: an immersive banner washed in the cover's colours that runs
 * the full width of the window, then the songs. Once the banner scrolls away a slim bar
 * keeps the title and Play at the top.
 */
export const PlaylistView = memo(function PlaylistView({
  playlist,
  currentVideoId,
  onBack,
  onSelectTrack,
  onAppendToQueue,
  onPlayNext,
  onAddToQueue,
  onContextMenu,
  onFindMissing,
  importActions,
}: PlaylistViewProps) {
  const { tracks: allTracks } = playlist;
  // Imported songs that weren't found stay listed but never play.
  const tracks = allTracks.filter((t) => !t.missing);
  const isAlbum = playlist.id.startsWith("MPRE") || ALBUM_KINDS.includes(playlist.kind ?? "");
  const sourceName = playlist.source ? SOURCE_NAMES[playlist.source as ImportSource] : undefined;
  const kind = sourceName ? `${playlist.kind ?? "Playlist"} · Imported from ${sourceName}` : (playlist.kind ?? (isAlbum ? "Album" : "Playlist"));
  const title = cleanDisplayTitle(playlist.title);

  // Same URL the cover resolves to, so the colours match the pixels on screen.
  const { currentUrl: artUrl } = useArtwork({
    sourceUrl: playlist.thumbnailUrl,
    artworkKey: playlist.id,
    variant: "hero",
    priority: true,
  });
  const palette = useArtworkPalette(artUrl || undefined);

  const rootRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const [condensed, setCondensed] = useState(false);

  // Scroll drives the banner: the background drifts slower than the page, the cover eases
  // back, and past the banner the slim bar takes over. Written as CSS variables, so
  // scrolling never re-renders the song list.
  useEffect(() => {
    const root = rootRef.current;
    const hero = heroRef.current;
    const scroller = hero?.closest<HTMLElement>(".app-main-content");
    if (!root || !hero || !scroller) return;
    // The slim bar is fixed over the scroll area's top edge (not the scrollbar).
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
  }, [playlist.id]);

  const descriptionRef = useRef<HTMLParagraphElement>(null);
  // Delete takes two clicks: the first arms the button for a few seconds.
  const [deleteArmed, setDeleteArmed] = useState(false);
  useEffect(() => {
    if (!deleteArmed) return;
    const timer = window.setTimeout(() => setDeleteArmed(false), 3000);
    return () => window.clearTimeout(timer);
  }, [deleteArmed]);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [descriptionClipped, setDescriptionClipped] = useState(false);
  useLayoutEffect(() => {
    setDescriptionOpen(false);
  }, [playlist.id]);
  useLayoutEffect(() => {
    const el = descriptionRef.current;
    if (el && !descriptionOpen) setDescriptionClipped(el.scrollHeight > el.clientHeight + 1);
  }, [playlist.description, descriptionOpen]);

  const toItem = (track: PlaylistTrack): SearchResult => ({
    videoId: track.videoId,
    title: track.title,
    artist: track.artist,
    thumbnailUrl: track.thumbnailUrl,
    playlistId: playlist.id,
    itemType: "song",
  });
  const playFrom = (list: PlaylistTrack[]) => {
    if (list.length > 0) onSelectTrack(toItem(list[0]), list);
  };

  const totalSeconds = allTracks.reduce((sum, t) => sum + durationSeconds(t.duration), 0);
  const songCount = playlist.trackCount || (allTracks.length > 0 ? `${allTracks.length} ${allTracks.length === 1 ? "song" : "songs"}` : "");
  const meta = [
    playlist.artist ?? playlist.author,
    playlist.year,
    songCount,
    !playlist.trackCount && totalSeconds > 0 ? formatTotal(totalSeconds) : null,
  ].filter(Boolean);

  const tint = palette
    ? ({
        "--hero-c1": palette.colors[0],
        "--hero-c2": palette.colors[1],
        "--hero-c3": palette.colors[2],
        "--hero-base": palette.base,
      } as CSSProperties)
    : undefined;

  return (
    <div ref={rootRef} className={`playlist-detail-view ${isAlbum ? "is-album" : ""}`} style={tint}>
      <div className={`album-sticky-bar ${condensed ? "is-shown" : ""}`} aria-hidden={!condensed}>
        <button type="button" className="album-glass-btn is-small" onClick={onBack} aria-label="Back" tabIndex={condensed ? 0 : -1}>
          <ChevronLeft size={16} />
        </button>
        <ArtworkImage src={playlist.thumbnailUrl} alt="" className="album-sticky-art" variant="thumbnail" />
        <span className="album-sticky-title">{title}</span>
        <button
          type="button"
          className="album-play-btn is-small"
          onClick={() => playFrom(tracks)}
          disabled={tracks.length === 0}
          aria-label={`Play ${title}`}
          tabIndex={condensed ? 0 : -1}
        >
          <Play size={14} fill="currentColor" strokeWidth={0} />
        </button>
      </div>

      <header ref={heroRef} className="album-hero">
        <div className="album-hero-backdrop" aria-hidden="true">
          {artUrl && <img className="album-hero-blur" src={artUrl} alt="" referrerPolicy="no-referrer" />}
          <div className="album-hero-tint" />
          <div className="album-hero-fade" />
        </div>

        <button type="button" className="album-glass-btn album-back" onClick={onBack} aria-label="Back" title="Back">
          <ChevronLeft size={18} />
        </button>

        <div className="album-hero-content">
          <div className="album-cover">
            <ArtworkImage src={playlist.thumbnailUrl} alt={title} className="album-cover-img" variant="hero" priority />
          </div>

          <div className="album-info">
            <span className="album-kind">{kind}</span>
            <h1 className="album-title" title={title}>
              {title}
            </h1>
            {meta.length > 0 && (
              <p className="album-meta">
                {meta.map((part, i) => (
                  <span key={i} className={i === 0 ? "album-meta-lead" : undefined}>
                    {part}
                  </span>
                ))}
              </p>
            )}
            {playlist.description && (
              <div className="album-description-wrap">
                <p ref={descriptionRef} className={`album-description ${descriptionOpen ? "is-open" : ""}`}>
                  {playlist.description}
                </p>
                {(descriptionClipped || descriptionOpen) && (
                  <button type="button" className="album-more-btn" onClick={() => setDescriptionOpen((v) => !v)}>
                    {descriptionOpen ? "Less" : "More"}
                  </button>
                )}
              </div>
            )}

            <div className="album-actions">
              <button
                type="button"
                className="album-play-btn"
                onClick={() => playFrom(tracks)}
                disabled={tracks.length === 0}
                aria-label="Play"
                title="Play"
              >
                <Play size={20} fill="currentColor" strokeWidth={0} />
              </button>
              <button
                type="button"
                className="album-glass-btn"
                onClick={() => playFrom(shuffled(tracks))}
                disabled={tracks.length < 2}
                aria-label="Shuffle"
                title="Shuffle"
              >
                <Shuffle size={17} />
              </button>
              <button
                type="button"
                className="album-glass-btn"
                onClick={() => onAppendToQueue(tracks)}
                disabled={tracks.length === 0}
                aria-label="Add all to queue"
                title="Add all to queue"
              >
                <ListEnd size={17} />
              </button>
              {importActions?.onSaveToYouTube && (
                <button
                  type="button"
                  className="album-glass-btn"
                  onClick={importActions.onSaveToYouTube}
                  disabled={tracks.length === 0}
                  aria-label="Save to YouTube Music"
                  title="Save to YouTube Music"
                >
                  <Upload size={17} />
                </button>
              )}
              {importActions && (
                <button
                  type="button"
                  className={`album-glass-btn ${deleteArmed ? "is-armed" : ""}`}
                  onClick={() => (deleteArmed ? importActions.onDelete() : setDeleteArmed(true))}
                  onBlur={() => setDeleteArmed(false)}
                  aria-label={deleteArmed ? "Click again to delete" : "Delete imported playlist"}
                  title={deleteArmed ? "Click again to delete" : "Delete imported playlist"}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
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
          {allTracks.map((track, idx) => {
            if (track.missing) {
              return (
                <div
                  key={`missing-${idx}`}
                  className="tracklist-row is-missing"
                  onClick={() => onFindMissing?.(track)}
                  onKeyDown={activateOnKey(() => onFindMissing?.(track))}
                  role="button"
                  tabIndex={0}
                  aria-label={`${track.title} by ${track.artist}, not found on YouTube Music. Search for it.`}
                  title="Not found on YouTube Music. Click to search for it."
                >
                  <span className="col-num">{idx + 1}</span>
                  <div className="col-title-wrap">
                    {!isAlbum && (
                      <ArtworkImage src={track.thumbnailUrl} alt={track.title} className="track-row-thumb" variant="thumbnail" />
                    )}
                    <span className="track-row-title">{track.title}</span>
                  </div>
                  <span className="col-artist">{track.artist}</span>
                  <div className="col-time-actions">
                    <span className="track-row-missing-note">
                      <Search size={12} /> Not found
                    </span>
                  </div>
                </div>
              );
            }
            const isTrackActive = currentVideoId === track.videoId;
            const trackItem = toItem(track);
            return (
              <div
                key={`${track.videoId}-${idx}`}
                className={`tracklist-row ${isTrackActive ? "active" : ""}`}
                onClick={() => onSelectTrack(trackItem, tracks)}
                onKeyDown={activateOnKey(() => onSelectTrack(trackItem, tracks))}
                role="button"
                tabIndex={0}
                aria-label={`Play ${track.title} by ${track.artist}`}
                aria-current={isTrackActive ? "true" : undefined}
                onContextMenu={(e) => onContextMenu(e, trackItem, "playlist", { contextList: tracks })}
              >
                <span className="col-num">
                  {isTrackActive ? <Play size={12} fill="currentColor" strokeWidth={0} /> : idx + 1}
                </span>
                <div className="col-title-wrap">
                  {/* Every song on an album shares its cover, so albums list numbers only. */}
                  {!isAlbum && (
                    <ArtworkImage
                      src={track.thumbnailUrl}
                      videoId={track.videoId}
                      alt={track.title}
                      className="track-row-thumb"
                      variant="thumbnail"
                    />
                  )}
                  <span className="track-row-title">{track.title}</span>
                </div>
                <span className="col-artist">{track.artist}</span>
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

        {allTracks.length === 0 && <p className="empty-message">No playable tracks found in this playlist.</p>}
      </section>
    </div>
  );
});
