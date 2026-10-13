import React, { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { type SearchResult } from "../../lib/search";
import { ArtworkImage } from "../ArtworkImage";
import { ListMusic, Play } from "lucide-react";

export interface QueueWheelProps {
  upcoming: SearchResult[];
  onSelectTrack: (track: SearchResult) => void;
  shouldReduceMotion?: boolean;
}

export const QueueWheel: React.FC<QueueWheelProps> = ({
  upcoming,
  onSelectTrack,
  shouldReduceMotion = false,
}) => {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<number | null>(null);

  const safeFocusedIndex = Math.min(
    focusedIndex,
    Math.max(0, upcoming.length - 1),
  );

  // Keyboard navigation when wheel is open
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((prev) => Math.min(upcoming.length - 1, prev + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (upcoming[safeFocusedIndex]) {
          onSelectTrack(upcoming[safeFocusedIndex]);
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [upcoming, safeFocusedIndex, onSelectTrack]);

  // Wheel event for stepping through tracks
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.stopPropagation();
      if (scrollTimeoutRef.current !== null) return;

      const delta = e.deltaY;
      if (Math.abs(delta) < 15) return;

      if (delta > 0) {
        setFocusedIndex((prev) => Math.min(upcoming.length - 1, prev + 1));
      } else {
        setFocusedIndex((prev) => Math.max(0, prev - 1));
      }

      scrollTimeoutRef.current = window.setTimeout(() => {
        scrollTimeoutRef.current = null;
      }, 100);
    },
    [upcoming.length]
  );

  // Window of items to display: +/- 3 around focusedIndex
  const visibleIndices: number[] = [];
  const range = 3;
  for (let offset = -range; offset <= range; offset++) {
    const idx = safeFocusedIndex + offset;
    if (idx >= 0 && idx < upcoming.length) {
      visibleIndices.push(idx);
    }
  }

  return (
    <motion.div
      className="fullscreen-queue-wheel-container"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      onWheel={handleWheel}
      ref={containerRef}
    >
      {upcoming.length === 0 ? (
        <div className="queue-wheel-empty">
          <ListMusic size={32} strokeWidth={1.5} style={{ opacity: 0.4 }} />
          <p>No upcoming tracks in queue</p>
          <span className="queue-wheel-hint">Add tracks from search or playlists</span>
        </div>
      ) : (
        <div className="queue-wheel-viewport">
          <div className="queue-wheel-stage">
            <AnimatePresence initial={false} mode="popLayout">
            {visibleIndices.map((idx) => {
              const track = upcoming[idx];
              const offset = idx - safeFocusedIndex;
              const isFocused = offset === 0;

              // 3D cylindrical transform values
              const rotateX = shouldReduceMotion ? 0 : offset * -20;
              const translateY = offset * 64;
              const scale = shouldReduceMotion
                ? 1
                : Math.max(0.76, 1 - Math.abs(offset) * 0.08);
              const opacity = Math.max(0.2, 1 - Math.abs(offset) * 0.26);
              const blur = shouldReduceMotion ? 0 : Math.min(3, Math.abs(offset) * 0.9);

              return (
                <motion.button
                  type="button"
                  key={`${track.videoId || track.title}-${idx}`}
                  className={`queue-wheel-item ${isFocused ? "focused" : ""}`}
                  initial={shouldReduceMotion ? false : { opacity: 0, y: translateY + 20, scale: 0.9 }}
                  animate={{
                    x: "-50%",
                    y: `calc(-50% + ${translateY}px)`,
                    rotateX,
                    scale,
                    opacity,
                    filter: `blur(${blur}px)`,
                  }}
                  exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: translateY - 20, scale: 0.9 }}
                  transition={shouldReduceMotion ? { duration: 0.1 } : {
                    type: "spring",
                    stiffness: 340,
                    damping: 30,
                    mass: 0.65,
                    opacity: { duration: 0.18 },
                    filter: { duration: 0.18 },
                  }}
                  style={{ zIndex: 10 - Math.abs(offset) }}
                  onClick={() => {
                    if (isFocused) {
                      onSelectTrack(track);
                    } else {
                      setFocusedIndex(idx);
                    }
                  }}
                >
                  <div className="queue-wheel-item-thumb">
                    <ArtworkImage
                      src={track.thumbnailUrl}
                      videoId={track.videoId}
                      alt={track.title}
                      variant="card"
                    />
                    {isFocused && (
                      <div className="queue-wheel-item-play-overlay">
                        <Play size={13} fill="#ffffff" strokeWidth={0} />
                      </div>
                    )}
                  </div>
                  <div className="queue-wheel-item-info">
                    <span className="queue-wheel-item-title">{track.title}</span>
                    <span className="queue-wheel-item-artist">{track.artist}</span>
                  </div>
                  {isFocused && (
                    <div className="queue-wheel-item-active-pill">
                      <span>PLAY</span>
                    </div>
                  )}
                </motion.button>
              );
            })}
            </AnimatePresence>
          </div>
        </div>
      )}

    </motion.div>
  );
};
