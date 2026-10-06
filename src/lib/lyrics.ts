import { invoke } from "@tauri-apps/api/core";
import { isTauriEnvironment } from "./search";

export interface LyricWord {
  text: string;
  startTime: number;
  endTime: number;
}

export interface RichLyricLine {
  id: number;
  startTime: number;
  endTime: number;
  text: string;
  words?: LyricWord[]; // Word/syllable-level timing for Apple Music-style fluid karaoke
}

export interface TrackLyrics {
  synced: boolean;
  hasWordTiming: boolean;
  syncType: "word" | "line" | "plain" | "unavailable";
  lines: RichLyricLine[];
  plainText?: string;
  source: string; // e.g. "SimpMusic" | "lrc.red" | "BiniLyrics" | "BetterLyrics" | "LyricsPlus" | "Unison"
  isrc?: string;
}

// Backward compatibility type alias
export type SyncedLyricLine = RichLyricLine;

interface LyricsPayload {
  source: string;
  isrc?: string;
  ttml?: string;
  syncedLyrics?: string;
  plainLyrics?: string;
  richSyncJson?: string;
  instrumental?: boolean;
}

// In-memory cache by key to avoid duplicate network calls
const lyricsCache = new Map<string, TrackLyrics>();

function decodeText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

export function cleanTrackTitle(title: string): string {
  if (!title) return "";
  return title
    .replace(
      /\s*[([](official\s*(music\s*)?(video|audio|lyric\s*video|visualizer)?|audio|lyrics?|remastered|hd|4k|extended|clean\s*version|hq|full\s*song)[)\]]/gi,
      "",
    )
    .replace(/\s*-\s*official\s*(music\s*)?(video|audio).*/gi, "")
    .trim();
}

export function cleanArtistName(artist: string): {
  cleanArtist: string;
  primaryArtist: string;
} {
  if (!artist) return { cleanArtist: "", primaryArtist: "" };
  const base = artist
    .split(/[•·|/\\]/)[0]
    .replace(/\s*-\s*Topic/i, "")
    .trim();
  const primary = base.split(/&|,|\bfeat\b\.?|\bft\b\.?/i)[0].trim();
  return { cleanArtist: base, primaryArtist: primary || base };
}

/**
 * Parses timestamps from TTML / Apple-style XML into floating seconds.
 * Supports "00:01:23.456", "01:23.456", "12.34s", "12340ms"
 */
export function parseTtmlTime(timeStr: string): number {
  if (!timeStr) return 0;
  const s = timeStr.trim();
  if (s.endsWith("ms")) {
    return parseFloat(s.slice(0, -2)) / 1000;
  }
  if (s.endsWith("s")) {
    return parseFloat(s.slice(0, -1));
  }
  const parts = s.split(":");
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]);
    const minutes = parseFloat(parts[1]);
    const seconds = parseFloat(parts[2]);
    return hours * 3600 + minutes * 60 + seconds;
  }
  if (parts.length === 2) {
    const minutes = parseFloat(parts[0]);
    const seconds = parseFloat(parts[1]);
    return minutes * 60 + seconds;
  }
  return parseFloat(s) || 0;
}

/**
 * Parses Apple-style TTML XML lyrics into RichLyricLine with word-by-word syllable timing.
 */
