import { useCallback, useState } from "react";
import { readOffsets, withOffset, writeOffsets } from "../../lib/lyricOffsets";

/** Per-song lyrics choices, shared by both lyrics views. */

const PLAIN_PREF_KEY = "dot_lyrics_plain_v1";
const PLAIN_PREF_MAX = 300;

function readPlainPrefs(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(PLAIN_PREF_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Songs whose synced lyrics the listener found out of sync, shown as plain text instead. */
export function usePlainPreference(trackKey: string | undefined): [boolean, () => void] {
  const [prefs, setPrefs] = useState(readPlainPrefs);
  const prefers = Boolean(trackKey && prefs.includes(trackKey));
  const toggle = useCallback(() => {
    if (!trackKey) return;
    setPrefs((current) => {
      const next = current.includes(trackKey)
        ? current.filter((k) => k !== trackKey)
        : [...current, trackKey].slice(-PLAIN_PREF_MAX);
      try {
        localStorage.setItem(PLAIN_PREF_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable: the choice lasts for this session.
      }
      return next;
    });
  }, [trackKey]);
  return [prefers, toggle];
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
