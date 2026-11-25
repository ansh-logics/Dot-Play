/**
 * Ground queries for the car physics: where a world point sits relative to the road, how
 * high the visible ground is there and what it is made of.
 *
 * The drive's ground is not one heightfield: near the road it is road-relative strips
 * (columns at fixed lateral offsets, linear in between), inland beyond them the far ring
 * (`hills()`), and on the ocean side a beach that falls under the sea. Heights here follow
 * the same rules as the meshes, so the wheels touch what the player sees.
 *
 * Every query is allocation-free and O(1) amortised: the nearest road sample is found by
 * walking from the last answer (a car moves at most a sample or two per sub-step).
 */
import * as THREE from "three"
import { ROAD_HALF, Road, STEP, groundHeight, hills } from "./road"

export type Surface = "road" | "shoulder" | "grass" | "sand" | "water"

/**
 * Lateral offsets of the near ground strip columns (negative = inland, positive = ocean
 * side). Must match GROUND_OFFSETS in engine.ts, which builds the meshes from them.
 */
export const STRIP_OFFSETS = [-212, -190, -169, -149, -130, -112, -95, -79, -65, -52, -41, -32, -24, -17.5, -12, -8, -5.95, 5.95, 8, 11.5, 16, 22, 30, 40, 53, 70, 92, 125, 170]

/** Gravel/dust beside the asphalt, out to this lateral offset. */
export const SHOULDER_TO = 9
/** Ground below this is under the sea (y = 0) or the wet waterline. */
export const WATER_LEVEL = 0.15
/** The beach turns into grassy bank above this height. */
const SAND_BELOW = 5

export interface RoadLocation {
  /** Nearest road sample: the point lies between sample `index` and `index + 1`. */
  index: number
  /** 0..1 between `index` and `index + 1`. */
  t: number
  /** Distance along the road, metres. */
  s: number
  /** Signed lateral offset from the centreline, + = ocean side (right of travel). */
  off: number
  /** Road (centreline) height at this point along the road. */
  roadY: number
  /** Interpolated centreline point and right (ocean side) unit vector, for strip lookups. */
  cx: number
  cz: number
  rx: number
  rz: number
  heading: number
}

export function newLocation(): RoadLocation {
  return { index: 0, t: 0, s: 0, off: 0, roadY: 0, cx: 0, cz: 0, rx: -1, rz: 0, heading: 0 }
}

/** A hint further than this from the point is treated as lost (teleport, reset). */
const LOST = 320
/** Walking more samples than this means the hint was poor; fall back to a scan. */
const MAX_WALK = 96
/** Coarse scan stride (samples). 32 m is far below the tightest bend radius (240 m). */
const SCAN_STRIDE = 8

export class TerrainQuery {
  private hint = 0
  private scratch = newLocation()

  readonly road: Road

  constructor(road: Road) {
    this.road = road
  }

  /** Forgets the walk hint, so the next locate() scans the whole road (after a teleport). */
  resetHint() {
    this.hint = -1
  }

  private d2(i: number, x: number, z: number) {
    const dx = this.road.xs[i] - x, dz = this.road.zs[i] - z
    return dx * dx + dz * dz
  }

  /** Makes sure samples up to i + 2 exist (the road grows lazily). */
  private grow(i: number) {
    if (i + 2 >= this.road.xs.length) this.road.ensure((i + 3) * STEP)
  }