export function parseTtml(xmlContent: string): RichLyricLine[] {
  if (!xmlContent) return [];
  const lines: RichLyricLine[] = [];

  if (typeof DOMParser !== "undefined") {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlContent, "text/xml");
      const pElements = Array.from(doc.querySelectorAll("p"));

      let idCounter = 0;
      for (const p of pElements) {
        const beginAttr = p.getAttribute("begin") || "0";
        const endAttr = p.getAttribute("end") || "0";
        const startTime = parseTtmlTime(beginAttr);
        const endTime = parseTtmlTime(endAttr);

        const spanElements = Array.from(p.querySelectorAll("span"));
        let words: LyricWord[] | undefined;
        let lineText = "";

        if (spanElements.length > 0) {
          words = [];
          const sourceText = p.textContent || "";
          let sourceCursor = 0;
          for (const span of spanElements) {
            const spanBegin = span.getAttribute("begin") || beginAttr;
            const spanEnd = span.getAttribute("end") || endAttr;
            const rawText = span.textContent || "";
            const sourceIndex = sourceText.indexOf(rawText, sourceCursor);
            const prefix = sourceIndex >= sourceCursor
              ? sourceText.slice(sourceCursor, sourceIndex)
              : "";
            const wText = decodeText(prefix + rawText);
            sourceCursor = sourceIndex >= 0 ? sourceIndex + rawText.length : sourceCursor + rawText.length;
            words.push({
              text: wText,
              startTime: parseTtmlTime(spanBegin),
              endTime: parseTtmlTime(spanEnd),
            });
            lineText += wText;
          }
        } else {
          lineText = decodeText(p.textContent || "");
        }

        const trimmed = lineText.trim();
        if (trimmed) {
          lines.push({
            id: idCounter++,
            startTime,
            endTime: endTime > startTime ? endTime : startTime + 3.5,
            text: trimmed,
            words: words && words.length > 0 ? words : undefined,
          });
        }
      }

      if (lines.length > 0) {
        lines.sort((a, b) => a.startTime - b.startTime);
        return lines;
      }
    } catch (err) {
      console.warn("[DOT Music] DOMParser TTML failed, falling back to regex:", err);
    }
  }

  // Regex fallback for TTML
  const pRegex = /<p\b[^>]*\bbegin="([^"]+)"[^>]*\bend="([^"]+)"[^>]*>([\s\S]*?)<\/p>/gi;
  let match: RegExpExecArray | null;
  let id = 0;
  while ((match = pRegex.exec(xmlContent)) !== null) {
    const startTime = parseTtmlTime(match[1]);
    const endTime = parseTtmlTime(match[2]);
    const inner = match[3];

    const spanRegex =
      /<span\b[^>]*\bbegin="([^"]+)"[^>]*\bend="([^"]+)"[^>]*>([\s\S]*?)<\/span>/gi;
    let spanMatch: RegExpExecArray | null;
    const words: LyricWord[] = [];
    let text = "";

    while ((spanMatch = spanRegex.exec(inner)) !== null) {
      const wText = decodeText(spanMatch[3].replace(/<[^>]+>/g, ""));
      words.push({
        text: wText,
        startTime: parseTtmlTime(spanMatch[1]),
        endTime: parseTtmlTime(spanMatch[2]),
      });
      text += wText;
    }

    if (words.length === 0) {
      text = decodeText(inner.replace(/<[^>]+>/g, "")).trim();
    }

    if (text.trim()) {
      lines.push({
        id: id++,
        startTime,
        endTime: endTime > startTime ? endTime : startTime + 3.5,
        text: text.trim(),
        words: words.length > 0 ? words : undefined,
      });
    }
  }

  lines.sort((a, b) => a.startTime - b.startTime);
  return lines;
}

/**
 * Parses SimpMusic's richSyncLyrics JSON structure into RichLyricLine.
 */
export function parseRichSyncJson(jsonStr: string): RichLyricLine[] {
  if (!jsonStr) return [];
  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    const lines: RichLyricLine[] = [];
    let idCounter = 0;

    for (const item of parsed) {
      const text = item.text || item.line || "";
      let start = Number(item.startTime ?? item.start ?? 0);
      let end = Number(item.endTime ?? item.end ?? 0);

      // Normalize milliseconds to seconds if values are large
      if (start > 1000) start /= 1000;
      if (end > 1000) end /= 1000;

      let words: LyricWord[] | undefined;
      if (Array.isArray(item.words) && item.words.length > 0) {
        words = item.words.map((w: any) => {
          let wStart = Number(w.startTime ?? w.start ?? start);
          let wEnd = Number(w.endTime ?? w.end ?? end);
          if (wStart > 1000) wStart /= 1000;
          if (wEnd > 1000) wEnd /= 1000;
          return {
            text: w.text || w.word || "",
            startTime: wStart,
            endTime: wEnd,
          };
        });
      }

      if (text.trim()) {
        lines.push({
          id: idCounter++,
          startTime: start,
          endTime: end > start ? end : start + 3.5,
          text: text.trim(),
          words,
        });
      }
    }

    lines.sort((a, b) => a.startTime - b.startTime);
    return lines;
  } catch (err) {
    console.warn("[DOT Music] Failed to parse richSyncLyrics JSON:", err);
    return [];
  }
}

