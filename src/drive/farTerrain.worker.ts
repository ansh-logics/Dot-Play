/**
 * Far terrain builder. Runs in a module Web Worker (see farTerrain.ts), and the same
 * `buildFarTerrain` is imported on the main thread as a fallback when workers fail.
 *
 * The ring is a world-space grid, so it never folds on bends the way road-relative strips
 * do. Each vertex is classified against the nearest road sample: vertices close to
 * the road sink out of sight under the near strips, and everything else is the same
 * `hills()` field the near strips blend into.
 */
import { hills, rightOf } from "./road"

export interface FarRequest {
  id: number
  centerX: number
  centerZ: number
  /** Grid steps per side: the mesh has (n + 1)² vertices. */
  n: number
  /** Half-size of the ring in metres. */
  extent: number
  trees: number
  /** Road samples near the centre, positions relative to the centre. */
  road: { xs: Float32Array; ys: Float32Array; zs: Float32Array; hs: Float32Array }
  /** Slice indices (inclusive) the near strips currently cover; outside them nothing hides a sunk ring. */
  coveredFrom: number
  coveredTo: number
}

export interface FarResult {
  id: number
  centerX: number
  centerZ: number
  n: number
  /** Relative to (centerX, 0, centerZ). */
  positions: Float32Array
  normals: Float32Array
  /** r = sand, g = brightness (forest darkened), b = slope. */
  colors: Float32Array
  /** World / 3.2, rebased by whole multiples of 100. */
  uvs: Float32Array
  /** x, y, z (relative to the centre), scale per tree. */
  trees: Float32Array
}

const UV_M = 3.2
/** Inner grid spacing we aim for, metres. */
const INNER_SPACING = 10
/** Beside the road, the near strips reach ~210 m; below this the ring hides under them. */
const SINK_TO = 190
const SINK_BLEND = 212
/** Trees: none closer to the centre than this needs thinning; none past TREE_MAX_R. */
// Flat distant tree cards start where the haze hides that they're flat; 3D trees cover nearer.
const TREE_NEAR = 420
const TREE_MAX_R = 2700
/**
 * Cell area × tree budget: cell size = sqrt(TREE_AREA / trees). Tuned (seed 7) so dense
 * woods fill the budget about as the old rejection sampler did; sparse countryside places fewer.
 */
const TREE_AREA = 5e5

const FINE = 64
const FINE_HALF = 4800
const FINE_DIM = Math.ceil((FINE_HALF * 2) / FINE)
/** The fine search covers ±4 cells, so any hit within this distance is exact. */
const FINE_REACH = 4 * FINE
const COARSE = 512
const COARSE_HALF = 6144
const COARSE_DIM = Math.ceil((COARSE_HALF * 2) / COARSE)
const COARSE_STRIDE = 8

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// ---- Noise (own copy: road.ts keeps its noise private) ---------------------------------

function hash2(ix: number, iz: number) {
  let h = Math.imul(ix, 668265263) + Math.imul(iz, 374761393) + 0x5bd1e995
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function vnoise(x: number, z: number) {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = x - ix, fz = z - iz
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1)
  return (a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz) * 2 - 1
}

/** Patches of forest, 0..1, with ragged edges so they read as woods rather than blobs. */
function forestMask(x: number, z: number) {
  const broad = vnoise(x / 1100 + 13.7, z / 1100 - 4.1) * 0.6 + vnoise(x / 520 - 2.3, z / 520 + 8.8) * 0.3
  const edge = vnoise(x / 170 + 5.1, z / 170 + 1.9) * 0.12
  return smooth(0.1, 0.2, broad + edge)
}

// ---- Road lookup ---------------------------------------------------------------------

/** Counting-sort bucket of sample indices into a square grid of cells centred on the origin. */
interface Buckets {
  start: Int32Array
  items: Int32Array
  cell: number
  half: number
  dim: number
}

function bucket(xs: Float32Array, zs: Float32Array, list: Int32Array, cell: number, half: number, dim: number): Buckets {
  const start = new Int32Array(dim * dim + 1)
  const cellOf = new Int32Array(list.length)
  for (let k = 0; k < list.length; k++) {
    const i = list[k]
    const cx = Math.floor((xs[i] + half) / cell), cz = Math.floor((zs[i] + half) / cell)
    const c = cx >= 0 && cx < dim && cz >= 0 && cz < dim ? cz * dim + cx : -1
    cellOf[k] = c
    if (c >= 0) start[c + 1]++
  }
  for (let c = 0; c < dim * dim; c++) start[c + 1] += start[c]
  const fill = start.slice(0, dim * dim)
  const items = new Int32Array(start[dim * dim])
  for (let k = 0; k < list.length; k++) if (cellOf[k] >= 0) items[fill[cellOf[k]]++] = list[k]
  return { start, items, cell, half, dim }
}

