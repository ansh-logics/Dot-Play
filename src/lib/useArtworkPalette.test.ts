import { describe, expect, it } from "vitest"
import { choosePalette } from "./useArtworkPalette"

function parseHsl(str: string): { h: number; s: number; l: number } {
  const match = str.match(/hsl\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*\)/i)
  if (!match) throw new Error(`Invalid HSL string: ${str}`)
  return {
    h: Number(match[1]),
    s: Number(match[2]),
    l: Number(match[3]),
  }
}

function hueDistance(h1: number, h2: number): number {
  const diff = Math.abs(h1 - h2) % 360
  return diff > 180 ? 360 - diff : diff
}

describe("choosePalette", () => {
  it("prioritizes vibrant teal over skin tones and avoids hue collisions", () => {
    const clusters = [
      { hsl: [28, 0.45, 0.55] as [number, number, number], size: 300 },
      { hsl: [185, 0.7, 0.45] as [number, number, number], size: 120 },
      { hsl: [220, 0.5, 0.2] as [number, number, number], size: 150 },
    ]
    const palette = choosePalette(clusters)

    // (1) colors[0] must be the teal hue
    const c0 = parseHsl(palette.colors[0])
    expect(c0.h).toBe(185)

    // No two of the 4 colours share a hue within 20° unless they're the fill rotations
    const parsedHues = palette.colors.map((c) => parseHsl(c).h)
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const dist = hueDistance(parsedHues[i], parsedHues[j])
        if (dist <= 20) {
          // Fill rotation occurs at index 3
          expect(i === 3 || j === 3).toBe(true)
        }
      }
    }
  })

  it("ensures all colours have saturation <= 15% for greyscale covers", () => {
    const greyClusters = [
      { hsl: [0, 0.05, 0.2] as [number, number, number], size: 350 },
      { hsl: [40, 0.08, 0.4] as [number, number, number], size: 250 },
      { hsl: [120, 0.02, 0.6] as [number, number, number], size: 180 },
      { hsl: [200, 0.1, 0.35] as [number, number, number], size: 120 },
      { hsl: [280, 0.04, 0.75] as [number, number, number], size: 80 },
    ]
    const palette = choosePalette(greyClusters)

    // (2) all colours have saturation <= 15%
    for (const color of palette.colors) {
      const parsed = parseHsl(color)
      expect(parsed.s).toBeLessThanOrEqual(15)
    }
  })

  it("sets base lightness to 9%", () => {
    const clusters = [
      { hsl: [28, 0.45, 0.55] as [number, number, number], size: 300 },
      { hsl: [185, 0.7, 0.45] as [number, number, number], size: 120 },
      { hsl: [220, 0.5, 0.2] as [number, number, number], size: 150 },
    ]
    const palette = choosePalette(clusters)
    // (3) base lightness is 9%
    expect(parseHsl(palette.base).l).toBe(9)

    const greyClusters = [
      { hsl: [0, 0.05, 0.2] as [number, number, number], size: 350 },
      { hsl: [40, 0.08, 0.4] as [number, number, number], size: 250 },
    ]
    const greyPalette = choosePalette(greyClusters)
    expect(parseHsl(greyPalette.base).l).toBe(9)
  })
})