/**
 * Parses Enhanced LRC (with syllable timestamps) or standard LRC into RichLyricLine.
 */
export function parseEnhancedLrc(lrcContent: string): RichLyricLine[] {
  if (!lrcContent) return [];
  const lines = lrcContent.split("\n");
  const result: RichLyricLine[] = [];
  const timestampRegex = /\[(\d{1,3}):(\d{2}(?:[.:]\d+)?)\]/g;
  const wordRegex = /<(\d{1,3}):(\d{2}(?:[.:]\d+)?)>([^<]+)/g;
  const offset = Number(lrcContent.match(/^\[offset:([+-]?\d+)\]/im)?.[1] ?? 0) / 1000;

  let idCounter = 0;
  for (const rawLine of lines) {
    const trimmed = decodeText(rawLine.trim());
    if (!trimmed) continue;
    const timestamps = [...trimmed.matchAll(timestampRegex)];
    if (timestamps.length > 0) {
      const lastTimestamp = timestamps.at(-1)!;
      const rest = trimmed.slice((lastTimestamp.index ?? 0) + lastTimestamp[0].length).trim();

      // Check if line contains word-level syllable tags <mm:ss.xx>
      const words: LyricWord[] = [];
      let wordMatch: RegExpExecArray | null;
      let cleanText = rest;

      if (rest.includes("<")) {
        while ((wordMatch = wordRegex.exec(rest)) !== null) {
          const wMin = parseInt(wordMatch[1], 10);
          const wSec = parseFloat(wordMatch[2].replace(":", "."));
          const wStart = wMin * 60 + wSec + offset;
          const wText = wordMatch[3];
          words.push({
            text: wText,
            startTime: wStart,
            endTime: wStart + 0.8, // will be smoothed
          });
        }
        cleanText = rest.replace(/<[^>]+>/g, "").trim();
      }

      // Smooth word end times
      if (words.length > 0) {
        for (let i = 0; i < words.length - 1; i++) {
          words[i].endTime = Math.max(words[i].startTime, words[i + 1].startTime);
        }
      }

      for (const timestamp of timestamps) {
        const minutes = Number.parseInt(timestamp[1], 10);
        const seconds = Number.parseFloat(timestamp[2].replace(":", "."));
        const lineStart = minutes * 60 + seconds + offset;
        result.push({
          id: idCounter++,
          startTime: lineStart,
          endTime: lineStart + 3.5,
          text: cleanText || "♪",
          words: words.length > 0 ? words.map((word) => ({ ...word })) : undefined,
        });
      }
    }
  }

  // Smooth line end times to next line start
  result.sort((a, b) => a.startTime - b.startTime);
  for (let i = 0; i < result.length - 1; i++) {
    result[i].endTime = Math.min(result[i].startTime + 8, result[i + 1].startTime);
  }

  return result;
}

export function parsePlainLyrics(plain: string): RichLyricLine[] {
  if (!plain) return [];
  const rawLines = plain
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (rawLines.length === 0) return [];

  return rawLines.map((text, idx) => ({
    id: idx,
    startTime: 0,
    endTime: 0,
    text,
  }));
}

/**
 * Multi-provider Rich-Synced Lyrics Fetcher (BitChord Architecture).
 *
 * Waterfall Hierarchy:
 * 1. SimpMusic (by YouTube video ID, supports richSyncLyrics)
 * 2. BiniLyrics (recording identification, ISRC & TTML)
 * 3. lrc.red (Apple-style TTML / syllable timing by ISRC or search)
 * 4. BetterLyrics & QQ Karaoke
 * 5. LyricsPlus Mirrors (with last-working mirror cache)
 * 6. Unison
 */