interface Lookup {
  xs: Float32Array
  zs: Float32Array
  rx: Float32Array
  rz: Float32Array
  count: number
  fine: Buckets
  coarse: Buckets
}

// Results of the last `nearest` call (module scratch: no allocation per query).
let lkI = -1
let lkDist = 0
/** Signed lateral offset: + = right of travel. */
let lkD = 0
/** Point lies beyond either end of the known road (distance measured to its straight extension). */
let lkExtrap = false

function scan(L: Lookup, b: Buckets, px: number, pz: number, cx: number, cz: number, best: number) {
  if (cx < 0 || cx >= b.dim || cz < 0 || cz >= b.dim) return best
  const c = cz * b.dim + cx
  for (let k = b.start[c]; k < b.start[c + 1]; k++) {
    const i = b.items[k]
    const dx = px - L.xs[i], dz = pz - L.zs[i]
    const d2 = dx * dx + dz * dz
    if (d2 < best) {
      best = d2
      lkI = i
    }
  }
  return best
}

/** Finds the nearest road sample to (px, pz) (centre-relative). False when there is no road. */
function nearest(L: Lookup, px: number, pz: number) {
  lkI = -1
  if (L.count === 0) return false
  let best = Infinity
  const f = L.fine
  const fcx = Math.floor((px + f.half) / f.cell), fcz = Math.floor((pz + f.half) / f.cell)
  if (fcx >= -4 && fcx < f.dim + 4 && fcz >= -4 && fcz < f.dim + 4) {
    for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) best = scan(L, f, px, pz, fcx + dx, fcz + dz, best)
  }
  if (best > FINE_REACH * FINE_REACH) {
    // Far from the road: expanding rings over a thinned set of samples. A ring r cells out
    // is at least (r - 1) cells away, so stop once that exceeds the best hit.
    const c = L.coarse
    const ccx = Math.floor((px + c.half) / c.cell), ccz = Math.floor((pz + c.half) / c.cell)
    for (let r = 0; r <= c.dim * 2; r++) {
      if (r > 0 && (r - 1) * c.cell * ((r - 1) * c.cell) > best) break
      if (r === 0) best = scan(L, c, px, pz, ccx, ccz, best)
      else {
        for (let k = -r; k <= r; k++) {
          best = scan(L, c, px, pz, ccx + k, ccz - r, best)
          best = scan(L, c, px, pz, ccx + k, ccz + r, best)
        }
        for (let k = -r + 1; k <= r - 1; k++) {
          best = scan(L, c, px, pz, ccx - r, ccz + k, best)
          best = scan(L, c, px, pz, ccx + r, ccz + k, best)
        }
      }
    }
  }
  if (lkI < 0) return false
  const i = lkI
  const vx = px - L.xs[i], vz = pz - L.zs[i]
  lkD = vx * L.rx[i] + vz * L.rz[i]
  // Tangent is the right vector turned a quarter: (sin h, cos h) = (rz, -rx).
  const along = vx * L.rz[i] - vz * L.rx[i]
  lkExtrap = (i === L.count - 1 && along > 2) || (i === 0 && along < -2)
  lkDist = lkExtrap ? Math.abs(lkD) : Math.sqrt(best)
  return true
}

// ---- Grid ----------------------------------------------------------------------------

/**
 * Local grid coordinate per index: x = sign(t)·(A|t| + B t²), t ∈ [-1, 1], so spacing is
 * ~INNER_SPACING at the centre and grows quadratically towards the horizon.
 */
function gridCoords(n: number, extent: number) {
  const A = Math.min(extent * 0.45, (INNER_SPACING * n) / 2)
  const B = extent - A
  const X = new Float64Array(n + 1)
  for (let i = 0; i <= n; i++) {
    const t = -1 + (2 * i) / n
    X[i] = Math.sign(t) * (A * Math.abs(t) + B * t * t)
  }
  return { X, A, B }
}

