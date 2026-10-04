import { useState, useEffect, useRef, useCallback } from "react";
import { getCachedArtwork, markArtworkVerified } from "./trackCache";

export type ArtworkVariant = "thumbnail" | "card" | "hero";

// 1. Authoritative in-memory states
export const cached = new Map<string, string>();
export const queued = new Set<string>();
export const processing = new Set<string>();

// Negative cache: videoId -> timestamp when last checked with no upgrade found
export const checkedNegative = new Map<string, number>();
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Subscribers: videoId -> Set of callbacks
const subscribers = new Map<string, Set<(url: string) => void>>();

// Cache configuration
const STORAGE_KEY = "dot_highres_image_cache";
const MAX_CACHE_ENTRIES = 1200;

// Restore verified cache from localStorage on startup
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    const parsed = JSON.parse(saved) as Record<string, string>;
    for (const [k, v] of Object.entries(parsed)) {
      if (k && v) {
        cached.set(k, v);
      }
    }
  }
} catch {
  // Ignore storage access error
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistCacheDebounced() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const entries = Array.from(cached.entries()).slice(-MAX_CACHE_ENTRIES);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // Storage quota or error
    }
  }, 1000);
}

/**
 * Sets an entry in the verified cache with bounded FIFO eviction.
 */
function setCachedEntry(videoId: string, url: string) {
  if (cached.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cached.keys().next().value;
    if (oldestKey) cached.delete(oldestKey);
  }
  cached.set(videoId, url);
  markArtworkVerified(videoId, url);
  persistCacheDebounced();
}

/**
 * Checks whether an ID was recently checked and had no upgrade.
 */
function isNegativeCached(videoId: string): boolean {
  const timestamp = checkedNegative.get(videoId);
  if (!timestamp) return false;
  if (Date.now() - timestamp > NEGATIVE_CACHE_TTL_MS) {
    checkedNegative.delete(videoId);
    return false;
  }
  return true;
}

/**
 * Synchronously retrieves cached HD artwork URL if already verified.
 */
export function getCachedArtworkUrl(videoId?: string): string | null {
  if (!videoId) return null;
  if (cached.has(videoId)) {
    return cached.get(videoId)!;
  }
  const fromTrackCache = getCachedArtwork(videoId);
  if (fromTrackCache) {
    cached.set(videoId, fromTrackCache);
    return fromTrackCache;
  }
  return null;
}

/**
 * Optimizes a thumbnail URL immediately for instant UI display (0ms latency).
 * Respects the requested display variant:
 * - "thumbnail": lightweight (160x160) for small 32-64px rows/player bar
 * - "card": high-res (544x544) for shelves and search cards
 * - "hero": master quality (800x800) for large carousel / now-playing hero cards
 */
