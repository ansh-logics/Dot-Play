import { cleanTrackTitle } from "./lyrics";

/**
 * Title as shown in the UI. Strips noise that crowds out the actual song name
 * when truncated: film credits like `(From "Raabta")`, and video tags such as
 * `(Official 4K Video)`. Keep the raw title for tooltips and search.
 */
export function cleanDisplayTitle(title: string): string {
  if (!title) return "";
  const cleaned = cleanTrackTitle(title)
    // (From "Film") · [From Film] · (From the film "Film") · (From "Film" / Soundtrack)
    .replace(/\s*[([]\s*from\b[^)\]]*[)\]]/gi, "")
    // (Official 4K Video), [Official Lyric Video HD], (Official Music Video 2024) …
    .replace(/\s*[([]\s*official\b[^)\]]*\b(video|audio|visualizer)\b[^)\]]*[)\]]/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Never blank a title that is *only* a bracketed phrase.
  return cleaned || title.trim();
}
