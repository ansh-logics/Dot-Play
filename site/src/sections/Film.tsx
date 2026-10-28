import { useState } from "react";
import { motion } from "motion/react";

/**
 * The launch video (`site/public/media/launch.mp4`, re-muxed with faststart so it streams). If
 * the file is missing, the slot shows a "coming soon" frame.
 */
const FILM_SRC = "/media/launch.mp4";

export function Film() {
  const [missing, setMissing] = useState(false);
  return (
    <section className="section film" id="film" aria-labelledby="film-title">
      <p className="kicker">
        <span className="red-dot" /> Watch
      </p>
      <h2 id="film-title" className="section-title">
        See it in action.
      </h2>
      <motion.div
        className="film-frame"
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.3 }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
      >
        {missing ? (
          <div className="film-placeholder">
            <div className="dotgrid" aria-hidden="true" />
            <span className="film-pulse" aria-hidden="true" />
            <p className="film-soon">Launch film coming soon</p>
          </div>
        ) : (
          <video
            src={FILM_SRC}
            poster="/media/launch-poster.jpg"
            controls
            playsInline
            preload="metadata"
            onError={() => setMissing(true)}
          />
        )}
      </motion.div>
    </section>
  );
}
