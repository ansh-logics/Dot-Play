import { Play } from "lucide-react";
import { ArtworkImage } from "./ArtworkImage";
import { cleanDisplayTitle } from "../lib/displayText";
import type { SearchResult } from "../lib/search";
import type { CardClickHandler, CardContextMenuHandler } from "../views/types";
import { isActiveItem, playableOnly } from "../lib/trackItems";

type ItemKind = "song" | "playlist";

interface TrackCardProps {
  item: SearchResult;
  isActive: boolean;
  /** What an item without an itemType counts as (library shelves hold playlists). */
  fallbackKind: ItemKind;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

/** Artwork card used by every shelf and results grid. */
export function TrackCard({ item, isActive, fallbackKind, onClick, onContextMenu }: TrackCardProps) {
  const kind = item.itemType || fallbackKind;
  const isPlaylist = fallbackKind === "song" ? kind === "playlist" : kind !== "song";
  return (
    <button
      type="button"
      className={`track-card ${isActive ? "active" : ""}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className="card-thumb-wrap">
        <ArtworkImage src={item.thumbnailUrl} videoId={item.videoId} alt={item.title} />
        <span className={`card-type-pill ${kind}`}>{isPlaylist ? "Playlist" : "Song"}</span>
        <span className="card-play-indicator">
          <Play size={13} fill="currentColor" strokeWidth={0} style={{ marginLeft: 1 }} />
        </span>
      </div>
      <div className="card-meta">
        <p className="card-title" title={item.title}>
          {cleanDisplayTitle(item.title)}
        </p>
        <p className="card-artist">{item.artist}</p>
      </div>
    </button>
  );
}

interface CardGridProps {
  items: SearchResult[];
  className?: string;
  keyPrefix?: string;
  fallbackKind?: ItemKind;
  /** Pass the playable items as the queue context when a card is played. */
  withContext?: boolean;
  /** The list the context comes from, when it is wider than the cards shown. */
  contextSource?: SearchResult[];
  currentVideoId: string | undefined;
  currentPlaylistId: string | undefined;
  onCardClick: CardClickHandler;
  onContextMenu: CardContextMenuHandler;
}

export function CardGrid({
  items,
  className = "shelves-grid",
  keyPrefix = "",
  fallbackKind = "song",
  withContext = true,
  contextSource = items,
  currentVideoId,
  currentPlaylistId,
  onCardClick,
  onContextMenu,
}: CardGridProps) {
  return (
    <div className={className}>
      {items.map((item, itemIdx) => (
        <TrackCard
          key={item.videoId || item.playlistId || `${keyPrefix}${itemIdx}`}
          item={item}
          isActive={isActiveItem(item, currentVideoId, currentPlaylistId)}
          fallbackKind={fallbackKind}
          onClick={() => onCardClick(item, withContext ? playableOnly(contextSource) : undefined)}
          onContextMenu={(e) =>
            onContextMenu(
              e,
              item,
              "card",
              withContext ? { contextList: playableOnly(contextSource) } : undefined,
            )
          }
        />
      ))}
    </div>
  );
}