export function optimizeThumbnailUrl(
  rawUrl: string,
  videoId?: string,
  variant: ArtworkVariant = "card"
): string {
  if (videoId) {
    const cachedUrl = getCachedArtworkUrl(videoId);
    if (cachedUrl) {
      const isGoogle = cachedUrl.includes("googleusercontent.com") || cachedUrl.includes("ggpht.com");
      if (
        isGoogle &&
        ((variant === "hero" && !cachedUrl.includes("=w800") && !cachedUrl.includes("=s800")) ||
         (variant === "card" && (cachedUrl.includes("=w160") || cachedUrl.includes("=s160"))))
      ) {
        // Needs upgrade to higher variant
      } else {
        return cachedUrl;
      }
    }
  }

  if (rawUrl && cached.has(rawUrl)) {
    const cachedUrl = cached.get(rawUrl)!;
    const isGoogle = cachedUrl.includes("googleusercontent.com") || cachedUrl.includes("ggpht.com");
    if (
      isGoogle &&
      ((variant === "hero" && !cachedUrl.includes("=w800") && !cachedUrl.includes("=s800")) ||
       (variant === "card" && (cachedUrl.includes("=w160") || cachedUrl.includes("=s160"))))
    ) {
      // Needs upgrade to higher variant
    } else {
      return cachedUrl;
    }
  }

  if (!rawUrl && !videoId) return "";

  // 1. Google CDN immediate upscaling (0ms latency)
  if (
    rawUrl &&
    (rawUrl.includes("googleusercontent.com") || rawUrl.includes("ggpht.com"))
  ) {
    let sizeParam = "=w800-h800-l90-rj";
    let sizeParamS = "=s800-l90-rj";

    if (variant === "thumbnail") {
      sizeParam = "=w160-h160-l90-rj";
      sizeParamS = "=s160-l90-rj";
    } else if (variant === "card") {
      sizeParam = "=w544-h544-l90-rj";
      sizeParamS = "=s544-l90-rj";
    } else {
      // hero
      sizeParam = "=w800-h800-l90-rj";
      sizeParamS = "=s800-l90-rj";
    }

    let upscaled = rawUrl;
    if (rawUrl.includes("=w")) {
      upscaled = rawUrl.replace(/=w\d+-h\d+[^"]*/, sizeParam);
    } else if (rawUrl.includes("=s")) {
      upscaled = rawUrl.replace(/=s\d+[^"]*/, sizeParamS);
    }

    if (videoId && variant !== "thumbnail") {
      const existing = cached.get(videoId);
      const isExistingHero = existing && (existing.includes("=w800") || existing.includes("=s800") || existing.includes("maxresdefault"));
      if (!isExistingHero || variant === "hero") {
        setCachedEntry(videoId, upscaled);
      }
    }
    return upscaled;
  }

  // 2. YouTube video thumbnail immediate elevation from low-res (default/mqdefault) to crisp hqdefault
  if (videoId && rawUrl && (rawUrl.includes("i.ytimg.com") || rawUrl.includes("ytimg.com"))) {
    if (rawUrl.includes("default.jpg") || rawUrl.includes("mqdefault.jpg")) {
      return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    }
  }

  // Fallback if videoId exists but rawUrl is missing
  if (videoId && !rawUrl) {
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }

  return rawUrl;
}

/**
 * Provides a guaranteed fallback thumbnail URL for stalled or broken images.
 */
export function getFallbackArtwork(
  videoId?: string,
  failedUrl?: string
): string {
  if (!videoId) return "";

  const hq = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const sd = `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`;
  const mq = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

  if (failedUrl && failedUrl.includes("maxresdefault")) {
    return sd;
  }
  if (failedUrl && failedUrl.includes("sddefault")) {
    return hq;
  }
  if (failedUrl && failedUrl.includes("hqdefault")) {
    return mq;
  }
  return hq;
}

/**
 * Verifies candidate image URL with a bounded Image load check and 2.5s timeout.
 * YouTube returns a 120x90 placeholder when an image is unavailable; this verifies
 * the natural dimensions exceed that threshold.
 */
export function verifyImageUrl(url: string, timeoutMs = 2500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (typeof Image === "undefined") {
      resolve(false);
      return;
    }

    let isDone = false;
    const img = new Image();
    img.referrerPolicy = "no-referrer";

    const timer = setTimeout(() => {
      if (!isDone) {
        isDone = true;
        img.onload = null;
        img.onerror = null;
        img.src = "";
        resolve(false);
      }
    }, timeoutMs);

    img.onload = () => {
      if (!isDone) {
        isDone = true;
        clearTimeout(timer);
        // YouTube returns a 120x90 placeholder for unavailable thumbs
        const isValid = img.naturalWidth > 120 && img.naturalHeight > 90;
        resolve(isValid);
      }
    };

    img.onerror = () => {
      if (!isDone) {
        isDone = true;
        clearTimeout(timer);
        resolve(false);
      }
    };

    img.src = url;
  });
}

/**
 * Notifies all active subscribers for a videoId.
 */
function notifySubscribers(videoId: string, url: string) {
  const set = subscribers.get(videoId);
  if (!set || set.size === 0) return;
  set.forEach((cb) => {
    try {
      cb(url);
    } catch (err) {
      console.warn(`[ImagePipeline] Subscriber error for ${videoId}:`, err);
    }
  });
}

// Single Worker State
let isWorkerRunning = false;

function scheduleWorker() {
  if (isWorkerRunning) return;
  isWorkerRunning = true;
  void runWorker();
}

async function runWorker() {
  while (queued.size > 0) {
    const nextItem = queued.values().next();
    if (nextItem.done || !nextItem.value) break;

    const videoId = nextItem.value;
    queued.delete(videoId);
    processing.add(videoId);

    try {
      await processArtworkUpgrade(videoId);
    } catch (err) {
      console.warn(`[ImagePipeline] Worker error for ${videoId}:`, err);
    } finally {
      processing.delete(videoId);
    }
  }

  isWorkerRunning = false;

  // Restart if new items were queued during final steps
  if (queued.size > 0) {
    scheduleWorker();
  }
}

async function processArtworkUpgrade(videoId: string) {
  if (cached.has(videoId)) {
    notifySubscribers(videoId, cached.get(videoId)!);
    return;
  }

  // Candidates in priority order
  const candidates = [
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  ];

  let verifiedUrl: string | null = null;
  for (const candidate of candidates) {
    const isValid = await verifyImageUrl(candidate, 2500);
    if (isValid) {
      verifiedUrl = candidate;
      break;
    }
  }

  if (verifiedUrl) {
    setCachedEntry(videoId, verifiedUrl);
    notifySubscribers(videoId, verifiedUrl);
  } else {
    // Negative cache to prevent repeated re-probes
    if (checkedNegative.size >= 2000) {
      const oldestKey = checkedNegative.keys().next().value;
      if (oldestKey) checkedNegative.delete(oldestKey);
    }
    checkedNegative.set(videoId, Date.now());
  }
}

export interface QueueOptions {
  priority?: boolean;
}

/**
 * Queues a videoId for background HD upgrade.
 * Returns verified HD URL immediately if available in cache.
 */
export function queueArtworkUpgrade(
  videoId?: string,
  currentUrl?: string,
  options?: QueueOptions
): string | null {
  if (!videoId) return null;

  // 1. If already cached, return immediately
  const existing = cached.get(videoId);
  if (existing) {
    return existing;
  }

  // Check if current URL is Google CDN; if so, upscale immediately
  if (
    currentUrl &&
    (currentUrl.includes("googleusercontent.com") || currentUrl.includes("ggpht.com"))
  ) {
    const upscaled = optimizeThumbnailUrl(currentUrl, videoId, "hero");
    if (upscaled) return upscaled;
  }

  // 2. If recently checked with negative result, do not re-queue
  if (isNegativeCached(videoId)) {
    return null;
  }

  // 3. If already queued or currently processing:
  if (queued.has(videoId)) {
    if (options?.priority) {
      // Prioritize by moving to front of queue
      queued.delete(videoId);
      const reordered = new Set([videoId, ...queued]);
      queued.clear();
      reordered.forEach((id) => queued.add(id));
    }
    return null;
  }

  if (processing.has(videoId)) {
    return null;
  }

  // 4. Otherwise add to queued and schedule worker
  if (options?.priority && queued.size > 0) {
    const reordered = new Set([videoId, ...queued]);
    queued.clear();
    reordered.forEach((id) => queued.add(id));
  } else {
    queued.add(videoId);
  }

  scheduleWorker();
  return null;
}

/**
 * Subscribes a component to artwork upgrades for a specific videoId.
 * Returns an unsubscription cleanup function.
 */
export function subscribeToArtwork(
  videoId: string,
  callback: (url: string) => void
): () => void {
  if (!videoId) return () => {};

  // If already cached, notify subscriber asynchronously
  const existing = cached.get(videoId);
  if (existing) {
    queueMicrotask(() => {
      callback(existing);
    });
  }

  let set = subscribers.get(videoId);
  if (!set) {
    set = new Set();
    subscribers.set(videoId, set);
  }
  set.add(callback);

  return () => {
    const currentSet = subscribers.get(videoId);
    if (currentSet) {
      currentSet.delete(callback);
      if (currentSet.size === 0) {
        subscribers.delete(videoId);
      }
    }
  };
}

export interface UseArtworkOptions {
  sourceUrl?: string;
  videoId?: string;
  artworkKey?: string;
  variant?: ArtworkVariant;
  priority?: boolean;
}

export interface UseArtworkResult {
  currentUrl: string;
  isLoaded: boolean;
  hasError: boolean;
  isUpgraded: boolean;
  onLoad: () => void;
  onError: () => void;
}

/**
 * Unified, shared React hook for all music artwork surfaces.
 * Handles instant synchronous loading, background resolution, smooth flicker-free
 * upgrading, and memory leak cleanup.
 */
export function useArtwork({
  sourceUrl = "",
  videoId,
  artworkKey,
  variant = "card",
  priority = false,
}: UseArtworkOptions): UseArtworkResult {
  const effectiveId = videoId || artworkKey;
  const targetUrl =
    (effectiveId ? getCachedArtworkUrl(effectiveId) : null) ||
    optimizeThumbnailUrl(sourceUrl, effectiveId, variant);

  const [prevKey, setPrevKey] = useState(
    `${effectiveId || ""}___${sourceUrl}___${variant}`
  );
  const [currentUrl, setCurrentUrl] = useState<string>(targetUrl);
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isUpgraded, setIsUpgraded] = useState(false);

  // Synchronize state during render when props change (standard React pattern)
  const currentKey = `${effectiveId || ""}___${sourceUrl}___${variant}`;
  if (prevKey !== currentKey) {
    setPrevKey(currentKey);
    setCurrentUrl(targetUrl);
    setIsLoaded(false);
    setHasError(false);
    setIsUpgraded(Boolean(effectiveId && cached.has(effectiveId)));
  }

  const retryCountRef = useRef(0);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  // Stalled watchdog (dismiss stuck shimmer if browser hangs)
  useEffect(() => {
    clearWatchdog();
    if (!isLoaded && !hasError && currentUrl) {
      watchdogRef.current = setTimeout(() => {
        if (effectiveId && retryCountRef.current < 2) {
          retryCountRef.current += 1;
          setCurrentUrl((prev) => {
            const fallback = getFallbackArtwork(effectiveId, prev);
            return fallback || prev;
          });
          return;
        }
        setIsLoaded(true);
      }, 3000);
    }
    return () => clearWatchdog();
  }, [isLoaded, hasError, currentUrl, effectiveId, clearWatchdog]);

  // Background HD image pipeline subscription
  useEffect(() => {
    if (!effectiveId) return;

    // Small thumbnails stay lightweight: skip heavy maxres probes if already hqdefault or google cdn
    const isLightweightThumbnail =
      variant === "thumbnail" &&
      (currentUrl.includes("hqdefault.jpg") || currentUrl.includes("=w160"));

    const isPriority = priority || variant === "hero";
    if (!isLightweightThumbnail) {
      queueArtworkUpgrade(effectiveId, sourceUrl, { priority: isPriority });
    }

    const unsubscribe = subscribeToArtwork(effectiveId, (hdUrl) => {
      if (hdUrl) {
        setCurrentUrl((prev) => {
          if (prev !== hdUrl) {
            setIsUpgraded(true);
            return hdUrl;
          }
          return prev;
        });
        // Keeps isLoaded=true so the upgrade is smooth and does not re-flash skeleton shimmer
      }
    });

    return unsubscribe;
  }, [effectiveId, sourceUrl, variant, priority, currentUrl]);

  const handleLoad = useCallback(() => {
    clearWatchdog();
    setIsLoaded(true);
    setHasError(false);
  }, [clearWatchdog]);

  const handleError = useCallback(() => {
    clearWatchdog();
    if (effectiveId && retryCountRef.current < 2) {
      retryCountRef.current += 1;
      setCurrentUrl((prev) => {
        const fallback = getFallbackArtwork(effectiveId, prev);
        return fallback || prev;
      });
      return;
    }
    setHasError(true);
    setIsLoaded(true);
  }, [effectiveId, clearWatchdog]);

  return {
    currentUrl,
    isLoaded,
    hasError,
    isUpgraded,
    onLoad: handleLoad,
    onError: handleError,
  };
}

// Backwards-compatible aliases
export const queueForHighResProbe = queueArtworkUpgrade;
export function subscribeToImagePipeline(
  _callback: (resolved: Record<string, string>) => void
): () => void {
  return () => {};
}
