import { memo, type CSSProperties } from "react";
import type { RadioStation } from "../../lib/radioStations";

interface StationBadgeProps {
  station: RadioStation;
  /** Diameter in px. */
  size?: number;
  /** The highlighted / on-air badge: a glow in the station's own colour. */
  active?: boolean;
  className?: string;
}

/**
 * A station's round badge: our own design (fill + ink from the station's colours, its
 * monogram, an inner ring and a soft gloss). Pure CSS, scales with `size`.
 */
export const StationBadge = memo(function StationBadge({ station, size = 64, active = false, className = "" }: StationBadgeProps) {
  const [fill, ink] = station.colors;
  const style = {
    "--radio-badge-size": `${size}px`,
    "--radio-badge-fill": fill,
    "--radio-badge-ink": ink,
  } as CSSProperties;
  const long = station.monogram.length > 2;
  const showFreq = !!station.freq && size >= 48;
  return (
    <span
      className={`radio-badge${active ? " is-active" : ""}${long ? " is-long" : ""}${showFreq ? " has-freq" : ""} ${className}`}
      style={style}
      aria-hidden="true"
    >
      <span className="radio-badge-ring" />
      <span className="radio-badge-mono">{station.monogram}</span>
      {showFreq && <span className="radio-badge-freq">{station.freq}</span>}
      <span className="radio-badge-gloss" />
    </span>
  );
});
