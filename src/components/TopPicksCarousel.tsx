import React, { useState, useEffect, useCallback, useRef } from "react";
import { ChevronLeft, ChevronRight, Play, Pause } from "lucide-react";
import type { SearchResult } from "../lib/search";
import { useArtwork } from "../lib/imagePipeline";
import { cleanDisplayTitle } from "../lib/displayText";

/** Horizontal distance between neighbouring cards, in px. */
const CARD_SPACING = 220;
/** Movement before a press becomes a drag (below it, it is a click). */
const DRAG_THRESHOLD_PX = 6;
/** A released drag keeps going for about this long at its release speed. */
const FLING_SECONDS = 0.2;
const VELOCITY_WINDOW_MS = 90;

interface TopPicksCarouselProps {
  items: SearchResult[];
  onPlay: (item: SearchResult) => void;
  onOpenPlaylist?: (playlistId: string) => void;
  onContextMenu?: (e: React.MouseEvent, item: SearchResult) => void;
  currentTrackId?: string;
  isPlaying?: boolean;
}

interface CarouselCardItemProps {
  item: SearchResult;
  index: number;
  offset: number;
  absOffset: number;
  total: number;
  isCenter: boolean;
  isItemPlaying: boolean;
  transformStyle: React.CSSProperties;
  onPlay: (item: SearchResult) => void;
  onOpenPlaylist?: (playlistId: string) => void;
  onContextMenu?: (e: React.MouseEvent, item: SearchResult) => void;
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
}

const CarouselCardItem: React.FC<CarouselCardItemProps> = ({
  item,
  offset,
  absOffset,
  total,
  isCenter,
  isItemPlaying,
  transformStyle,
  onPlay,
  onOpenPlaylist,
  onContextMenu,
  setActiveIndex,
}) => {
  const { currentUrl, isLoaded, onLoad, onError } = useArtwork({
    sourceUrl: item.thumbnailUrl,
    videoId: item.videoId,
    variant: "hero",
    priority: isCenter || absOffset <= 1,
  });

  const handleCardClick = () => {
    if (!isCenter) {
      setActiveIndex((prev) => (prev + Math.round(offset) + total) % total);
    } else {
      if (item.itemType === "playlist" && item.playlistId && onOpenPlaylist) {
        onOpenPlaylist(item.playlistId);
      } else {
        onPlay(item);
      }
    }
  };

  const handlePlayClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (item.itemType === "playlist" && item.playlistId && onOpenPlaylist) {
      onOpenPlaylist(item.playlistId);
    } else {
      onPlay(item);
    }
  };

  return (
    <div
      className={`carousel-card ${isCenter ? "is-center" : "is-side"}`}
      style={transformStyle}
      onClick={handleCardClick}
      onContextMenu={(e) => {
        if (onContextMenu) {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e, item);
        }
      }}
    >
      {/* Shimmering Skeleton Loader until Image Loads */}
      {!isLoaded && <div className="carousel-shimmer-skeleton" />}

      <img
        src={currentUrl}
        alt={item.title}
        className={`carousel-card-img ${isLoaded ? "loaded" : ""}`}
        referrerPolicy="no-referrer"
        onLoad={onLoad}
        onError={onError}
        loading={absOffset <= 1 ? "eager" : "lazy"}
        draggable={false}
      />

      {/* Play control sits on the artwork corner; the caption lives below the stage. */}
      {isCenter && (
        <div className="carousel-card-actions">
          <button
            type="button"
            className={`carousel-play-btn ${isItemPlaying ? "playing" : ""}`}
            onClick={handlePlayClick}
            aria-label={isItemPlaying ? "Pause" : "Play"}
          >
            {isItemPlaying ? (
              <Pause size={18} fill="currentColor" strokeWidth={0} />
            ) : (
              <Play
                size={18}
                fill="currentColor"
                strokeWidth={0}
                style={{ marginLeft: 2 }}
              />
            )}
          </button>
        </div>
      )}
    </div>
  );
};

