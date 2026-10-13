import { useCallback, useRef, useState } from "react";
import { Reorder, useDragControls } from "motion/react";
import { X } from "lucide-react";
import { ArtworkImage } from "../ArtworkImage";
import type { SearchResult } from "../../lib/search";

export type UpcomingQueueItemProps = {
  track: SearchResult;
  onPlay: (track: SearchResult) => void;
  onRemove: (videoId: string) => void;
  onContextMenu?: (event: React.MouseEvent, track: SearchResult) => void;
  onDragStateChange?: (isDragging: boolean) => void;
};

export function UpcomingQueueItem({
  track,
  onPlay,
  onRemove,
  onContextMenu,
  onDragStateChange,
}: UpcomingQueueItemProps) {
  const dragControls = useDragControls();
  const [isHeld, setIsHeld] = useState(false);
  const holdTimerRef = useRef<number | null>(null);
  const isPointerDownRef = useRef(false);
  const hasDragStartedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const initialPosRef = useRef<{ x: number; y: number } | null>(null);

  const cleanupHold = useCallback(() => {
    isPointerDownRef.current = false;
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Only primary button
    if (event.button !== 0) return;

    // Do not initiate drag if interacting with the remove button
    if ((event.target as HTMLElement).closest(".sidebar-queue-remove-btn")) {
      return;
    }

    cleanupHold();
    isPointerDownRef.current = true;
    hasDragStartedRef.current = false;
    initialPosRef.current = { x: event.clientX, y: event.clientY };

    const nativeEvent = event.nativeEvent;

    holdTimerRef.current = window.setTimeout(() => {
      if (!isPointerDownRef.current) return;
      hasDragStartedRef.current = true;
      suppressClickRef.current = true;
      setIsHeld(true);
      onDragStateChange?.(true);
      dragControls.start(nativeEvent);
    }, 160);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isPointerDownRef.current || hasDragStartedRef.current || !initialPosRef.current) {
      return;
    }
    const dist = Math.hypot(
      event.clientX - initialPosRef.current.x,
      event.clientY - initialPosRef.current.y
    );
    // If movement is deliberate (> 10px) while held down, initiate drag immediately
    if (dist > 10) {
      cleanupHold();
      hasDragStartedRef.current = true;
      suppressClickRef.current = true;
      setIsHeld(true);
      onDragStateChange?.(true);
      dragControls.start(event.nativeEvent);
    }
  };

  const handlePointerUp = () => {
    cleanupHold();
  };

  const handlePointerCancel = () => {
    cleanupHold();
    if (hasDragStartedRef.current) {
      hasDragStartedRef.current = false;
      setIsHeld(false);
      onDragStateChange?.(false);
    }
  };

  const handleClick = (event: React.MouseEvent) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      event.stopPropagation();
      return;
    }
    onPlay(track);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onPlay(track);
    }
  };

  const handleDragEnd = () => {
    setIsHeld(false);
    hasDragStartedRef.current = false;
    onDragStateChange?.(false);
    // Suppress trailing click event from release
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 200);
  };

  return (
    <Reorder.Item
      as="div"
      value={track}
      className={`sidebar-queue-item ${isHeld ? "is-held-dragging" : ""}`}
      dragListener={false}
      dragControls={dragControls}
      whileDrag={{
        scale: 1.02,
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.6)",
        zIndex: 10,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onClick={handleClick}
      onContextMenu={(event) => {
        if (onContextMenu) {
          event.preventDefault();
          event.stopPropagation();
          onContextMenu(event, track);
        }
      }}
      onKeyDown={handleKeyDown}
      onDragEnd={handleDragEnd}
      role="button"
      tabIndex={0}
      title="Click to play, hold to reorder"
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
      <button
        type="button"
        className="sidebar-queue-remove-btn"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onRemove(track.videoId);
        }}
        title="Remove from queue"
        aria-label={`Remove ${track.title} from queue`}
      >
        <X size={10} strokeWidth={2.5} />
      </button>
    </Reorder.Item>
  );
}
