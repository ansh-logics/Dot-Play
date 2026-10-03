import React, { useState, useEffect } from "react";
import {
  optimizeThumbnailUrl,
  queueForHighResProbe,
  subscribeToImagePipeline,
} from "../lib/imagePipeline";

interface ArtworkImageProps {
  src: string;
  videoId?: string;
  alt?: string;
  className?: string;
  priority?: boolean;
}

export const ArtworkImage: React.FC<ArtworkImageProps> = ({
  src,
  videoId,
  alt = "",
  className = "",
  priority = false,
}) => {
  const initialUrl = optimizeThumbnailUrl(src, videoId);
  const [currentSrc, setCurrentSrc] = useState(initialUrl);
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);

  // When props change, re-evaluate
  useEffect(() => {
    const nextUrl = optimizeThumbnailUrl(src, videoId);
    setCurrentSrc(nextUrl);
    setIsLoaded(false);
    setHasError(false);

    if (videoId) {
      queueForHighResProbe(videoId, src);
    }
  }, [src, videoId]);

  // Subscribe to background high-res probe results
  useEffect(() => {
    if (!videoId) return;

    return subscribeToImagePipeline((resolved) => {
      if (resolved[videoId] && resolved[videoId] !== currentSrc) {
        setCurrentSrc(resolved[videoId]);
      }
    });
  }, [videoId, currentSrc]);

  return (
    <div className={`artwork-image-container ${className}`}>
      {/* Shimmering Skeleton while loading */}
      {!isLoaded && !hasError && <div className="carousel-shimmer-skeleton" />}

      <img
        src={currentSrc}
        alt={alt}
        className={`artwork-img-element ${isLoaded ? "loaded" : ""}`}
        referrerPolicy="no-referrer"
        loading={priority ? "eager" : "lazy"}
        onLoad={() => setIsLoaded(true)}
        onError={() => {
          if (
            videoId &&
            currentSrc !== `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
          ) {
            // Try standard hqdefault fallback
            setCurrentSrc(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
          } else {
            setHasError(true);
            setIsLoaded(true);
          }
        }}
      />
    </div>
  );
};