export const TopPicksCarousel: React.FC<TopPicksCarouselProps> = ({
  items,
  onPlay,
  onOpenPlaylist,
  onContextMenu,
  currentTrackId,
  isPlaying,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastScrollTimeRef = useRef(0);
  /** Live drag distance in px; the cards follow it, then settle on the nearest card. */
  const [dragPx, setDragPx] = useState(0);
  const dragRef = useRef<{
    x: number;
    pointerId: number;
    dragging: boolean;
    samples: { t: number; x: number }[];
  } | null>(null);
  /** Set when a drag ends, so the click that follows the release doesn't also play a card. */
  const suppressClickRef = useRef(false);

  const total = items.length;

  // Keep active index in bounds if items change
  useEffect(() => {
    if (total > 0 && activeIndex >= total) {
      setActiveIndex(0);
    }
  }, [total, activeIndex]);

  // Infinite circular navigation (10 -> 0, 0 -> 10)
  const handlePrev = useCallback(() => {
    if (total === 0) return;
    setActiveIndex((prev) => (prev - 1 + total) % total);
  }, [total]);

  const handleNext = useCallback(() => {
    if (total === 0) return;
    setActiveIndex((prev) => (prev + 1) % total);
  }, [total]);

  // Arrow keys turn the carousel only while focus is inside it; elsewhere they seek the song.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.target instanceof Node) || !containerRef.current?.contains(e.target)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault(); // tells the global seek shortcut the key is taken
        handlePrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        handleNext();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handlePrev, handleNext]);

  // Mouse wheel / trackpad horizontal swipe
  const handleWheel = (e: React.WheelEvent) => {
    const now = Date.now();
    if (now - lastScrollTimeRef.current < 280) return;
    if (Math.abs(e.deltaX) > 20 || Math.abs(e.deltaY) > 30) {
      if (e.deltaX > 20 || e.deltaY > 30) {
        handleNext();
        lastScrollTimeRef.current = now;
      } else if (e.deltaX < -20 || e.deltaY < -30) {
        handlePrev();
        lastScrollTimeRef.current = now;
      }
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || total === 0) return;
    dragRef.current = { x: e.clientX, pointerId: e.pointerId, dragging: false, samples: [{ t: e.timeStamp, x: e.clientX }] };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.x;
    if (!d.dragging) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      // Capture only once it is a drag, so a plain click still reaches the card.
      d.dragging = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    d.samples.push({ t: e.timeStamp, x: e.clientX });
    while (d.samples.length > 2 && e.timeStamp - d.samples[0].t > VELOCITY_WINDOW_MS) d.samples.shift();
    setDragPx(dx);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !d.dragging) return;
    suppressClickRef.current = true;
    // Release speed carries on: a flick travels several cards, a slow drag settles nearby.
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    const stale = e.timeStamp - last.t > VELOCITY_WINDOW_MS;
    const velocity = dt > 0 && !stale ? (last.x - first.x) / dt : 0;
    const travelled = e.clientX - d.x + velocity * FLING_SECONDS;
    const steps = Math.max(-(total - 1), Math.min(total - 1, Math.round(-travelled / CARD_SPACING)));
    if (steps !== 0) setActiveIndex((prev) => (((prev + steps) % total) + total) % total);
    setDragPx(0);
  };

  if (!items || total === 0) return null;

  return (
    <div
      className={`top-picks-carousel-container ${dragPx !== 0 ? "is-dragging" : ""}`}
      ref={containerRef}
      onWheel={handleWheel}
    >
      <div className="carousel-header">
        <div className="carousel-header-title">
          <span className="dot-red-accent" />
          <span className="carousel-heading-label">Top Picks</span>
        </div>
        <div className="carousel-nav-arrows">
          <button
            type="button"
            className="carousel-arrow-btn"
            onClick={handlePrev}
            aria-label="Previous card"
            title="Previous (Infinite)"
          >
            <ChevronLeft size={16} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            className="carousel-arrow-btn"
            onClick={handleNext}
            aria-label="Next card"
            title="Next (Infinite)"
          >
            <ChevronRight size={16} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      <div
        className="carousel-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={(e) => {
          if (!suppressClickRef.current) return;
          suppressClickRef.current = false;
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        <div className="carousel-cards-track">
          {items.map((item, index) => {
            // Circular wrapped offset on ring (like circular linked list)
            // While dragging, positions are fractional: the cards follow the pointer.
            let offset = index - activeIndex + dragPx / CARD_SPACING;
            while (offset > total / 2) offset -= total;
            while (offset < -total / 2) offset += total;

            const absOffset = Math.abs(offset);
            const isVisible = absOffset <= 3.5;
            if (!isVisible) return null;

            const isCenter = Math.round(offset) === 0;
            const isItemPlaying = Boolean(
              isCenter &&
                isPlaying &&
                (currentTrackId === item.videoId ||
                  (item.playlistId && currentTrackId === item.playlistId)),
            );

            // 3D positioning calculation
            const translateX = offset * CARD_SPACING;
            const translateZ = -absOffset * 90; // depth
            const scale = Math.max(1 - absOffset * 0.14, 0.65);
            const rotateY = offset * -12; // subtle inward tilt
            const zIndex = 20 - absOffset * 4;
            const brightness = isCenter ? 1 : Math.max(0.85 - absOffset * 0.15, 0.45);
            const opacity = isCenter ? 1 : Math.max(0.95 - absOffset * 0.2, 0.35);

            const transformStyle: React.CSSProperties = {
              transform: `translateX(${translateX}px) translateZ(${translateZ}px) rotateY(${rotateY}deg) scale(${scale})`,
              zIndex,
              opacity,
              filter: `brightness(${brightness})`,
            };

            return (
              <CarouselCardItem
                key={item.videoId || item.playlistId || index}
                item={item}
                index={index}
                offset={offset}
                absOffset={absOffset}
                total={total}
                isCenter={isCenter}
                isItemPlaying={isItemPlaying}
                transformStyle={transformStyle}
                onPlay={onPlay}
                onOpenPlaylist={onOpenPlaylist}
                onContextMenu={onContextMenu}
                setActiveIndex={setActiveIndex}
              />
            );
          })}
        </div>
      </div>

      {/* Apple-style caption under the centre cover; re-keyed so it fades in per item. */}
      {items[activeIndex] && (
        <div className="carousel-caption" key={items[activeIndex].videoId || items[activeIndex].playlistId || activeIndex}>
          <h3 className="carousel-caption-title" title={items[activeIndex].title}>
            {cleanDisplayTitle(items[activeIndex].title)}
          </h3>
          <p className="carousel-caption-artist" title={items[activeIndex].artist}>
            {items[activeIndex].artist}
          </p>
        </div>
      )}

      {/* Pagination indicators */}
      <div className="carousel-indicators">
        {items.slice(0, Math.min(items.length, 10)).map((_, i) => (
          <button
            key={i}
            type="button"
            className={`carousel-dot-btn ${i === activeIndex ? "active" : ""}`}
            onClick={() => setActiveIndex(i)}
            aria-label={`Go to slide ${i + 1}`}
          />
        ))}
      </div>
    </div>
  );
};
