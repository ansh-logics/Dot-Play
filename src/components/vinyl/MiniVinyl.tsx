import { TonearmParts } from "./TonearmParts";
import "./vinyl.css";

interface MiniVinylProps {
  isPlaying: boolean;
  /** Very small sizes drop the tonearm. */
  tiny?: boolean;
  /** The artwork, shown as the record's label. */
  children: React.ReactNode;
}

/**
 * The Vinyl player style at small sizes (sidebar card, menu bar). CSS-only so it stays
 * light: no animation library, and nothing re-renders while it turns.
 */
export function MiniVinyl({ isPlaying, tiny = false, children }: MiniVinylProps) {
  return (
    <div className={`vinyl vinyl--mini${tiny ? " vinyl--tiny" : ""}${isPlaying ? " is-playing" : ""}`}>
      <div className="vinyl-disc">
        <div className="vinyl-label">{children}</div>
        <div className="vinyl-spindle" />
      </div>
      <div className="vinyl-sheen" aria-hidden="true" />
      {!tiny && (
        <svg className="vinyl-arm" viewBox="0 0 100 100" aria-hidden="true">
          <TonearmParts />
        </svg>
      )}
    </div>
  );
}
