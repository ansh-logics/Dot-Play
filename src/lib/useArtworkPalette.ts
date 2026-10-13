import { useEffect, useState } from "react"

/**
 * Extracts a small, legible palette from album artwork for the Now Playing backdrop.
 * YouTube thumbnail hosts send `Access-Control-Allow-Origin: *`, so a CORS-enabled
 * image can be read back from a canvas.
 */
export interface ArtworkPalette {
  /** Large-area colours ordered by prominence, tuned to sit behind white text. */
  colors: [string, string, string, string]
  /** Darkest anchor used for the base fill. */
  base: string
  /**
   * Scale that hides baked-in letterbox bars when the image is shown square
   * with object-fit: cover (1 = no bars detected).
   */
  zoom: number
}

const SAMPLE = 24
const K = 4
const cache = new Map<string, ArtworkPalette | null>()

type RGB = [number, number, number]

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h * 60, s, l]
}

const hsl = (h: number, s: number, l: number) =>
  `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`

/** Keep colours rich but dark enough that white type stays readable on top. */
function tune([h, s, l]: [number, number, number], maxL: number): string {
  return hsl(h, Math.min(Math.max(s, 0.28), 0.8), Math.min(Math.max(l, 0.2), maxL))
}

function kmeans(pixels: RGB[]): { center: RGB; size: number }[] {
  // Seed with evenly spaced samples for deterministic results.
  let centers: RGB[] = Array.from({ length: K }, (_, i) => pixels[Math.floor((i + 0.5) * (pixels.length / K))])
  let assignment = new Array<number>(pixels.length).fill(0)
  for (let iter = 0; iter < 8; iter++) {
    assignment = pixels.map((p) => {
      let best = 0
      let bestD = Infinity
      centers.forEach((c, i) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2
        if (d < bestD) {
          bestD = d
          best = i
        }
      })
      return best
    })
    centers = centers.map((c, i) => {
      const members = pixels.filter((_, idx) => assignment[idx] === i)
      if (!members.length) return c
      const sum = members.reduce<RGB>((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0])
      return [sum[0] / members.length, sum[1] / members.length, sum[2] / members.length]
    })
  }
  return centers
    .map((center, i) => ({ center, size: assignment.filter((a) => a === i).length }))
    .sort((a, b) => b.size - a.size)
}

/**
 * Fraction of the image height covered by a black bar at the top *and* bottom.
 * Catches YouTube's 4:3 thumbnails of 16:9 videos and cinematic music videos.
 */
function detectLetterbox(img: HTMLImageElement): number {
  const W = 48
  const H = Math.max(8, Math.round((W * img.naturalHeight) / img.naturalWidth))
  const canvas = document.createElement("canvas")
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) return 0
  ctx.drawImage(img, 0, 0, W, H)
  const data = ctx.getImageData(0, 0, W, H).data
  const rowIsBar = (y: number) => {
    let max = 0
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      max = Math.max(max, data[i], data[i + 1], data[i + 2])
    }
    return max < 28 // every pixel in the row is near-black
  }
  let top = 0
  while (top < H / 2 && rowIsBar(top)) top++
  let bottom = 0
  while (bottom < H / 2 && rowIsBar(H - 1 - bottom)) bottom++
  const bar = Math.min(top, bottom) / H
  // Ignore hairlines and fully-dark artwork.
  return bar > 0.02 && bar < 0.3 ? bar : 0
}

function extract(img: HTMLImageElement): ArtworkPalette | null {
  const canvas = document.createElement("canvas")
  canvas.width = SAMPLE
  canvas.height = SAMPLE
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) return null
  const w = img.naturalWidth
  const h = img.naturalHeight
  const bar = detectLetterbox(img)
  // Sample the central square of the picture, excluding any letterbox bars.
  const contentH = h * (1 - 2 * bar)
  const side = Math.min(w, contentH)
  const sx = (w - side) / 2
  const sy = (h - side) / 2
  ctx.drawImage(img, sx, sy, side, side, 0, 0, SAMPLE, SAMPLE)
  const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data // throws if tainted
  const all: RGB[] = []
  const usable: RGB[] = []
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue
    const px: RGB = [data[i], data[i + 1], data[i + 2]]
    all.push(px)
    // Near-black and near-white pixels flatten the palette into mud; skip them
    // unless the artwork is mostly made of them.
    const l = rgbToHsl(px)[2]
    if (l > 0.07 && l < 0.95) usable.push(px)
  }
  const pixels = usable.length >= all.length * 0.25 ? usable : all
  if (pixels.length < K) return null

  const clusters = kmeans(pixels).map((c) => ({ ...c, hsl: rgbToHsl(c.center) }))
  // Prefer colourful clusters for the accents; fall back to prominence for greyscale art.
  const byVividness = [...clusters].sort((a, b) => b.hsl[1] * Math.sqrt(b.size) - a.hsl[1] * Math.sqrt(a.size))
  const darkest = [...clusters].sort((a, b) => a.hsl[2] - b.hsl[2])[0]

  return {
    colors: [
      tune(clusters[0].hsl, 0.46),
      tune(byVividness[0].hsl, 0.5),
      tune(byVividness[1]?.hsl ?? clusters[1].hsl, 0.42),
      tune(clusters[clusters.length - 1].hsl, 0.36),
    ],
    // A deep shade of the dominant hue reads richer than near-black.
    // Shown square with object-fit: cover, the bars take `bar` of the height top and bottom.
    // +1.2% margin: JPEG ringing softens the bar edge, so detection undercounts by a row.
    zoom: bar > 0 ? +(1 / (1 - 2 * (bar + 0.012))).toFixed(3) : 1,
    base: hsl(clusters[0].hsl[0], Math.min(Math.max(clusters[0].hsl[1], 0.3), 0.55), Math.min(Math.max(darkest.hsl[2], 0.08), 0.13)),
  }
}

/** Palette (and letterbox zoom) for the artwork URL actually on screen. */
export function useArtworkPalette(url: string | undefined): ArtworkPalette | null {
  // Keep showing the previous palette until the new one is ready, so the backdrop crossfades
  // from old colours to new instead of flashing to the fallback.
  const [result, setResult] = useState<{ url: string; palette: ArtworkPalette | null } | null>(null)

  useEffect(() => {
    if (!url || cache.has(url)) return
    let cancelled = false
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.decoding = "async"
    img.onload = () => {
      let palette: ArtworkPalette | null = null
      try {
        palette = extract(img)
      } catch (err) {
        // Tainted canvas or decode failure → the backdrop falls back to blurred artwork.
        console.warn("[DOT Music] Artwork palette extraction failed:", url, err)
        palette = null
      }
      cache.set(url, palette)
      if (!cancelled) setResult({ url, palette })
    }
    img.onerror = () => {
      console.warn("[DOT Music] Artwork palette image failed to load (CORS?):", url)
      cache.set(url, null)
      if (!cancelled) setResult({ url, palette: null })
    }
    img.src = url
    return () => {
      cancelled = true
    }
  }, [url])

  if (!url) return null
  if (cache.has(url)) return cache.get(url) ?? null
  return result?.palette ?? null
}
