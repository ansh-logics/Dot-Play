import { describe, expect, it } from "vitest";
import { linkSpans } from "./ArtistLinks";

const ref = (name: string, browseId = `UC${name.replace(/\W/g, "")}`) => ({ name, browseId });

describe("artist links", () => {
  it("links each credited artist where they appear in the shown text", () => {
    const text = "Karan Aujla, Ikky";
    const spans = linkSpans(text, [ref("Karan Aujla"), ref("Ikky")]);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["Karan Aujla", "Ikky"]);
  });

  it("keeps co-artists without a channel as plain text", () => {
    const text = "Adele & Someone Else";
    const spans = linkSpans(text, [ref("Adele")]);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["Adele"]);
  });

  it("links nothing when the names don't appear (cleaned text differs)", () => {
    expect(linkSpans("Adele", [ref("AdeleVEVO")])).toEqual([]);
  });

  it("matches case-insensitively and never overlaps", () => {
    const text = "DIVINE, Divine Jr";
    const spans = linkSpans(text, [ref("divine", "UC1"), ref("Divine", "UC2")]);
    expect(spans.map((s) => [s.start, s.end])).toEqual([
      [0, 6],
      [8, 14],
    ]);
  });
});
