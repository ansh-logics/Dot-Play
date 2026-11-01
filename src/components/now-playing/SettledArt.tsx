import { AnimatePresence, motion } from "motion/react";
import type { SettledArtwork } from "./useSettledArtwork";

/**
 * The player's cover. Only ever shows an image that has fully loaded together with its own
 * letterbox zoom, and crossfades from the previous one, so it never pops in at the wrong
 * crop or flashes the small version first.
 */
export function SettledArt({ art, alt }: { art: SettledArtwork | null; alt: string }) {
  return (
    <div className="np-art">
      <AnimatePresence initial={false}>
        {art && (
          <motion.img
            key={art.url}
            className="np-art-img"
            src={art.url}
            alt={alt}
            referrerPolicy="no-referrer"
            draggable={false}
            // Each image keeps its own zoom while it fades out under the next one.
            style={{ ["--np-art-zoom" as string]: art.palette?.zoom ?? 1 }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