export async function fetchLyricsMultiProvider(
  title: string,
  artist: string,
  duration?: number,
  videoId?: string,
  album?: string,
): Promise<TrackLyrics> {
  const cacheKey = videoId || `${title}::${artist}`;
  if (lyricsCache.has(cacheKey)) {
    return lyricsCache.get(cacheKey)!;
  }

  const cleanTitle = cleanTrackTitle(title);
  const { cleanArtist, primaryArtist } = cleanArtistName(artist);

  // 1. Native Tauri multi-provider orchestrator
  if (isTauriEnvironment()) {
    try {
      const payload = await invoke<LyricsPayload | null>("get_lyrics", {
        videoId: videoId || null,
        title: cleanTitle,
        artist: primaryArtist || cleanArtist,
        album: album || null,
        duration: duration || null,
      });

      if (payload) {
        const parsed = processLyricsPayload(payload);
        if (parsed.lines.length > 0) {
          lyricsCache.set(cacheKey, parsed);
          return parsed;
        }
      }
    } catch (err) {
      console.warn("[DOT Music] Tauri multi-provider get_lyrics failed:", err);
    }
  }

  // Not found. Providers are intentionally called only through Tauri so the
  // desktop app has one observable, rate-limited network boundary.
  const notFound: TrackLyrics = {
    synced: false,
    hasWordTiming: false,
    syncType: "unavailable",
    lines: [],
    source: "unavailable",
  };
  lyricsCache.set(cacheKey, notFound);
  return notFound;
}

function processLyricsPayload(payload: LyricsPayload): TrackLyrics {
  // A. TTML (Apple-style syllable timing)
  if (payload.ttml) {
    const lines = parseTtml(payload.ttml);
    if (lines.length > 0) {
      const hasWordTiming = lines.some((l) => Boolean(l.words && l.words.length > 0));
      return {
        synced: true,
        hasWordTiming,
        syncType: hasWordTiming ? "word" : "line",
        lines,
        plainText: payload.plainLyrics,
        source: payload.source,
        isrc: payload.isrc,
      };
    }
  }

  // B. RichSync JSON (SimpMusic syllable timing)
  if (payload.richSyncJson) {
    const lines = (() => {
      const jsonLines = parseRichSyncJson(payload.richSyncJson!);
      return jsonLines.length > 0 ? jsonLines : parseEnhancedLrc(payload.richSyncJson!);
    })();
    if (lines.length > 0) {
      const hasWordTiming = lines.some((l) => Boolean(l.words && l.words.length > 0));
      return {
        synced: true,
        hasWordTiming,
        syncType: hasWordTiming ? "word" : "line",
        lines,
        plainText: payload.plainLyrics,
        source: payload.source,
        isrc: payload.isrc,
      };
    }
  }

  // C. Enhanced / Standard LRC
  if (payload.syncedLyrics) {
    const lines = parseEnhancedLrc(payload.syncedLyrics);
    if (lines.length > 0) {
      const hasWordTiming = lines.some((l) => Boolean(l.words && l.words.length > 0));
      return {
        synced: true,
        hasWordTiming,
        syncType: hasWordTiming ? "word" : "line",
        lines,
        plainText: payload.plainLyrics,
        source: payload.source,
        isrc: payload.isrc,
      };
    }
  }

  // D. Plain text lyrics
  if (payload.plainLyrics) {
    const lines = parsePlainLyrics(payload.plainLyrics);
    return {
      synced: false,
      hasWordTiming: false,
      syncType: "plain",
      lines,
      plainText: payload.plainLyrics,
      source: payload.source,
      isrc: payload.isrc,
    };
  }

  if (payload.instrumental) {
    return {
      synced: false,
      hasWordTiming: false,
      syncType: "plain",
      lines: [
        {
          id: 0,
          startTime: 0,
          endTime: 9999,
          text: "♪ Instrumental Track",
        },
      ],
      source: "instrumental",
    };
  }

  return {
    synced: false,
    hasWordTiming: false,
    syncType: "unavailable",
    lines: [],
    source: "unavailable",
  };
}
