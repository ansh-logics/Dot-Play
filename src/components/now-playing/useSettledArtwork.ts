import { useEffect, useState } from "react";
import { useArtwork } from "../../lib/imagePipeline";
import { loadArtworkPalette, type ArtworkPalette } from "../../lib/useArtworkPalette";
import type { SearchResult } from "../../lib/search";

/** How long a new song waits for its full-size cover before settling for the first one. */
const HD_GRACE_MS = 1200;

export interface SettledArtwork {
  url: string;
  palette: ArtworkPalette | null;
}

/**
 * The artwork the player shows, together with the colours and letterbox zoom measured from
 * that exact image. A new image is only handed over once it has loaded and been measured, so
 * the picture, its zoom and the backdrop always change together: no frame with the previous
 * image's zoom (black bars) or colours. A new song gives the full-size cover a moment to
 * arrive, instead of showing the small one and swapping a second later.
 */
export function useSettledArtwork(track: SearchResult): SettledArtwork | null {
  const { currentUrl, isUpgraded } = useArtwork({
    sourceUrl: track.thumbnailUrl,
    videoId: track.videoId,
    variant: "hero",
    priority: true,
  });
  const [settled, setSettled] = useState<(SettledArtwork & { videoId: string }) | null>(null);
  const [graceOver, setGraceOver] = useState<string | null>(null);

  // Starts the grace period for each new song.
  useEffect(() => {
    const id = track.videoId;
    const timer = window.setTimeout(() => setGraceOver(id), HD_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [track.videoId]);

  const sameSong = settled?.videoId === track.videoId;
  // The first (small) cover of a new song waits for the grace period; full-size ones, and any
  // change within a song that is already showing, go straight through.
  const ready = Boolean(currentUrl) && (isUpgraded || sameSong || graceOver === track.videoId);

  useEffect(() => {
    if (!ready || (settled?.url === currentUrl && sameSong)) return;
    let cancelled = false;
    const videoId = track.videoId;
    void loadArtworkPalette(currentUrl).then((palette) => {
      if (!cancelled) setSettled({ url: currentUrl, palette, videoId });
    });
    return () => {
      cancelled = true;
    };
  }, [ready, currentUrl, track.videoId, settled?.url, sameSong]);

  return settled;
}
