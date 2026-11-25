/**
 * The endless road: a centreline grown a few metres at a time from a seeded random
 * generator, with smoothly drifting curvature and gentle hills. Everything else in the
 * drive (terrain, props, the car) is placed relative to it.
 */

export const STEP = 4 // metres between centreline samples
export const ROAD_HALF = 6 // asphalt half-width: two 3.5 m lanes plus shoulders
export const LANE = 1.9 // centre of the right-hand lane

/** Small, fast, seedable PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface RoadSample {
  x: number
  y: number
  z: number
  heading: number
}

export class Road {
  readonly xs: number[] = []
  readonly ys: number[] = []
  readonly zs: number[] = []
  readonly hs: number[] = []
  private rand: () => number
  private curv = 0
  private curvTarget = 0
  private segLeft = 0
  private phases: number[]

  constructor(seed: number) {
    this.rand = rng(seed)
    this.phases = [this.rand() * 10, this.rand() * 10, this.rand() * 10]
    this.xs.push(0)
    this.zs.push(0)
    this.hs.push(0)
    this.ys.push(this.elevation(0))
  }

  get length() {
    return (this.xs.length - 1) * STEP
  }

  /** Road height at distance s: rolling, never dipping into the sea. */
  elevation(s: number) {
    const [a, b, c] = this.phases
    return 7 + 3.2 * Math.sin(s / 340 + a) + 1.6 * Math.sin(s / 131 + b) + 0.5 * Math.sin(s / 47 + c)
  }

  /** Grows the centreline until it reaches at least `s` metres. */
  ensure(s: number) {
    while (this.length < s) {
      if (this.segLeft <= 0) {
        const r = this.rand()
        // Mostly long sweeping bends, some straights, the odd tighter curve.
        if (r < 0.28) this.curvTarget = 0
        else {
          const radius = r < 0.85 ? 420 + this.rand() * 600 : 240 + this.rand() * 120
          this.curvTarget = (this.rand() < 0.5 ? -1 : 1) / radius
        }
        this.segLeft = 160 + this.rand() * 520
      }
      this.segLeft -= STEP
      this.curv += (this.curvTarget - this.curv) * 0.03
      const i = this.xs.length - 1
      const h = this.hs[i] + this.curv * STEP
      this.hs.push(h)
      this.xs.push(this.xs[i] + Math.sin(h) * STEP)
      this.zs.push(this.zs[i] + Math.cos(h) * STEP)
      this.ys.push(this.elevation((i + 1) * STEP))
    }
  }

  /** Interpolated centreline point at distance s. */
  sample(s: number, out: RoadSample = { x: 0, y: 0, z: 0, heading: 0 }): RoadSample {
    this.ensure(s + STEP * 2)
    const f = Math.max(0, s) / STEP
    const i = Math.floor(f)
    const t = f - i
    out.x = this.xs[i] + (this.xs[i + 1] - this.xs[i]) * t
    out.y = this.ys[i] + (this.ys[i + 1] - this.ys[i]) * t
    out.z = this.zs[i] + (this.zs[i + 1] - this.zs[i]) * t
    out.heading = this.hs[i] + (this.hs[i + 1] - this.hs[i]) * t
    return out
  }
}

/** Right-hand side of the road for a heading (the ocean side). */
export const rightOf = (heading: number) => [-Math.cos(heading), Math.sin(heading)] as const

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// ---- Terrain noise -------------------------------------------------------------------

/** Integer hash → [0, 1). */
function hash2(ix: number, iz: number) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Smooth value noise in [-1, 1]. */
function vnoise(x: number, z: number) {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = x - ix, fz = z - iz
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1)
  return (a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz) * 2 - 1
}

/** Fractal noise: octaves of value noise, each finer and fainter. */
function fbm(x: number, z: number, octaves: number) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0
  for (let o = 0; o < octaves; o++) {
    // Rotate each octave a little so the grid never lines up.
    const rx = x * 0.8 - z * 0.6, rz = x * 0.6 + z * 0.8
    sum += amp * vnoise(rx * freq + o * 17.3, rz * freq - o * 9.1)
    norm += amp
    amp *= 0.5
    freq *= 2.03
    x = rx
    z = rz
  }
  return sum / norm
}

/**
 * Inland terrain height: broad rolling hills with softer ridges, bent by a domain warp so
 * the shapes look grown rather than repeated. A pure function of world position, so
 * overlapping strips on bends agree. Never dips below sea level.
 */
export function hills(x: number, z: number) {
  const s = 1 / 520
  const wx = fbm(x * s * 0.6 + 3.1, z * s * 0.6 - 1.7, 3) * 1.4
  const wz = fbm(x * s * 0.6 - 7.4, z * s * 0.6 + 4.2, 3) * 1.4
  const px = x * s + wx, pz = z * s + wz
  const rolling = fbm(px, pz, 5) // -1..1
  const ridge = 1 - Math.abs(fbm(px * 0.7 + 11, pz * 0.7 - 5, 4))
  const h = 22 + rolling * 30 + ridge * ridge * 26
  return Math.max(2, h)
}

/**
 * Ground height `off` metres to the side of the road (positive = ocean side).
 * Near the road it meets the asphalt; the ocean side falls away to a beach and the sea,
 * the inland side eases up into the hills over ~160 m (no walls beside the road).
 */
export function groundHeight(roadY: number, off: number, x: number, z: number) {
  const ad = Math.abs(off)
  const edge = roadY - 0.08
  if (off > 0) {
    const fall = smooth(ROAD_HALF + 2, 95, ad)
    const embank = edge - smooth(ROAD_HALF + 0.5, ROAD_HALF + 8, ad) * 1.2
    return embank + (-5 - embank) * fall
  }
  const blend = smooth(ROAD_HALF + 3, 160, ad)
  return edge + (hills(x, z) - edge) * blend
}
