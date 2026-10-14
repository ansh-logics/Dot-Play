import type { RichLyricLine } from "../../lib/lyrics";

/** A rendered lyrics row: a sung line, or an instrumental break shown as "•••". */
export type LyricRow =
  | { kind: "line"; key: string; start: number; line: RichLyricLine }
  | { kind: "interlude"; key: string; start: number; end: number };

const INTRO_MIN_GAP = 3;
const BREAK_MIN_GAP = 4;
/** `parseEnhancedLrc` turns empty LRC timestamps (instrumental markers) into "♪". */
const isInstrumentalMarker = (line: RichLyricLine) => /^[\s♪♫♩♬]*$/.test(line.text);

/**
 * When the singing in a line actually stops: its last word (lead or backing vocals) if
 * word-timed, else the line end.
 */
function lineEnd(line: RichLyricLine): number {
  const words = [...(line.words ?? []), ...(line.background?.words ?? [])].filter((w) => w.endTime > w.startTime);
  return words.length > 0 ? Math.max(...words.map((w) => w.endTime)) : line.endTime;
}

/** Interleaves interlude rows into synced lines wherever there's a long enough instrumental gap. */
export function buildLyricRows(lines: RichLyricLine[]): LyricRow[] {
  const rows: LyricRow[] = [];
  const sung = lines.filter((l) => !isInstrumentalMarker(l));
  const first = sung[0];
  if (first && first.startTime >= INTRO_MIN_GAP) {
    rows.push({ kind: "interlude", key: "intro", start: 0, end: first.startTime });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines.slice(i + 1).find((l) => !isInstrumentalMarker(l));

    if (isInstrumentalMarker(line)) {
      // Explicit marker: a break until the next sung line (skip markers before the first line;
      // the intro row already covers that span).
      if (next && line.startTime >= (first?.startTime ?? 0)) {
        const prev = rows[rows.length - 1];
        if (prev?.kind !== "interlude") {
          rows.push({ kind: "interlude", key: `gap-${line.id}`, start: line.startTime, end: next.startTime });
        }
      }
      continue;
    }

    rows.push({ kind: "line", key: `line-${line.id}`, start: line.startTime, line });

    const nextRaw = lines[i + 1];
    if (next && nextRaw && !isInstrumentalMarker(nextRaw)) {
      const end = Math.min(lineEnd(line), next.startTime);
      if (next.startTime - end >= BREAK_MIN_GAP) {
        rows.push({ kind: "interlude", key: `gap-${line.id}`, start: end, end: next.startTime });
      }
    }
  }
  return rows;
}

/**
 * Index of the row that's current at time `t`: the last row that has started.
 * An interlude stops being current once its break is over.
 */
export function activeRowIndex(rows: LyricRow[], t: number): number {
  let idx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (t >= rows[i].start) idx = i;
    else break;
  }
  const row = rows[idx];
  if (row?.kind === "interlude" && t >= row.end) {
    // Break is over but the next line hasn't started (tiny rounding gap): hold the previous line.
    return idx > 0 ? idx - 1 : -1;
  }
  return idx;
}
