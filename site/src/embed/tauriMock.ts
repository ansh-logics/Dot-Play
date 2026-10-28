/**
 * A browser stand-in for `@tauri-apps/api/core` and `@tauri-apps/api/event`, so the app's real
 * components run on the website unchanged (vite.config.ts aliases both modules here).
 *
 * Commands the website needs are answered here (lyrics, Now Playing state); everything else
 * resolves to `undefined`. Events stay inside the page they're emitted in.
 */
import { SONG } from "./song";

type Handler<T> = (event: { event: string; id: number; payload: T }) => void;
const listeners = new Map<string, Set<Handler<unknown>>>();
let nextId = 1;

export type UnlistenFn = () => void;

export async function listen<T>(event: string, handler: Handler<T>): Promise<UnlistenFn> {
  const set = listeners.get(event) ?? new Set();
  set.add(handler as Handler<unknown>);
  listeners.set(event, set);
  return () => set.delete(handler as Handler<unknown>);
}

/** Delivers an event to this page's listeners (what the Rust side would have sent). */
export function emitLocal<T>(event: string, payload: T) {
  listeners.get(event)?.forEach((h) => h({ event, id: nextId++, payload }));
}

export async function emit(event: string, payload?: unknown) {
  emitLocal(event, payload);
}

/** Cross-window events don't exist here; the embed pages are driven by the parent page. */
export async function emitTo(_target: string, _event: string, _payload?: unknown) {}

type CommandHandler = (args: Record<string, unknown>) => unknown;
const commands = new Map<string, CommandHandler>();

/** Lets an embed page answer a command (e.g. `get_now_playing`). */
export function handleCommand(name: string, fn: CommandHandler) {
  commands.set(name, fn);
}

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (cmd === "get_lyrics") return (await fetchLyrics()) as T;
  return (commands.get(cmd)?.(args) ?? undefined) as T;
}

// ---- Lyrics --------------------------------------------------------------------

interface LpSyllable {
  time: number;
  duration: number;
  text: string;
  isBackground?: boolean;
}
interface LpLine {
  time: number;
  duration: number;
  text: string;
  syllabus?: LpSyllable[];
}

const LYRICS_PLUS = ["https://lyricsplus.binimum.org", "https://lyricsplus.atomix.one"];

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ts = (ms: number) => `${(ms / 1000).toFixed(3)}s`;

/** LyricsPlus word timing → the Apple-style TTML the app's parser reads (incl. backing vocals). */
function toTtml(lines: LpLine[]): string {
  const body = lines
    .map((line) => {
      const syl = line.syllabus ?? [];
      if (syl.length === 0) {
        return `<p begin="${ts(line.time)}" end="${ts(line.time + line.duration)}">${xml(line.text)}</p>`;
      }
      // Word gaps go between spans (as in Apple's TTML), not inside them.
      const span = (s: LpSyllable) =>
        `<span begin="${ts(s.time)}" end="${ts(s.time + s.duration)}">${xml(s.text.trimEnd())}</span>${/\s$/.test(s.text) ? " " : ""}`;
      const lead = syl.filter((s) => !s.isBackground).map(span).join("");
      const bg = syl.filter((s) => s.isBackground).map(span).join("");
      const end = Math.max(line.time + line.duration, ...syl.map((s) => s.time + s.duration));
      return `<p begin="${ts(line.time)}" end="${ts(end)}">${lead}${bg ? `<span ttm:role="x-bg">${bg}</span>` : ""}</p>`;
    })
    .join("");
  return `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div>${body}</div></body></tt>`;
}

let lyricsPromise: Promise<unknown> | null = null;

function fetchLyrics() {
  lyricsPromise ??= (async () => {
    const q = new URLSearchParams({ title: SONG.title, artist: SONG.artist, duration: String(SONG.duration) });
    for (const mirror of LYRICS_PLUS) {
      try {
        const res = await fetch(`${mirror}/v2/lyrics/get?${q}`);
        if (!res.ok) continue;
        const data = (await res.json()) as { type?: string; lyrics?: LpLine[] };
        if (Array.isArray(data.lyrics) && data.lyrics.length > 0) {
          return { source: "LyricsPlus", ttml: toTtml(data.lyrics) };
        }
      } catch {
        // try the next source
      }
    }
    try {
      const res = await fetch(
        `https://lrclib.net/api/get?${new URLSearchParams({ track_name: SONG.title, artist_name: SONG.artist, duration: String(SONG.duration) })}`,
      );
      if (res.ok) {
        const data = (await res.json()) as { syncedLyrics?: string; plainLyrics?: string };
        return { source: "LRCLIB", syncedLyrics: data.syncedLyrics, plainLyrics: data.plainLyrics };
      }
    } catch {
      // fall through
    }
    return null;
  })();
  return lyricsPromise;
}