/** Builds the ring. Pure: same input, same output, on whichever thread. */
export function buildFarTerrain(req: FarRequest): FarResult {
  const { n, extent, centerX: cx, centerZ: cz } = req
  const { xs, ys, zs, hs } = req.road
  const count = xs.length

  const rx = new Float32Array(count), rz = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const r = rightOf(hs[i])
    rx[i] = r[0]
    rz[i] = r[1]
  }
  const all = new Int32Array(count)
  for (let i = 0; i < count; i++) all[i] = i
  const thinN = count === 0 ? 0 : Math.ceil(count / COARSE_STRIDE) + 1
  const thin = new Int32Array(thinN)
  for (let k = 0; k < thinN; k++) thin[k] = Math.min(count - 1, k * COARSE_STRIDE) // last entry = end sample
  const L: Lookup = {
    xs, zs, rx, rz, count,
    fine: bucket(xs, zs, all, FINE, FINE_HALF, FINE_DIM),
    coarse: bucket(xs, zs, thin, COARSE, COARSE_HALF, COARSE_DIM),
  }

  const { X, A, B } = gridCoords(n, extent)
  const side = n + 1
  const verts = side * side
  const H = new Float64Array(verts)
  /** Per vertex: whether it may grow forest. */
  const woodsOk = new Uint8Array(verts)

  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const v = j * side + i
      const lx = X[i], lz = X[j]
      const wx = cx + lx, wz = cz + lz
      if (!nearest(L, lx, lz)) {
        H[v] = hills(wx, wz)
        woodsOk[v] = 1
        continue
      }
      const covered = !lkExtrap && lkI >= req.coveredFrom && lkI <= req.coveredTo
      const y0 = ys[lkI]
      const hl = hills(wx, wz)
      if (covered) {
        // Sink well under the near strips so the two meshes never fight; rejoin hills just past their edge.
        const sunk = Math.min(hl, y0) - 40
        H[v] = sunk + (hl - sunk) * smooth(SINK_TO, SINK_BLEND, lkDist)
        woodsOk[v] = lkDist > SINK_BLEND ? 1 : 0
      } else {
        // No strip here: a soft valley along the (extended) road, always below what a strip would be.
        const base = y0 - 5
        H[v] = base + (hl - base) * smooth(20, 320, lkDist)
        woodsOk[v] = lkDist > 220 ? 1 : 0
      }
    }
  }

  const positions = new Float32Array(verts * 3)
  const normals = new Float32Array(verts * 3)
  const colors = new Float32Array(verts * 3)
  const uvs = new Float32Array(verts * 2)
  const uvBaseX = Math.floor(cx / UV_M / 100) * 100
  const uvBaseZ = Math.floor(cz / UV_M / 100) * 100

  for (let j = 0; j <= n; j++) {
    const j0 = Math.max(0, j - 1), j1 = Math.min(n, j + 1)
    for (let i = 0; i <= n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n, i + 1)
      const v = j * side + i
      const lx = X[i], lz = X[j], y = H[v]
      const wx = cx + lx, wz = cz + lz
      positions[v * 3] = lx
      positions[v * 3 + 1] = y
      positions[v * 3 + 2] = lz
      const sx = (H[j * side + i1] - H[j * side + i0]) / (X[i1] - X[i0])
      const sz = (H[j1 * side + i] - H[j0 * side + i]) / (X[j1] - X[j0])
      const inv = 1 / Math.sqrt(sx * sx + 1 + sz * sz)
      const ny = inv
      normals[v * 3] = -sx * inv
      normals[v * 3 + 1] = ny
      normals[v * 3 + 2] = -sz * inv
      uvs[v * 2] = wx / UV_M - uvBaseX
      uvs[v * 2 + 1] = wz / UV_M - uvBaseZ

      let sand: number, bright: number
      bright = 0.9 + 0.1 * vnoise(wx / 260, wz / 260)
      const f = woodsOk[v] ? forestMask(wx, wz) * (1 - smooth(70, 90, y)) : 0
      // Woods: darker, a little mottled, so distant forest reads in the terrain itself.
      bright += (0.62 * (0.94 + 0.12 * vnoise(wx / 90, wz / 90)) - bright) * f
      // Dry, sun-bleached patches in open meadows (none inside woods).
      sand = 0.35 * smooth(0.25, 0.6, vnoise(wx / 380 + 3.3, wz / 380 - 7.1)) * (1 - f)
      colors[v * 3] = sand
      colors[v * 3 + 1] = bright
      colors[v * 3 + 2] = 1 - ny
    }
  }

  // ---- Forest impostors: one candidate per world-space cell ----
  // Candidates come from a jittered grid anchored in world space and hashed per cell, so a
  // tree keeps its spot across re-centres instead of the whole forest reshuffling every
  // 160 m. Cells are visited in rings outward from the centre, so when the budget runs out
  // it is the farthest (most hazed) trees that are dropped.
  const trees = new Float32Array(req.trees * 4)
  let placed = 0
  const inverse = (x: number) => {
    const ax = Math.abs(x)
    const t = B > 1e-6 ? (-A + Math.sqrt(A * A + 4 * B * ax)) / (2 * B) : ax / A
    const fi = ((Math.sign(x) * t + 1) * n) / 2
    return Math.min(n - 1, Math.max(0, Math.floor(fi)))
  }
  const maxR = Math.min(TREE_MAX_R, extent)
  // Depends only on the budget, so the grid (and every tree on it) is stable for a tier.
  const g = Math.max(6, Math.sqrt(TREE_AREA / Math.max(1, req.trees)))
  const ccx = Math.floor(cx / g), ccz = Math.floor(cz / g)
  const R = Math.ceil(maxR / g) + 1
  const tryCell = (ix: number, iz: number) => {
    const wx = (ix + hash2(ix, iz + 7717)) * g
    const wz = (iz + hash2(ix + 1013, iz)) * g
    const lx = wx - cx, lz = wz - cz
    const r2 = lx * lx + lz * lz
    if (r2 > maxR * maxR) return
    // Density ~ r^(-2/3) past TREE_NEAR: near trees matter most, far ones dissolve in haze.
    // h < (N²/r²)^(1/3)  <=>  h³·r² < N², which skips a pow per cell.
    const h = hash2(ix - 3301, iz + 2203)
    if (h * h * h * r2 >= TREE_NEAR * TREE_NEAR) return
    if (hash2(ix + 5003, iz - 911) >= forestMask(wx, wz)) return
    if (nearest(L, lx, lz)) {
      if (lkD > 0 || lkDist < 220 || lkDist > 2500) return
    }
    // Height from the rendered triangles, not hills(), so far trees sit on the coarse mesh.
    const i0 = inverse(lx), j0 = inverse(lz)
    const fx = (lx - X[i0]) / (X[i0 + 1] - X[i0]), fz = (lz - X[j0]) / (X[j0 + 1] - X[j0])
    const a = j0 * side + i0, b = a + 1, c = a + side, d = c + 1
    const y = fx + fz <= 1
      ? H[a] + (H[b] - H[a]) * fx + (H[c] - H[a]) * fz
      : H[d] + (H[c] - H[d]) * (1 - fx) + (H[b] - H[d]) * (1 - fz)
    if (y <= 1) return
    const nv = fx < 0.5 ? (fz < 0.5 ? a : c) : fz < 0.5 ? b : d
    if (1 - normals[nv * 3 + 1] >= 0.5) return
    trees[placed * 4] = lx
    trees[placed * 4 + 1] = y
    trees[placed * 4 + 2] = lz
    trees[placed * 4 + 3] = 0.75 + hash2(ix - 7121, iz - 4057) * 0.6
    placed++
  }
  for (let r = 0; r <= R && placed < req.trees; r++) {
    if (r === 0) {
      tryCell(ccx, ccz)
      continue
    }
    for (let k = -r; k <= r && placed < req.trees; k++) {
      tryCell(ccx + k, ccz - r)
      if (placed < req.trees) tryCell(ccx + k, ccz + r)
    }
    for (let k = -r + 1; k <= r - 1 && placed < req.trees; k++) {
      tryCell(ccx - r, ccz + k)
      if (placed < req.trees) tryCell(ccx + r, ccz + k)
    }
  }

  return {
    id: req.id,
    centerX: cx,
    centerZ: cz,
    n,
    positions,
    normals,
    colors,
    uvs,
    trees: placed === req.trees ? trees : trees.slice(0, placed * 4),
  }
}

// Only wire up messaging when actually running as a worker (the module is also imported on
// the main thread for the synchronous fallback).
if (typeof window === "undefined" && typeof self !== "undefined") {
  const scope = self as unknown as Worker
  scope.onmessage = (e: MessageEvent<FarRequest>) => {
    const res = buildFarTerrain(e.data)
    scope.postMessage(res, [res.positions.buffer, res.normals.buffer, res.colors.buffer, res.uvs.buffer, res.trees.buffer])
  }
}
