import { createContext, memo, useContext, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { ArtistRef } from "../lib/search";

/**
 * Opens an artist page. Set once in App so a name buried in a row, the mini player or
 * Now Playing can navigate without every screen in between passing a prop down.
 */
export const ArtistNavigationContext = createContext<(browseId: string) => void>(() => {});

interface ArtistLinksProps {
  /** The artist text the app shows (already cleaned: no "VEVO", " - Topic"…). */
  artist: string;
  /** Credited artists with a channel; the ones named in `artist` become links. */
  artists?: ArtistRef[];
}

interface Span {
  start: number;
  end: number;
  ref: ArtistRef;
}

/** Where each linked artist's name appears in the shown text (first match, no overlaps). */
export function linkSpans(text: string, refs: ArtistRef[]): Span[] {
  const lower = text.toLowerCase();
  const spans: Span[] = [];
  for (const ref of refs) {
    const name = ref.name.trim();
    if (!name || !ref.browseId) continue;
    let from = 0;
    while (from <= lower.length) {
      const at = lower.indexOf(name.toLowerCase(), from);
      if (at < 0) break;
      const end = at + name.length;
      if (!spans.some((s) => at < s.end && end > s.start)) {
        spans.push({ start: at, end, ref });
        break;
      }
      from = at + 1;
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * The artist text of a row or header, exactly as before, with each credited artist's name
 * turned into a link to their page. Names without a channel (and old queues with no ids at
 * all) stay plain text. Links are inline spans, not buttons, so they inherit the line's case,
 * tracking and ellipsis.
 */
export const ArtistLinks = memo(function ArtistLinks({ artist, artists }: ArtistLinksProps) {
  const openArtist = useContext(ArtistNavigationContext);
  const spans = artists && artists.length > 0 ? linkSpans(artist, artists) : [];
  if (spans.length === 0) return <>{artist}</>;

  const open = (browseId: string) => (e: MouseEvent | KeyboardEvent) => {
    // The row underneath plays the song: the name opens the artist instead.
    e.stopPropagation();
    e.preventDefault();
    openArtist(browseId);
  };

  const parts: ReactNode[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) parts.push(artist.slice(at, span.start));
    parts.push(
      <span
        key={`${span.ref.browseId}-${span.start}`}
        role="link"
        tabIndex={0}
        className="artist-link"
        onClick={open(span.ref.browseId)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") open(span.ref.browseId)(e);
        }}
      >
        {artist.slice(span.start, span.end)}
      </span>,
    );
    at = span.end;
  }
  if (at < artist.length) parts.push(artist.slice(at));
  return <>{parts}</>;
});
