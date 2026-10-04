import React, { useRef } from "react";
import { useArtwork, type ArtworkVariant } from "../lib/imagePipeline";
import { Music } from "lucide-react";

export interface ArtworkImageProps {
  src: string;
  videoId?: string;
  artworkKey?: string;
  alt?: string;
  className?: string;
  priority?: boolean;
  variant?: ArtworkVariant;
}

export const ArtworkImage: React.FC<ArtworkImageProps> = ({
  src,
  videoId,
  artworkKey,
  alt = "",
  className = "",
  priority = false,
  variant = "card",
}) => {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const isPriority = priority || variant === "hero";

  const { currentUrl, isLoaded, hasError, onLoad, onError } = useArtwork({
    sourceUrl: src,
    videoId,
    artworkKey,
    variant,
    priority: isPriority,
  });

  return (
    <div className={`artwork-image-container ${className}`}>
      {/* Shimmering Skeleton while actively loading initial thumbnail */}
      {!isLoaded && !hasError && <div className="carousel-shimmer-skeleton" />}

      {/* Error / Fallback State */}
      {hasError ? (
        <div
          className="artwork-fallback-placeholder"
          aria-label={alt || "Artwork placeholder"}
        >
          <Music size={24} strokeWidth={1.5} className="fallback-music-icon" />
        </div>
      ) : (
        <img
          ref={imgRef}
          src={currentUrl}
          alt={alt}
          className={`artwork-img-element ${isLoaded ? "loaded" : ""}`}
          referrerPolicy="no-referrer"
          loading={isPriority ? "eager" : "lazy"}
          onLoad={onLoad}
          onError={onError}
        />
      )}
    </div>
  );
};