  /** Nearest sample by a strided scan over everything generated, then a local walk. */
  private scan(x: number, z: number) {
    const n = this.road.xs.length
    let best = 0, bestD = Infinity
    for (let i = 0; i < n; i += SCAN_STRIDE) {
      const d = this.d2(i, x, z)
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }

  /** Walks from i towards the nearest sample; returns -1 if it took too long. */
  private walk(i: number, x: number, z: number) {
    let d = this.d2(i, x, z)
    for (let k = 0; k < MAX_WALK; k++) {
      this.grow(i)
      const dn = this.d2(i + 1, x, z)
      if (dn < d) { i++; d = dn; continue }
      if (i > 0) {
        const dp = this.d2(i - 1, x, z)
        if (dp < d) { i--; d = dp; continue }
      }
      return i
    }
    return -1
  }

  /**
   * Nearest road position to (x, z). Walks from the previous answer, so calling it for a
   * car and its wheels every sub-step costs a couple of distance checks each.
   */
  locate(x: number, z: number, out: RoadLocation): RoadLocation {
    const road = this.road
    let i = this.hint
    if (!(i >= 0 && i < road.xs.length - 1) || this.d2(i, x, z) > LOST * LOST) i = this.scan(x, z)
    let w = this.walk(i, x, z)
    if (w < 0) w = this.walk(this.scan(x, z), x, z)
    i = Math.max(0, w)
    this.hint = i
    this.grow(i)

    // Project onto the segment after the nearest sample, or the one before it.
    const xs = road.xs, zs = road.zs
    let seg = i
    let t = ((x - xs[i]) * (xs[i + 1] - xs[i]) + (z - zs[i]) * (zs[i + 1] - zs[i])) / (STEP * STEP)
    if (t < 0 && i > 0) {
      seg = i - 1
      t = ((x - xs[seg]) * (xs[i] - xs[seg]) + (z - zs[seg]) * (zs[i] - zs[seg])) / (STEP * STEP)
    }
    t = Math.min(1, Math.max(0, t))
    const h = road.hs[seg] + (road.hs[seg + 1] - road.hs[seg]) * t
    const cx = xs[seg] + (xs[seg + 1] - xs[seg]) * t
    const cz = zs[seg] + (zs[seg + 1] - zs[seg]) * t
    // rightOf(h), inlined: it returns a fresh tuple and this runs hundreds of times a second.
    const rx = -Math.cos(h), rz = Math.sin(h)
    out.index = seg
    out.t = t
    out.s = (seg + t) * STEP
    out.off = (x - cx) * rx + (z - cz) * rz
    out.roadY = road.ys[seg] + (road.ys[seg + 1] - road.ys[seg]) * t
    out.cx = cx
    out.cz = cz
    out.rx = rx
    out.rz = rz
    out.heading = h
    return out
  }

  /**
   * Visible ground height at (x, z), given that point's location (from locate()). Kept
   * separate so the physics can reuse one locate() for height, surface and lane checks.
   */
  heightAtLocation(loc: RoadLocation, x: number, z: number): number {
    const off = loc.off
    if (Math.abs(off) <= ROAD_HALF) return loc.roadY + 0.02 // asphalt ribbon lift
    const first = STRIP_OFFSETS[0], last = STRIP_OFFSETS[STRIP_OFFSETS.length - 1]
    if (off < first) return hills(x, z) // the far ring inland
    if (off > last) return groundHeight(loc.roadY, off, x, z) // sea floor
    // Between two strip columns on this side: linear, like the mesh's triangles.
    let c = 0
    while (c < STRIP_OFFSETS.length - 2 && STRIP_OFFSETS[c + 1] <= off) c++
    const o0 = STRIP_OFFSETS[c], o1 = STRIP_OFFSETS[c + 1]
    const u = Math.min(1, Math.max(0, (off - o0) / (o1 - o0)))
    const h0 = groundHeight(loc.roadY, o0, loc.cx + loc.rx * o0, loc.cz + loc.rz * o0)
    const h1 = groundHeight(loc.roadY, o1, loc.cx + loc.rx * o1, loc.cz + loc.rz * o1)
    return h0 + (h1 - h0) * u
  }

  /** What the ground is made of, given its location and height. */
  surfaceOf(loc: RoadLocation, ground: number): Surface {
    const ad = Math.abs(loc.off)
    if (ad <= ROAD_HALF) return "road"
    if (ground < WATER_LEVEL) return "water"
    if (ad <= SHOULDER_TO) return "shoulder"
    if (loc.off > 0 && ground < SAND_BELOW) return "sand"
    return "grass"
  }

  /**
   * Ground height under (x, z): asphalt on the road, the strips beside it, hills inland
   * past the strips. On the ocean side it can be below 0 (under the sea).
   */
  heightAt(x: number, z: number): number {
    return this.heightAtLocation(this.locate(x, z, this.scratch), x, z)
  }

  surfaceAt(x: number, z: number): Surface {
    const loc = this.locate(x, z, this.scratch)
    return this.surfaceOf(loc, this.heightAtLocation(loc, x, z))
  }

  /** Ground normal from central differences over half a metre. */
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = 0.5
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z)
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e)
    out.set(-dx / (2 * e), 1, -dz / (2 * e))
    const len = out.length()
    return len > 0 && Number.isFinite(len) ? out.divideScalar(len) : out.set(0, 1, 0)
  }
}
