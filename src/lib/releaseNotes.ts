/**
 * Release notes, as written for a GitHub release, shortened for the update prompt: the
 * opening line, then each bullet's bold lead ("**Lyrics show up faster.** Every source…"
 * becomes "Lyrics show up faster"). A bullet with no bold lead keeps its first sentence.
 */
export interface ShortNotes {
  summary: string | null
  points: string[]
}

/** Markdown links, emphasis and code as plain text. */
const plain = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()

/** "Lyrics show up faster." → "Lyrics show up faster" (a full stop only; "?" and "!" stay). */
const dropFullStop = (text: string) => text.replace(/\.$/, "")

export function shortenNotes(notes: string | null | undefined, maxPoints = 6): ShortNotes {
  if (!notes?.trim()) return { summary: null, points: [] }
  const lines = notes.replace(/\r\n?/g, "\n").split("\n")
  let summary: string | null = null
  const points: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const bullet = /^[-*+]\s+(.*)$/.exec(line) ?? /^\d+[.)]\s+(.*)$/.exec(line)
    if (bullet) {
      const body = bullet[1]
      const lead = /^\*\*(.+?)\*\*/.exec(body)
      const text = lead ? plain(lead[1]) : plain(body).split(/(?<=[.!?])\s/)[0]
      if (text) points.push(dropFullStop(text))
    } else if (summary === null && points.length === 0) {
      summary = plain(line)
    }
  }
  return { summary, points: points.slice(0, maxPoints) }
}
