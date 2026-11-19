import type { LyricWord, RichLyricLine, TrackLyrics } from "../../lib/lyrics";

/**
 * Our lyrics as the TTML am-lyrics renders. Every provider's lyrics (TTML, rich sync, LRC,
 * plain) end up as parsed lines first, so one writer covers them all:
 * - word timing as one span per word, with a space between words;
 * - backing vocals as an `x-bg` span;
 * - duets as two singers: lines on the far side are `v2`, typed `other`, which am-lyrics
 *   places opposite `v1`;
 * - unsynced lyrics as lines timed 0 to 0, which am-lyrics shows as plain text;
 * - translations and romanizations (lyricAlternates.ts) as Apple's iTunesMetadata blocks, keyed
 *   to each line, which am-lyrics shows as caption lines when its toggles are on.
 */

/** Per-line extras, indexed like `lyrics.lines`; null where a line has none. */
export interface LyricAlternates {
  translations?: (string | null)[] | null;
  romanized?: (string | null)[] | null;
}

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Seconds as a TTML time ("12.345s"). */
const time = (seconds: number) => `${Math.max(0, seconds).toFixed(3)}s`;

/** Word spans; a word that starts with a space gets a space before its span. */
function wordSpans(words: LyricWord[]): string {
  return words
    .map((word, i) => {
      const text = word.text.trim();
      if (!text) return "";
      const gap = i > 0 && /^\s/.test(word.text) ? " " : "";
      return `${gap}<span begin="${time(word.startTime)}" end="${time(Math.max(word.endTime, word.startTime))}">${escape(text)}</span>`;
    })
    .join("");
}

function lineBody(line: RichLyricLine, synced: boolean): string {
  const lead = synced && line.words?.length ? wordSpans(line.words) : escape(line.text);
  const bg = line.background;
  if (!bg?.text.trim()) return lead;
  const backing = synced && bg.words?.length ? wordSpans(bg.words) : escape(bg.text);
  return `${lead}<span ttm:role="x-bg">${backing}</span>`;
}

function alternatesBlock(tag: "translation" | "transliteration", texts: (string | null)[] | null | undefined, keys: Map<number, string>): string {
  if (!texts) return "";
  const entries = [...keys]
    .map(([index, key]) => (texts[index]?.trim() ? `<text for="${key}">${escape(texts[index]!.trim())}</text>` : ""))
    .join("");
  return entries ? `<${tag}s><${tag}>${entries}</${tag}></${tag}s>` : "";
}

export function lyricsToTtml(lyrics: Pick<TrackLyrics, "lines" | "syncType">, alternates?: LyricAlternates): string {
  const synced = lyrics.syncType === "word" || lyrics.syncType === "line";
  const timing = lyrics.syncType === "word" ? "Word" : lyrics.syncType === "line" ? "Line" : "None";
  const duet = synced && lyrics.lines.some((l) => l.side === "end");
  const agents = duet
    ? '<ttm:agent type="person" xml:id="v1"/><ttm:agent type="other" xml:id="v2"/>'
    : '<ttm:agent type="person" xml:id="v1"/>';
  // Line keys tie each translation or romanization to its <p>.
  const keys = new Map<number, string>();
  const paragraphs = lyrics.lines
    .map((line, index) => {
      if (!line.text.trim() && !line.background?.text.trim()) return "";
      const key = `L${keys.size + 1}`;
      keys.set(index, key);
      const begin = synced ? line.startTime : 0;
      const end = synced ? Math.max(line.endTime, line.startTime) : 0;
      const agent = duet && line.side === "end" ? "v2" : "v1";
      return `<p begin="${time(begin)}" end="${time(end)}" itunes:key="${key}" ttm:agent="${agent}">${lineBody(line, synced)}</p>`;
    })
    .join("");
  const extras =
    alternatesBlock("translation", alternates?.translations, keys) + alternatesBlock("transliteration", alternates?.romanized, keys);
  const metadata = extras ? `${agents}<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal">${extras}</iTunesMetadata>` : agents;
  return (
    '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" ' +
    `xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="${timing}">` +
    `<head><metadata>${metadata}</metadata></head><body><div>${paragraphs}</div></body></tt>`
  );
}
