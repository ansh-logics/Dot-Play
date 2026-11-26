import { useCallback, useState } from "react";
import { readOffsets, withOffset, writeOffsets } from "../../lib/lyricOffsets";

/** Per-song lyrics choices, shared by both lyrics views. */

const PLAIN_PREF_KEY = "dot_lyrics_plain_v1";
const ROMANIZE_PREF_KEY = "dot_lyrics_romanize_v1";
const TRANSLATE_PREF_KEY = "dot_lyrics_translate_v1";
const SONG_PREF_MAX = 300;

function readSongList(storageKey: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** An on/off choice remembered per song (the most recent few hundred songs). */
function useSongToggle(storageKey: string, trackKey: string | undefined): [boolean, () => void] {
  const [songs, setSongs] = useState(() => readSongList(storageKey));
  const on = Boolean(trackKey && songs.includes(trackKey));
  const toggle = useCallback(() => {
    if (!trackKey) return;
    setSongs((current) => {
      const next = current.includes(trackKey)
        ? current.filter((k) => k !== trackKey)
        : [...current, trackKey].slice(-SONG_PREF_MAX);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Storage unavailable: the choice lasts for this session.
      }
      return next;
    });
  }, [storageKey, trackKey]);
  return [on, toggle];
}

/** Songs whose synced lyrics the listener found out of sync, shown as plain text instead. */
export function usePlainPreference(trackKey: string | undefined): [boolean, () => void] {
  return useSongToggle(PLAIN_PREF_KEY, trackKey);
}

/** Songs shown with each line in Latin letters underneath. */
export function useRomanizePreference(trackKey: string | undefined): [boolean, () => void] {
  return useSongToggle(ROMANIZE_PREF_KEY, trackKey);
}

/** Songs shown with each line translated underneath. */
export function useTranslatePreference(trackKey: string | undefined): [boolean, () => void] {
  return useSongToggle(TRANSLATE_PREF_KEY, trackKey);
}

/** This song's timing nudge (seconds, positive = lyrics sooner), remembered per song. */
export function useLyricOffset(trackKey: string | undefined): [number, (seconds: number) => void] {
  const [offsets, setOffsets] = useState(readOffsets);
  const offset = (trackKey && offsets[trackKey]) || 0;
  const set = useCallback(
    (seconds: number) => {
      if (!trackKey) return;
      setOffsets((current) => {
        const next = withOffset(current, trackKey, seconds);
        writeOffsets(next);
        return next;
      });
    },
    [trackKey],
  );
  return [offset, set];
}
