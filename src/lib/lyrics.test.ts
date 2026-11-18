import { describe, expect, it } from "vitest";
import {
  hasRealTiming,
  parseEnhancedLrc,
  parsePlainLyrics,
  parseTtml,
  processLyricsPayload,
  timingFitsSong,
  type LyricsPayload,
} from "./lyrics";
import { activeRowIndex, buildLyricRows } from "../components/now-playing/lyricRows";

const payload = (fields: Partial<LyricsPayload>): LyricsPayload => ({ source: "test", ...fields });

/** An LRC block with one numbered line per start time (seconds). */
const lrc = (times: number[]) =>
  times
    .map((t, i) => {
      const m = String(Math.floor(t / 60)).padStart(2, "0");
      const s = (t % 60).toFixed(2).padStart(5, "0");
      return `[${m}:${s}]Line ${i + 1}`;
    })
    .join("\n");

describe("parseEnhancedLrc", () => {
  it("reads line timestamps in order", () => {
    const lines = parseEnhancedLrc("[00:12.50]First\n[00:20.00]Second");
    expect(lines.map((l) => [l.startTime, l.text])).toEqual([
      [12.5, "First"],
      [20, "Second"],
    ]);
  });

  it("repeats a line that carries several timestamps, sorted by time", () => {
    const lines = parseEnhancedLrc("[00:10.00][01:10.00]Chorus\n[00:40.00]Verse");
    expect(lines.map((l) => [l.startTime, l.text])).toEqual([
      [10, "Chorus"],
      [40, "Verse"],
      [70, "Chorus"],
    ]);
  });

  it("applies the [offset:] tag in milliseconds", () => {
    expect(parseEnhancedLrc("[offset:+500]\n[00:10.00]Line")[0].startTime).toBe(10.5);
  });

  it("reads word timing tags", () => {
    const [line] = parseEnhancedLrc("[00:10.00]<00:10.00>Hello <00:10.80>world");
    expect(line.text).toBe("Hello world");
    expect(line.words?.map((w) => w.startTime)).toEqual([10, 10.8]);
  });

  it("ends each line where the next begins", () => {
    const lines = parseEnhancedLrc("[00:10.00]A\n[00:13.00]B");
    expect(lines[0].endTime).toBe(13);
  });
});

describe("parsePlainLyrics", () => {
  it("drops blank lines and gives every line time 0", () => {
    const lines = parsePlainLyrics("One\n\n  Two  \n");
    expect(lines.map((l) => l.text)).toEqual(["One", "Two"]);
    expect(lines.every((l) => l.startTime === 0)).toBe(true);
  });
});

describe("hasRealTiming", () => {
  it("accepts lyrics that move through the song", () => {
    expect(hasRealTiming(parseEnhancedLrc(lrc([12, 18, 25, 31, 40, 52])))).toBe(true);
  });

  it("rejects every line stamped 0:00", () => {
    expect(hasRealTiming(parseEnhancedLrc(lrc([0, 0, 0, 0, 0])))).toBe(false);
  });

  it("rejects most lines sharing one stamp", () => {
    expect(hasRealTiming(parseEnhancedLrc(lrc([5, 5, 5, 5, 5, 5, 30, 60])))).toBe(false);
  });
});

describe("timingFitsSong", () => {
  const lines = parseEnhancedLrc(lrc([20, 60, 120, 200]));
  it("fits a song long enough for it", () => expect(timingFitsSong(lines, 240)).toBe(true));
  it("doesn't fit a shorter version", () => expect(timingFitsSong(lines, 150)).toBe(false));
  it("trusts the timing when the length is unknown", () => expect(timingFitsSong(lines)).toBe(true));
  it("rejects a first line most of the way in", () =>
    expect(timingFitsSong(parseEnhancedLrc(lrc([170, 180, 190])), 220)).toBe(false));
});

