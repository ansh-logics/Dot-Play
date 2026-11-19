import { invoke } from "@tauri-apps/api/core";
import { IS_MAC } from "./immersive";
import { isTauriEnvironment } from "./search";

/**
 * On-device romanization and translation of lyric lines (src-tauri/src/lyrics/alternates.rs).
 * Both run on the Mac itself; neither is offered elsewhere.
 */

export const ALTERNATES_SUPPORTED = isTauriEnvironment() && IS_MAC;

export type TranslationReply =
  | { status: "translated"; source: string; target: string; lines: (string | null)[] }
  | { status: "notInstalled" | "unsupported" | "sameLanguage"; source?: string; target?: string }
  | { status: "unknownLanguage" | "unavailable" }
  | { status: "error"; message?: string };

/** Each line in Latin letters (null where it already was), or null when nothing would change. */
export async function romanizeLyrics(lines: string[]): Promise<(string | null)[] | null> {
  if (!ALTERNATES_SUPPORTED || lines.length === 0) return null;
  try {
    return await invoke<(string | null)[] | null>("romanize_lyrics", { lines });
  } catch {
    return null;
  }
}

/** Translates into the system language. */
export async function translateLyrics(lines: string[]): Promise<TranslationReply> {
  if (!ALTERNATES_SUPPORTED) return { status: "unavailable" };
  try {
    return await invoke<TranslationReply>("translate_lyrics", { lines, target: null });
  } catch (error) {
    return { status: "error", message: String(error) };
  }
}

const languageNames = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: "language" });
  } catch {
    return null;
  }
})();

/** "hi" → "Hindi" in the user's language; the code itself if unknown. */
export function languageName(code: string | undefined): string {
  if (!code) return "this language";
  try {
    return languageNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** A short line for the lyrics tools when a translation isn't shown; null when it is. */
export function translationNote(reply: TranslationReply | null): string | null {
  if (!reply) return null;
  switch (reply.status) {
    case "translated":
      return null;
    case "notInstalled":
      return `Download ${languageName(reply.source)} → ${languageName(reply.target)} in System Settings → General → Language & Region → Translation Languages`;
    case "sameLanguage":
      return `Already in ${languageName(reply.source)}`;
    case "unsupported":
      return `${languageName(reply.source)} can't be translated on this Mac yet`;
    case "unknownLanguage":
      return "Couldn't tell which language this is";
    case "unavailable":
      return "Translation needs macOS 26 or later";
    case "error":
      return "Translation didn't work this time";
  }
}
