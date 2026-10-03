import { invoke } from "@tauri-apps/api/core";
import { isTauriEnvironment } from "./search";

// In-memory cache for ultra-fast synchronous lookup
const memoryCache = new Map<string, string>();

// Try restoring cache from localStorage on startup
try {
  const saved = localStorage.getItem("dot_highres_image_cache");
  if (saved) {
    const parsed = JSON.parse(saved) as Record<string, string>;
    for (const [k, v] of Object.entries(parsed)) {
      memoryCache.set(k, v);
    }
  }
} catch {
  // Ignore storage error
}

/**
 * Optimizes a thumbnail URL immediately without blocking.
 * Upgrades Google CDN URLs to master quality (800x800 square, 90% quality).
 * Checks memory cache for previously probed video high-res URLs.
 */
export function optimizeThumbnailUrl(rawUrl: string, videoId?: string): string {
  if (!rawUrl && !videoId) return "";

  // 1. Check memory cache first
  if (videoId && memoryCache.has(videoId)) {
    return memoryCache.get(videoId)!;
  }
  if (rawUrl && memoryCache.has(rawUrl)) {
    return memoryCache.get(rawUrl)!;
  }

  // 2. Google CDN immediate upscaling (0ms latency)
  if (
    rawUrl &&
    (rawUrl.includes("googleusercontent.com") || rawUrl.includes("ggpht.com"))
  ) {
    let upscaled = rawUrl;
    if (rawUrl.includes("=w")) {
      upscaled = rawUrl.replace(/=w\d+-h\d+[^"]*/, "=w800-h800-l90-rj");
    } else if (rawUrl.includes("=s")) {
      upscaled = rawUrl.replace(/=s\d+[^"]*/, "=s800-l90-rj");
    }

    if (videoId) {
      memoryCache.set(videoId, upscaled);
    }
    memoryCache.set(rawUrl, upscaled);
    return upscaled;
  }

  // 3. Fallback: if videoId is available, return optimistic hqdefault
  if (videoId && !rawUrl) {
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }

  return rawUrl;
}

// Queue of pending items to probe
interface PendingItem {
  videoId: string;
  currentUrl: string;
}

let pendingBatch: PendingItem[] = [];
let batchTimeout: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(resolved: Record<string, string>) => void>();

export function subscribeToImagePipeline(
  callback: (resolved: Record<string, string>) => void
): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function flushBatch() {
  if (!isTauriEnvironment() || pendingBatch.length === 0) {
    pendingBatch = [];
    batchTimeout = null;
    return;
  }

  const currentBatch = [...pendingBatch];
  pendingBatch = [];
  batchTimeout = null;

  invoke<Record<string, string>>("get_highres_thumbnails", {
    tracks: currentBatch,
  })
    .then((results) => {
      let updated = false;
      for (const [k, v] of Object.entries(results)) {
        if (v && memoryCache.get(k) !== v) {
          memoryCache.set(k, v);
          updated = true;
        }
      }

      if (updated) {
        // Save to localStorage (capped to 500 items)
        try {
          const entries = Array.from(memoryCache.entries()).slice(-500);
          localStorage.setItem(
            "dot_highres_image_cache",
            JSON.stringify(Object.fromEntries(entries))
          );
        } catch {
          // ignore
        }

        // Notify listeners
        listeners.forEach((fn) => fn(results));
      }
    })
    .catch((err) => {
      console.warn("[ImagePipeline] Background probe warning:", err);
    });
}

/**
 * Queues a video/thumbnail for high-res probing in the background.
 */
export function queueForHighResProbe(videoId?: string, currentUrl?: string) {
  if (!videoId || !isTauriEnvironment()) return;
  if (memoryCache.has(videoId)) return;

  const raw = currentUrl || "";
  if (raw.includes("googleusercontent.com") || raw.includes("ggpht.com")) {
    // Already upscaled synchronously
    return;
  }

  pendingBatch.push({ videoId, currentUrl: raw });

  if (!batchTimeout) {
    batchTimeout = setTimeout(flushBatch, 150);
  }
}
