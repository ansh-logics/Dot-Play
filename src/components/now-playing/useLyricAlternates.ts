import { useEffect, useMemo, useState } from "react";
import type { TrackLyrics } from "../../lib/lyrics";
import { romanizeLyrics, translateLyrics, type TranslationReply } from "../../lib/lyricAlternates";

interface Alternates {
  /** Romanized lines (indexed like `data.lines`), or null when the song is in Latin letters. */
  romanized: (string | null)[] | null;
  /** The last translation attempt for these lyrics; null until asked for (or while it runs). */
  translation: TranslationReply | null;
  translating: boolean;
}

/**
 * Romanization and translation for the lyrics on show. Romanization is cheap and always looked
 * up, so the toggle only appears for songs it changes; translation runs only once it's wanted.
 */
export function useLyricAlternates(data: TrackLyrics | null, wantTranslation: boolean): Alternates {
  const lines = useMemo(() => data?.lines.map((line) => line.text) ?? [], [data]);
  const key = lines.join("\n");

  const [romanized, setRomanized] = useState<{ key: string; lines: (string | null)[] | null } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void romanizeLyrics(key.split("\n")).then((out) => !cancelled && setRomanized({ key, lines: out }));
    return () => {
      cancelled = true;
    };
  }, [key]);

  const [translation, setTranslation] = useState<{ key: string; reply: TranslationReply } | null>(null);
  const haveTranslation = translation?.key === key;
  useEffect(() => {
    if (!key || !wantTranslation || haveTranslation) return;
    let cancelled = false;
    void translateLyrics(key.split("\n")).then((reply) => !cancelled && setTranslation({ key, reply }));
    return () => {
      cancelled = true;
    };
  }, [key, wantTranslation, haveTranslation]);

  return {
    romanized: romanized?.key === key ? romanized.lines : null,
    translation: haveTranslation ? translation.reply : null,
    translating: Boolean(key) && wantTranslation && !haveTranslation,
  };
}
