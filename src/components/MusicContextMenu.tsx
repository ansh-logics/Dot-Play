import React, { useEffect, useRef, useState, useLayoutEffect } from "react";
import { Play, CornerDownRight, ListPlus, Trash2, FolderOpen } from "lucide-react";
import type { SearchResult } from "../lib/search";
import { ArtworkImage } from "./ArtworkImage";

export type MusicContextTarget = {
  track: SearchResult;
  source: "card" | "playlist" | "upcoming" | "history" | "top-picks";
  upcomingIndex?: number;
  contextList?: SearchResult[];
  x: number;
  y: number;
};

export interface MusicContextMenuProps {
  target: MusicContextTarget | null;
  onClose: () => void;
  onPlayNow: (track: SearchResult, contextList?: SearchResult[]) => void;
  onPlayNext: (track: SearchResult) => void;
  onAddToQueue: (track: SearchResult) => void;
  onRemoveFromQueue?: (index: number) => void;
  onOpenPlaylist?: (playlistId: string) => void;
}

export const MusicContextMenu: React.FC<MusicContextMenuProps> = ({
  target,
  onClose,
  onPlayNow,
  onPlayNext,
  onAddToQueue,
  onRemoveFromQueue,
  onOpenPlaylist,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!target) return;

    const menuEl = menuRef.current;
    const width = menuEl ? menuEl.offsetWidth : 230;
    const height = menuEl ? menuEl.offsetHeight : 210;

    const padding = 12;
    const maxX = window.innerWidth - width - padding;
    const maxY = window.innerHeight - height - padding;

    // Prefer positioning at cursor; flip/clamp if near viewport boundary
    const x = Math.max(padding, Math.min(target.x, maxX));
    const y = Math.max(padding, Math.min(target.y, maxY));

    setCoords({ x, y });
  }, [target]);

  useEffect(() => {
    if (!target) return;

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    const handleScroll = () => {
      onClose();
    };

    window.addEventListener("pointerdown", handleClickOutside, { capture: true });
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    window.addEventListener("resize", handleScroll);

    return () => {
      window.removeEventListener("pointerdown", handleClickOutside, { capture: true });
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, { capture: true });
      window.removeEventListener("resize", handleScroll);
    };
  }, [target, onClose]);

  if (!target) return null;

  const { track, source, upcomingIndex, contextList } = target;
  const isPlaylistType = Boolean(track.playlistId && track.itemType === "playlist");
  const hasPlayableTrack = Boolean(track.videoId);

  return (
    <div
      ref={menuRef}
      className="music-context-menu"
      style={{
        top: coords.y,
        left: coords.x,
      }}
      role="menu"
      aria-label="Music options"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Header with track preview */}
      <div className="music-context-header">
        <ArtworkImage
          src={track.thumbnailUrl}
          videoId={track.videoId}
          alt={track.title}
          className="music-context-thumb"
          variant="thumbnail"
        />
        <div className="music-context-meta">
          <span className="music-context-title" title={track.title}>
            {track.title}
          </span>
          <span className="music-context-artist" title={track.artist}>
            {track.artist}
          </span>
        </div>
      </div>

      <div className="music-context-divider" />

      {/* Menu Actions */}
      <div className="music-context-items">
        {/* Open Playlist action if target is a playlist card */}
        {isPlaylistType && onOpenPlaylist && track.playlistId && (
          <button
            type="button"
            className="music-context-item"
            role="menuitem"
            onClick={() => {
              onClose();
              onOpenPlaylist(track.playlistId!);
            }}
          >
            <FolderOpen size={14} className="music-context-icon" />
            <span>Open Playlist</span>
          </button>
        )}

        {/* Play Now */}
        {hasPlayableTrack && (
          <button
            type="button"
            className="music-context-item action-play"
            role="menuitem"
            onClick={() => {
              onClose();
              // Only playlist rows establish a playback context. Search, Home,
              // history, and recommendation cards should play just one track.
              onPlayNow(track, source === "playlist" ? contextList : undefined);
            }}
          >
            <Play size={14} fill="currentColor" strokeWidth={0} className="music-context-icon" />
            <span>Play Now</span>
          </button>
        )}

        {/* Play Next */}
        {hasPlayableTrack && (
          <button
            type="button"
            className="music-context-item"
            role="menuitem"
            onClick={() => {
              onClose();
              onPlayNext(track);
            }}
          >
            <CornerDownRight size={14} className="music-context-icon" />
            <span>Play Next</span>
          </button>
        )}

        {/* Add to Queue */}
        {hasPlayableTrack && (
          <button
            type="button"
            className="music-context-item"
            role="menuitem"
            onClick={() => {
              onClose();
              onAddToQueue(track);
            }}
          >
            <ListPlus size={14} className="music-context-icon" />
            <span>Add to Queue</span>
          </button>
        )}

        {/* Remove from Upcoming Queue (only for upcoming tracks) */}
        {source === "upcoming" &&
          upcomingIndex !== undefined &&
          onRemoveFromQueue && (
            <>
              <div className="music-context-divider" />
              <button
                type="button"
                className="music-context-item action-remove"
                role="menuitem"
                onClick={() => {
                  onClose();
                  onRemoveFromQueue(upcomingIndex);
                }}
              >
                <Trash2 size={14} className="music-context-icon" />
                <span>Remove from Queue</span>
              </button>
            </>
          )}
      </div>
    </div>
  );
};
