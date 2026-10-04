import React, { useState, useEffect, useCallback, useRef } from "react";
import { ChevronLeft, ChevronRight, Play, Pause } from "lucide-react";
import type { SearchResult } from "../lib/search";
import { useArtwork } from "../lib/imagePipeline";

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
      setActiveIndex((prev) => (prev + offset + total) % total);
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
      />

      {/* Center card info overlay */}
      {isCenter && (
        <div className="carousel-card-overlay">
          <div className="carousel-meta-content">
            <h3 className="carousel-card-title">{item.title}</h3>
            <p className="carousel-card-artist">{item.artist}</p>
          </div>

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

  // Keyboard arrow controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT") return;
      if (e.key === "ArrowLeft") {
        handlePrev();
      } else if (e.key === "ArrowRight") {
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

  if (!items || total === 0) return null;

  return (
    <div
      className="top-picks-carousel-container"
      ref={containerRef}
      onWheel={handleWheel}
    >
      <div className="carousel-header">
        <div className="carousel-header-title">
          <span className="dot-red-accent" />
          <span className="carousel-heading-label">TOP PICKS</span>
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

      <div className="carousel-stage">
        <div className="carousel-cards-track">
          {items.map((item, index) => {
            // Circular wrapped offset on ring (like circular linked list)
            let offset = index - activeIndex;
            while (offset > total / 2) offset -= total;
            while (offset < -total / 2) offset += total;

            const absOffset = Math.abs(offset);
            const isVisible = absOffset <= 3;
            if (!isVisible) return null;

            const isCenter = offset === 0;
            const isItemPlaying = Boolean(
              isCenter &&
                isPlaying &&
                (currentTrackId === item.videoId ||
                  (item.playlistId && currentTrackId === item.playlistId)),
            );

            // 3D positioning calculation
            const translateX = offset * 220; // px spacing
            const translateZ = -absOffset * 90; // depth
            const scale = Math.max(1 - absOffset * 0.14, 0.65);
            const rotateY = offset * -12; // subtle inward tilt
            const zIndex = 20 - absOffset * 4;
            const brightness = isCenter ? 1 : Math.max(0.65 - absOffset * 0.18, 0.25);
            const opacity = isCenter ? 1 : Math.max(0.8 - absOffset * 0.25, 0.2);

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
