import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { stationTitle, type RadioStation } from "../../lib/radioStations";
import type { SearchResult } from "../../lib/search";
import type { RadioController } from "../../lib/useRadio";
import { StationBadge } from "./StationBadge";

const SHOW_MS = 3500;

interface RadioBannerProps {
  radio: RadioController;
  currentTrack: SearchResult | null;
}

interface BannerState {
  station: RadioStation;
  tuning: boolean;
  track: SearchResult | null;
  /** Changes on every show, so the slide-in replays. */
  key: string;
}

/**
 * In-car display: slides down from the top when a station comes on air or its next song
 * starts, then tucks itself away. While tuning it shows the station with a flicker.
 */
export const RadioBanner = memo(function RadioBanner({ radio, currentTrack }: RadioBannerProps) {
  const reduceMotion = Boolean(useReducedMotion());
  const [shown, setShown] = useState<BannerState | null>(null);
  const hideTimer = useRef<number | null>(null);
  const { status, station } = radio;
  const videoId = currentTrack?.videoId;

  // The latest track, read when status/song changes (not a dependency itself).
  const trackRef = useRef(currentTrack);
  useEffect(() => {
    trackRef.current = currentTrack;
  });

  useEffect(() => {
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (status === "off" || !station) {
      setShown(null);
      return;
    }
    if (status === "tuning") {
      setShown({ station, tuning: true, track: null, key: `${station.id}-tuning` });
      return;
    }
    setShown({ station, tuning: false, track: trackRef.current, key: `${station.id}-${videoId ?? ""}` });
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setShown(null);
    }, SHOW_MS);
  }, [status, station, videoId]);

  useEffect(
    () => () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    },
    [],
  );

  return (
    <div className="radio-banner-anchor" aria-live="polite" aria-atomic="true">
      <AnimatePresence mode="wait">
        {shown && (
          <motion.div
            key={shown.key}
            className={`radio-banner${shown.tuning ? " is-tuning" : ""}`}
            style={{ "--radio-accent": shown.station.colors[0] } as CSSProperties}
            initial={reduceMotion ? { opacity: 0 } : { y: "-130%", opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { y: "-130%", opacity: 0 }}
            transition={reduceMotion ? { duration: 0.12 } : { type: "spring", stiffness: 420, damping: 34 }}
          >
            <StationBadge station={shown.station} size={40} active={!shown.tuning} />
            <div className="radio-banner-text">
              <span className="radio-banner-station">{stationTitle(shown.station)}</span>
              {shown.tuning ? (
                <span className="radio-banner-tuning">Tuning…</span>
              ) : shown.track ? (
                <span className="radio-banner-song">
                  {shown.track.artist} — {shown.track.title}
                </span>
              ) : (
                <span className="radio-banner-song">{shown.station.genre}</span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
