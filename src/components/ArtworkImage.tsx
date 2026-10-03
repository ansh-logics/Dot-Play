import React, { useState, useEffect, useRef } from "react";
import {
  optimizeThumbnailUrl,
  getFallbackArtwork,
  queueForHighResProbe,
  subscribeToImagePipeline,
} from "../lib/imagePipeline";
import { markArtworkVerified } from "../lib/trackCache";
import { Music } from "lucide-react";

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
  const [retryCount, setRetryCount] = useState(0);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear watchdog timer helper
  const clearWatchdog = () => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  };

  // 1. When props change, evaluate optimal URL and start watchdog
  useEffect(() => {
    const nextUrl = optimizeThumbnailUrl(src, videoId);
    setCurrentSrc(nextUrl);
    setIsLoaded(false);
    setHasError(false);
    setRetryCount(0);

    if (videoId) {
      queueForHighResProbe(videoId, src);
    }
  }, [src, videoId]);

  // 2. Immediate check for cached/completed images
  useEffect(() => {
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
      setIsLoaded(true);
      if (videoId && currentSrc) {
        markArtworkVerified(videoId, currentSrc);
      }
    }
  }, [currentSrc, videoId]);

  // 3. Watchdog Auto-Refresh Timer: recovers if image stalls in shimmering state
  useEffect(() => {
    clearWatchdog();

    if (!isLoaded && !hasError && currentSrc) {
      watchdogRef.current = setTimeout(() => {
        // Image has stalled for 2.5 seconds without firing onLoad or onError
        if (videoId) {
          const fallback = getFallbackArtwork(videoId, currentSrc);
          if (fallback && fallback !== currentSrc && retryCount < 2) {
            setRetryCount((prev) => prev + 1);
            setCurrentSrc(fallback);
            return;
          }
        }
        // If already on fallback or no videoId, force dismiss stuck shimmer
        setIsLoaded(true);
      }, 2500);
    }

    return () => clearWatchdog();
  }, [isLoaded, hasError, currentSrc, videoId, retryCount]);

  // 4. Subscribe to background high-res probe results from Rust backend
  useEffect(() => {
    if (!videoId) return;

    return subscribeToImagePipeline((resolved) => {
      if (resolved[videoId] && resolved[videoId] !== currentSrc) {
        setCurrentSrc(resolved[videoId]);
        setIsLoaded(false);
      }
    });
  }, [videoId, currentSrc]);

  return (
    <div className={`artwork-image-container ${className}`}>
      {/* Shimmering Skeleton while actively loading */}
      {!isLoaded && !hasError && <div className="carousel-shimmer-skeleton" />}

      {/* Error / Fallback State */}
      {hasError ? (
        <div className="artwork-fallback-placeholder" aria-label={alt || "Artwork placeholder"}>
          <Music size={24} strokeWidth={1.5} className="fallback-music-icon" />
        </div>
      ) : (
        <img
          ref={imgRef}
          src={currentSrc}
          alt={alt}
          className={`artwork-img-element ${isLoaded ? "loaded" : ""}`}
          referrerPolicy="no-referrer"
          loading={priority ? "eager" : "lazy"}
          onLoad={() => {
            clearWatchdog();
            setIsLoaded(true);
            setHasError(false);
            if (videoId && currentSrc) {
              markArtworkVerified(videoId, currentSrc);
            }
          }}
          onError={() => {
            clearWatchdog();
            if (videoId) {
              const fallback = getFallbackArtwork(videoId, currentSrc);
              if (fallback && fallback !== currentSrc && retryCount < 2) {
                setRetryCount((prev) => prev + 1);
                setCurrentSrc(fallback);
                return;
              }
            }
            setHasError(true);
            setIsLoaded(true);
          }}
        />
      )}
    </div>
  );
};
