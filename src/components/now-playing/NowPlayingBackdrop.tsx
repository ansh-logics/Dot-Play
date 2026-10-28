import { memo, type CSSProperties } from "react";
import type { ArtworkPalette } from "../../lib/useArtworkPalette";

interface BackdropProps {
  palette: ArtworkPalette | null;
  artworkUrl?: string;
}

/**
 * Album-tinted backdrop.
 *
 * Deliberately cheap to composite: WKWebView drops (paints black) layers once a
 * page exceeds its GPU budget, which a stack of crossfading full-screen layers
 * hits on Retina screens. So there is exactly one gradient layer whose colours
 * animate via registered custom properties (see @property in NowPlaying.css),
 * sitting on a blurred copy of the artwork that is always present as a fallback.
 */
export const NowPlayingBackdrop = memo(function NowPlayingBackdrop({ palette, artworkUrl }: BackdropProps) {
  const colours = palette
    ? ({
        "--np-c0": palette.colors[0],
        "--np-c1": palette.colors[1],
        "--np-c2": palette.colors[2],
        "--np-c3": palette.colors[3],
        "--np-base": palette.base,
      } as CSSProperties)
    : undefined;

  return (
    <div className="np-backdrop" aria-hidden="true">
      {artworkUrl && <img key={artworkUrl} className="np-backdrop-art" src={artworkUrl} alt="" />}
      <div className={`np-backdrop-colour ${palette ? "is-ready" : ""}`} style={colours} />
      {/* Nothing style: black with a dot grid (faded in by CSS when data-skin="nothing"). */}
      <div className="np-dotgrid" />
      <div className="np-vignette" />
      <div className="np-grain" />
    </div>
  );
});
