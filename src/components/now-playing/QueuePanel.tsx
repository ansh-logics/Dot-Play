import { memo, useState, type MouseEvent } from "react";
import { Reorder } from "motion/react";
import { CornerDownRight, ListPlus } from "lucide-react";
import { ArtworkImage } from "../ArtworkImage";
import { UpcomingQueueItem } from "../queue/UpcomingQueueItem";
import { useDragAutoScroll } from "../queue/useDragAutoScroll";
import type { SearchResult } from "../../lib/search";
import type { QueueSession } from "../../lib/queueManager";

export type QueueContextMenuHandler = (
  e: MouseEvent,
  track: SearchResult,
  source: "upcoming" | "history",
  extra?: { upcomingIndex?: number },
) => void;

export interface QueuePanelProps {
  session: QueueSession;
  /** Merged listening history, newest first. */
  history: SearchResult[];
  autoplay: boolean;
  isOpen: boolean;
  onSelectTrack: (track: SearchResult) => void;
  onReorderUpcoming: (upcoming: SearchResult[]) => void;
  onRemoveUpcoming: (index: number) => void;
  onClearUpcoming: () => void;
  onPlayNext: (track: SearchResult) => void;
  onAddToQueue: (track: SearchResult) => void;
  onContextMenu?: QueueContextMenuHandler;
}

/**
 * Memoised: the player re-renders ~10×/s with the playback time, and the queue's Reorder
 * list measures every row on each render, which stalled the sheet animation.
 */
export const QueuePanel = memo(function QueuePanel({
  session,
  history,
  autoplay,
  isOpen,
  onSelectTrack,
  onReorderUpcoming,
  onRemoveUpcoming,
  onClearUpcoming,
  onPlayNext,
  onAddToQueue,
  onContextMenu,
}: QueuePanelProps) {
  const [tab, setTab] = useState<"upcoming" | "history">("upcoming");
  const { listRef, onDragStateChange } = useDragAutoScroll();

  return (
    <div className="np-queue" aria-hidden={!isOpen} inert={!isOpen}>
      <div className="np-queue-head">
        <div className="np-segmented" role="tablist" aria-label="Queue">
          {(["upcoming", "history"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "is-active" : ""}
              onClick={() => setTab(t)}
            >
              {t === "upcoming" ? "Up Next" : "History"}
              <span className="np-count">{t === "upcoming" ? session.upcoming.length : history.length}</span>
            </button>
          ))}
        </div>
        {tab === "upcoming" && session.upcoming.length > 0 && (
          <button type="button" className="np-text-btn" onClick={onClearUpcoming}>
            Clear
          </button>
        )}
      </div>

      {tab === "upcoming" ? (
        session.upcoming.length === 0 ? (
          <p className="np-queue-empty">
            Nothing queued.{" "}
            {autoplay ? "Autoplay will keep the music going." : "Playback will stop after this song."}
          </p>
        ) : (
          <Reorder.Group
            as="div"
            axis="y"
            values={session.upcoming}
            onReorder={onReorderUpcoming}
            className="np-queue-list"
            ref={listRef}
            data-no-sheet-drag
          >
            {session.upcoming.map((track, index) => (
              <UpcomingQueueItem
                key={track.videoId}
                track={track}
                onPlay={onSelectTrack}
                onRemove={() => onRemoveUpcoming(index)}
                onContextMenu={onContextMenu ? (e) => onContextMenu(e, track, "upcoming", { upcomingIndex: index }) : undefined}
                onDragStateChange={onDragStateChange}
              />
            ))}
          </Reorder.Group>
        )
      ) : history.length === 0 ? (
        <p className="np-queue-empty">Songs you play will show up here.</p>
      ) : (
        <div className="np-queue-list" data-no-sheet-drag>
          {history.map((track, i) => (
            <div
              key={`${track.videoId}-${i}`}
              className="sidebar-queue-item history-item"
              role="button"
              tabIndex={0}
              onClick={() => onSelectTrack(track)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectTrack(track);
                }
              }}
              onContextMenu={onContextMenu ? (e) => onContextMenu(e, track, "history") : undefined}
            >
              <ArtworkImage
                src={track.thumbnailUrl}
                videoId={track.videoId}
                alt=""
                className="sidebar-queue-thumb"
                variant="thumbnail"
              />
              <div className="sidebar-queue-meta">
                <span className="sidebar-queue-item-title">{track.title}</span>
                <span className="sidebar-queue-item-artist">{track.artist}</span>
              </div>
              <div className="sidebar-history-actions" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="sidebar-history-btn" onClick={() => onPlayNext(track)} aria-label="Play next" title="Play next">
                  <CornerDownRight size={13} />
                </button>
                <button type="button" className="sidebar-history-btn" onClick={() => onAddToQueue(track)} aria-label="Add to queue" title="Add to queue">
                  <ListPlus size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