describe("processLyricsPayload", () => {
  it("keeps real line timing synced", () => {
    const result = processLyricsPayload(payload({ syncedLyrics: lrc([12, 18, 25, 31, 40]) }), 200);
    expect(result.syncType).toBe("line");
    expect(result.synced).toBe(true);
  });

  it("shows the source's plain lyrics, as they are, when every stamp is 0:00", () => {
    const result = processLyricsPayload(
      payload({ syncedLyrics: lrc([0, 0, 0, 0]), plainLyrics: "Verse one\n\nVerse two" }),
      200,
    );
    expect(result.syncType).toBe("plain");
    expect(result.lines.map((l) => l.text)).toEqual(["Verse one", "Verse two"]);
  });

  it("falls back to the timed lines, untimed and in order, with no plain text", () => {
    const result = processLyricsPayload(payload({ syncedLyrics: lrc([0, 0, 0]) }), 200);
    expect(result.syncType).toBe("plain");
    expect(result.lines.map((l) => l.text)).toEqual(["Line 1", "Line 2", "Line 3"]);
    expect(result.lines.every((l) => l.startTime === 0 && !l.words)).toBe(true);
  });

  it("shows lyrics timed for a longer version as plain", () => {
    const result = processLyricsPayload(payload({ syncedLyrics: lrc([20, 60, 120, 200, 260, 330]) }), 240);
    expect(result.syncType).toBe("plain");
  });

  it("keeps plain-only lyrics plain", () => {
    const result = processLyricsPayload(payload({ plainLyrics: "a\nb" }), 200);
    expect(result.syncType).toBe("plain");
    expect(result.lines).toHaveLength(2);
  });

  it("reports no lyrics when there are none", () => {
    expect(processLyricsPayload(payload({}), 200).lines).toHaveLength(0);
  });
});

describe("lyric rows", () => {
  const lines = parseEnhancedLrc(lrc([10, 14, 30, 34]));
  const rows = buildLyricRows(lines);

  it("adds an intro break before a late first line and a break for long gaps", () => {
    expect(rows.map((r) => r.kind)).toEqual(["interlude", "line", "line", "interlude", "line", "line"]);
  });

  it("finds the current row, never jumping to the last line at the start", () => {
    expect(activeRowIndex(rows, 0)).toBe(0); // the intro, not the last line
    expect(activeRowIndex(rows, 15)).toBe(2);
    expect(activeRowIndex(rows, 100)).toBe(rows.length - 1);
  });
});

describe("duets", () => {
  /** A TTML document with one line per [agent, start second] pair. */
  const ttml = (lines: Array<[string | null, number]>, head = "") =>
    `<tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><head><metadata>${head}</metadata></head><body><div>` +
    lines
      .map(([agent, t], i) => {
        const a = agent ? ` ttm:agent="${agent}"` : "";
        return `<p begin="${t}s" end="${t + 2}s"${a}><span begin="${t}s" end="${t + 1}s">Line</span> <span begin="${t + 1}s" end="${t + 2}s">${i + 1}</span></p>`;
      })
      .join("") +
    "</div></body></tt>";

  it("puts the second singer's lines on the other side", () => {
    const lines = parseTtml(ttml([["v1", 1], ["v2", 4], ["v2", 7], ["v1", 10]]));
    expect(lines.map((l) => l.side)).toEqual(["start", "end", "end", "start"]);
  });

  it("keeps group lines at the start without changing whose turn it is", () => {
    const head = '<ttm:agent type="group" xml:id="v3"/>';
    const lines = parseTtml(ttml([["v1", 1], ["v2", 4], ["v3", 7], ["v2", 10], ["v1000", 13]], head));
    expect(lines.map((l) => l.side)).toEqual(["start", "end", "start", "end", "start"]);
  });

  it("leaves a song with one singer alone", () => {
    const lines = parseTtml(ttml([["v1", 1], ["v1", 4], [null, 7]]));
    expect(lines.every((l) => l.side === undefined)).toBe(true);
  });

  it("flips a song that would sit almost entirely on the end side", () => {
    const parts: Array<[string, number]> = [["v1", 1]];
    for (let i = 0; i < 9; i++) parts.push(["v2", 4 + i * 3]);
    const lines = parseTtml(ttml(parts));
    expect(lines[0].side).toBe("end");
    expect(lines.slice(1).every((l) => l.side === "start")).toBe(true);
  });
});
