import { describe, expect, it } from "vitest";
import { lyricsToTtml } from "./lyricsTtml";
import { parseTtml, type RichLyricLine } from "../../lib/lyrics";

const word = (text: string, startTime: number, endTime: number) => ({ text, startTime, endTime });

describe("lyricsToTtml", () => {
  it("writes word timing as spans with spaces between words", () => {
    const lines: RichLyricLine[] = [
      { id: 0, startTime: 1, endTime: 3, text: "Hello world", words: [word("Hel", 1, 1.4), word("lo", 1.4, 2), word(" world", 2, 3)] },
    ];
    const ttml = lyricsToTtml({ syncType: "word", lines });
    expect(ttml).toContain('itunes:timing="Word"');
    expect(ttml).toContain(
      '<span begin="1.000s" end="1.400s">Hel</span><span begin="1.400s" end="2.000s">lo</span> <span begin="2.000s" end="3.000s">world</span>',
    );
  });

  it("round-trips through our own TTML reader", () => {
    const lines: RichLyricLine[] = [
      { id: 0, startTime: 1, endTime: 3, text: "One two", words: [word("One", 1, 2), word(" two", 2, 3)], background: { text: "(ooh)", words: [word("(ooh)", 2, 3)] } },
      { id: 1, startTime: 4, endTime: 6, text: "Three", words: [word("Three", 4, 6)], side: "end", agent: "v2" },
    ];
    const back = parseTtml(lyricsToTtml({ syncType: "word", lines }));
    expect(back.map((l) => l.text)).toEqual(["One two", "Three"]);
    expect(back[0].background?.text).toBe("(ooh)");
    expect(back[1].agent).toBe("v2");
  });

  it("marks the far side of a duet as the other singer", () => {
    const lines: RichLyricLine[] = [
      { id: 0, startTime: 1, endTime: 2, text: "Me", side: "start" },
      { id: 1, startTime: 2, endTime: 3, text: "You", side: "end" },
    ];
    const ttml = lyricsToTtml({ syncType: "line", lines });
    expect(ttml).toContain('<ttm:agent type="other" xml:id="v2"/>');
    expect(ttml).toContain('itunes:key="L2" ttm:agent="v2">You</p>');
  });

  it("times unsynced lyrics 0 to 0 and escapes text", () => {
    const lines: RichLyricLine[] = [{ id: 0, startTime: 0, endTime: 0, text: "Rock & <roll>" }];
    const ttml = lyricsToTtml({ syncType: "plain", lines });
    expect(ttml).toContain('itunes:timing="None"');
    expect(ttml).toContain('<p begin="0.000s" end="0.000s" itunes:key="L1" ttm:agent="v1">Rock &amp; &lt;roll&gt;</p>');
  });

  it("keys one caption per line (romanized, then translated), skipping empty lines", () => {
    const lines: RichLyricLine[] = [
      { id: 0, startTime: 1, endTime: 2, text: "रब" },
      { id: 1, startTime: 2, endTime: 3, text: "" },
      { id: 2, startTime: 3, endTime: 4, text: "मिल गया" },
    ];
    const ttml = lyricsToTtml(
      { syncType: "line", lines },
      { translations: ["God", null, "found"], romanized: ["rab", null, null] },
    );
    expect(ttml).toContain('itunes:key="L1" ttm:agent="v1">रब</p>');
    expect(ttml).toContain('itunes:key="L2" ttm:agent="v1">मिल गया</p>');
    expect(ttml).toContain('<translations><translation><text for="L1">rab\nGod</text><text for="L2">found</text></translation></translations>');
    expect(ttml).not.toContain("transliteration");
    expect(parseTtml(ttml).map((l) => l.text)).toEqual(["रब", "मिल गया"]);
  });

  it("leaves the metadata alone without alternates", () => {
    const ttml = lyricsToTtml({ syncType: "line", lines: [{ id: 0, startTime: 1, endTime: 2, text: "Hi" }] });
    expect(ttml).not.toContain("iTunesMetadata");
  });
});
