import { memo, useState } from "react";
import { Reorder } from "motion/react";
import { CornerDownRight, ListPlus } from "lucide-react";
import { ArtworkImage } from "../ArtworkImage";
import { UpcomingQueueItem } from "../queue/UpcomingQueueItem";
import { useDragAutoScroll } from "../queue/useDragAutoScroll";
import type { SearchResult } from "../../lib/search";
import type { CardContextMenuHandler } from "../../views/types";

interface SidebarQueueProps {
  isOpen: boolean;
  upcoming: SearchResult[];
  /** Merged listening history, newest first. */
  history: SearchResult[];
  onReorder: (upcoming: SearchResult[]) => void;
  onSelect: (track: SearchResult) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
  onPlayNext: (track: SearchResult) => void;
  onAddToQueue: (track: SearchResult) => void;
  onContextMenu: CardContextMenuHandler;
}

/**
 * Upcoming / History tabs inside the sidebar player card. Memoized so the progress
 * ticks that redraw the card don't redraw the whole draggable list.
 */
export const SidebarQueue = memo(function SidebarQueue({
  isOpen,
  upcoming,
  history,
  onReorder,
  onSelect,
  onRemove,
  onClear,
  onPlayNext,
  onAddToQueue,
  onContextMenu,
}: SidebarQueueProps) {
  const [activeTab, setActiveTab] = useState<"upcoming" | "history">("upcoming");
  const { listRef, onDragStateChange } = useDragAutoScroll();

  return (
    <div className={`sidebar-player-queue ${isOpen ? "open" : "collapsed"}`}>
      <div className="sidebar-queue-inner">
        <div className="sidebar-queue-header">
          <div className="sidebar-queue-tab-row">
            <button
              type="button"
              className={`sidebar-queue-tab ${activeTab === "upcoming" ? "active" : ""}`}
              onClick={() => setActiveTab("upcoming")}
            >
              <span>Upcoming</span>
              <span className="sidebar-queue-count">{upcoming.length}</span>
            </button>
            <button
              type="button"
              className={`sidebar-queue-tab ${activeTab === "history" ? "active" : ""}`}
              onClick={() => setActiveTab("history")}
            >
              <span>History</span>
              <span className="sidebar-queue-count">{history.length}</span>
            </button>
          </div>
          {activeTab === "upcoming" && upcoming.length > 0 && (
            <button
              type="button"
              className="sidebar-queue-clear-btn"
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
              title="Clear upcoming queue"
            >
              Clear
            </button>
          )}
        </div>

        {activeTab === "upcoming" ? (
          <Reorder.Group
            as="div"
            axis="y"
            values={upcoming}
            onReorder={onReorder}
            className="sidebar-queue-list"
            ref={listRef}
          >
            {upcoming.length === 0 ? (
              <div className="sidebar-queue-empty">No upcoming tracks</div>
            ) : (
              upcoming.map((track, index) => (
                <UpcomingQueueItem
                  key={track.videoId}
                  track={track}
                  onPlay={onSelect}
                  onRemove={() => onRemove(index)}
                  onContextMenu={(e) => onContextMenu(e, track, "upcoming", { upcomingIndex: index })}
                  onDragStateChange={onDragStateChange}
                />
              ))
            )}
          </Reorder.Group>
        ) : (
          /* Read-only, newest first; each row can be queued again. */
          <div className="sidebar-queue-list">
            {history.length === 0 ? (
              <div className="sidebar-queue-empty">No playback history</div>
            ) : (
              history.map((track, hIdx) => (
                <div
                  key={`${track.videoId}-${hIdx}`}
                  className="sidebar-queue-item history-item"
                  onContextMenu={(e) => onContextMenu(e, track, "history")}
                >
                  <ArtworkImage
                    src={track.thumbnailUrl}
                    videoId={track.videoId}
                    alt={track.title}
                    className="sidebar-queue-thumb"
                    variant="thumbnail"
                  />
                  <div className="sidebar-queue-meta">
                    <span className="sidebar-queue-item-title" title={track.title}>
                      {track.title}
                    </span>
                    <span className="sidebar-queue-item-artist" title={track.artist}>
                      {track.artist}
                    </span>
                  </div>
                  <div className="sidebar-history-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="sidebar-history-btn"
                      onClick={() => onPlayNext(track)}
                      title="Play next"
                      aria-label="Play next"
                    >
                      <CornerDownRight size={11} />
                    </button>
                    <button
                      type="button"
                      className="sidebar-history-btn"
                      onClick={() => onAddToQueue(track)}
                      title="Add to queue"
                      aria-label="Add to queue"
                    >
                      <ListPlus size={12} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
});
