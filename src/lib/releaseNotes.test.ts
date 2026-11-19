import { describe, expect, it } from "vitest"
import { shortenNotes } from "./releaseNotes"

const NOTES = `A stability update: faster lyrics, full playlists, and a lot of fixes.

- **Big playlists load in full.** Liked Music no longer stops at about 100 songs.
- **Lyrics show up faster.** Every lyrics source is asked at once.
- Plus fixes for playlist imports ("50 Cent" keeps its name), the Esc key and more.
`

describe("shortenNotes", () => {
  it("keeps the opening line and each bullet's bold lead", () => {
    expect(shortenNotes(NOTES)).toEqual({
      summary: "A stability update: faster lyrics, full playlists, and a lot of fixes.",
      points: [
        "Big playlists load in full",
        "Lyrics show up faster",
        'Plus fixes for playlist imports ("50 Cent" keeps its name), the Esc key and more',
      ],
    })
  })

  it("caps the number of points", () => {
    expect(shortenNotes(NOTES, 2).points).toHaveLength(2)
  })

  it("handles missing notes and plain text", () => {
    expect(shortenNotes(null)).toEqual({ summary: null, points: [] })
    expect(shortenNotes("Bug fixes and improvements.")).toEqual({ summary: "Bug fixes and improvements.", points: [] })
  })
})
