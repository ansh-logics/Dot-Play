import * as THREE from "three"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"

/**
 * A procedural sports coupe, built entirely in code. It is an original design: a long
 * lofted body with a fastback greenhouse, slim LED strips and a full-width tail bar.
 * Smooth surfaces and good materials (clearcoated paint, tinted glass, metal rims) carry
 * the look more than detail does, in the spirit of Slow Roads' simple cars.
 *
 * Conventions the engine relies on: the car faces +z,
 * sits on y=0, and each wheel is a Group at its hub that spins about its local x axis.
 */

export interface Coupe {
  group: THREE.Group
  wheels: THREE.Object3D[]
  headlights: THREE.MeshStandardMaterial
  tail: THREE.MeshStandardMaterial
  beam: THREE.SpotLight
  paint: THREE.MeshPhysicalMaterial
  setColor(hex: string): void
  dispose(): void
}

export const CAR_COLORS: { id: string; label: string; hex: string }[] = [
  { id: "white", label: "White", hex: "#f2f2f0" },
  { id: "silver", label: "Silver", hex: "#b9bcc2" },
  { id: "graphite", label: "Graphite", hex: "#4a4d53" },
  { id: "black", label: "Black", hex: "#111214" },
  { id: "red", label: "Red", hex: "#c8141e" },
  { id: "sunset", label: "Sunset orange", hex: "#ff6a1f" },
  { id: "pink", label: "GTA pink", hex: "#ff3e9a" },
  { id: "teal", label: "Teal", hex: "#139e9b" },
  { id: "yellow", label: "Yellow", hex: "#f5c518" },
  { id: "blue", label: "Deep blue", hex: "#14316f" },
]

// ---- Dimensions ------------------------------------------------------------------------

const Z_NOSE = 2.25
const Z_TAIL = -2.25
const WHEEL_R = 0.34
const HALF_TRACK = 0.81
const AXLE_F = 1.33
const AXLE_R = -1.32
const AXLES = [AXLE_F, AXLE_R]
/** Wheel arch opening radius around the hub, plus a short slanted lip down to the sill. */
const ARCH_R = 0.375
const ARCH_LIP = 0.07
/** Superellipse exponents: a rounder upper half (shoulders, hood crown), squarer lower half. */
const N_TOP = 3
const N_BOT = 4
const N_GH = 4

// ---- Profile curves --------------------------------------------------------------------

type Key = readonly [number, number]

/** Smooth curve through (z, value) keys: cubic Hermite with finite-difference tangents. */
function curve(keys: Key[]): (z: number) => number {
  const n = keys.length
  return (z) => {
    if (z <= keys[0][0]) return keys[0][1]
    if (z >= keys[n - 1][0]) return keys[n - 1][1]
    let i = 0
    while (z > keys[i + 1][0]) i++
    const p0 = keys[Math.max(i - 1, 0)]
    const p1 = keys[i]
    const p2 = keys[i + 1]
    const p3 = keys[Math.min(i + 2, n - 1)]
    const dz = p2[0] - p1[0]
    const m1 = ((p2[1] - p0[1]) / (p2[0] - p0[0])) * dz
    const m2 = ((p3[1] - p1[1]) / (p3[0] - p1[0])) * dz
    const t = (z - p1[0]) / dz
    const t2 = t * t
    const t3 = t2 * t
    return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2
  }
}

/** Side profile: hood / deck line along the centre of the body (below the greenhouse). */
const TOP = curve([
  [-2.25, 0.88], [-2.12, 0.955], [-1.9, 0.975], [-1.2, 0.965], [-0.3, 0.95], [0.3, 0.93],
  [0.75, 0.905], [1.05, 0.875], [1.33, 0.845], [1.7, 0.78], [2.0, 0.69], [2.25, 0.6],
])
/** Side profile: underside / sill before the wheel arches are cut in. */
const BOT = curve([[-2.25, 0.4], [-2.05, 0.29], [-1.75, 0.22], [1.7, 0.2], [2.0, 0.25], [2.25, 0.36]])
/** Height of the widest line; a little lower at the nose gives a gentle wedge. */
const MID = curve([[-2.25, 0.64], [-1.5, 0.6], [0, 0.55], [1.5, 0.5], [2.25, 0.47]])
/** Plan view half-width: pinched waist, wider rear haunches, tapered nose. */
const WIDTH = curve([
  [-2.25, 0.86], [-1.95, 0.935], [-1.32, 0.955], [-0.6, 0.925], [0.3, 0.925], [1.33, 0.945], [1.9, 0.885], [2.25, 0.8],
])

/** Signed power, the core of the superellipse parametrisation. */
function spow(v: number, e: number) {
  return Math.sign(v) * Math.pow(Math.abs(v), e)
}

/** Rounds a loft end over the last r metres; p > 2 keeps the end face flatter than a dome. */
function roundEnd(e: number, r: number, p: number) {
  if (e <= 0) return 0
  if (e >= r) return 1
  return Math.pow(1 - Math.pow(1 - e / r, p), 1 / p)
}

interface Section {
  w: number
  top: number
  bot: number
  yc: number
  f: number
}

/** The body cross-section at z: superellipse bounds plus the end-rounding scale f. */
function section(z: number, s: Section): Section {
  const top = TOP(z)
  const base = BOT(z)
  let bot = base
  for (const a of AXLES) {
    const d = Math.abs(z - a)
    if (d < ARCH_R) bot = Math.max(bot, WHEEL_R + Math.sqrt(ARCH_R * ARCH_R - d * d))
    else if (d < ARCH_R + ARCH_LIP) bot = Math.max(bot, WHEEL_R - ((d - ARCH_R) / ARCH_LIP) * (WHEEL_R - base))
  }
  s.top = top
  s.bot = bot
  // Over the arches the section thins to a fender; keep the widest line between its bounds.
  s.yc = Math.min(Math.max(MID(z), bot + 0.07), top - 0.05)
  s.w = WIDTH(z)
  s.f = Math.min(roundEnd(Z_NOSE - z, 0.32, 2.3), roundEnd(z - Z_TAIL, 0.16, 3))
  return s
}

const tmpS: Section = { w: 0, top: 0, bot: 0, yc: 0, f: 0 }

/** Whether (x, y) lies inside the body section at z: the implicit form of the superellipse. */
function inside(x: number, y: number, z: number) {
  const s = section(z, tmpS)
  if (s.f <= 0) return false
  const dy = y - s.yc
  const up = dy >= 0
  const n = up ? N_TOP : N_BOT
  const h = (up ? s.top - s.yc : s.yc - s.bot) * s.f
  return Math.pow(Math.abs(x) / (s.w * s.f), n) + Math.pow(Math.abs(dy) / h, n) <= 1
}

/** Half-width of the body surface at height y and station z (0 when outside). */
function sideX(z: number, y: number) {
  const s = section(z, tmpS)
  const dy = y - s.yc
  const up = dy >= 0
  const n = up ? N_TOP : N_BOT
  const h = (up ? s.top - s.yc : s.yc - s.bot) * s.f
  const k = Math.abs(dy) / h
  if (k >= 1) return 0
  return s.w * s.f * Math.pow(1 - Math.pow(k, n), 1 / n)
}

/** z of the nose (end=1) or tail (end=-1) surface at (x, y), found by bisection. */
function endZ(x: number, y: number, end: 1 | -1) {
  const at = (e: number) => (end > 0 ? Z_NOSE - e : Z_TAIL + e)
  let lo = 0
  let hi = 0.9
  for (let k = 0; k < 26; k++) {
    const mid = (lo + hi) / 2
    if (inside(x, y, at(mid))) hi = mid
    else lo = mid
  }
  return at(hi)
}

// ---- Geometry builders -----------------------------------------------------------------

/** z stations along the body, dense where the shape turns quickly (ends and arches). */
function bodyStations(): number[] {
  const raw: number[] = []
  for (const e of [0.003, 0.01, 0.022, 0.04, 0.065, 0.095, 0.13]) raw.push(Z_TAIL + e)
  for (let z = Z_TAIL + 0.17; z < Z_NOSE - 0.3; ) {
    raw.push(z)
    const nearArch = AXLES.some((a) => Math.abs(z - a) < ARCH_R + ARCH_LIP + 0.03)
    z += nearArch ? 0.035 : 0.085
  }
  // Exact stations at the arch edges keep the openings crisp.
  for (const a of AXLES) for (const d of [-ARCH_R - ARCH_LIP, -ARCH_R, ARCH_R, ARCH_R + ARCH_LIP]) raw.push(a + d)
  for (const e of [0.3, 0.24, 0.185, 0.135, 0.095, 0.06, 0.033, 0.015, 0.004]) raw.push(Z_NOSE - e)
  raw.sort((a, b) => a - b)
  const out: number[] = []
  for (const z of raw) if (!out.length || z - out[out.length - 1] > 0.008) out.push(z)
  return out
}

/**
 * The main body: superellipse rings lofted along z, wrapped around (no seam, so normals are
 * smooth everywhere) and closed with a single pole vertex at each end.
 */
function bodyGeometry(): THREE.BufferGeometry {
  const zs = bodyStations()
  const V = 28
  const R = zs.length
  const pos = new Float32Array((R * V + 2) * 3)
  const s: Section = { w: 0, top: 0, bot: 0, yc: 0, f: 0 }
  for (let i = 0; i < R; i++) {
    section(zs[i], s)
    for (let j = 0; j < V; j++) {
      const th = (j / V) * Math.PI * 2
      const c = Math.cos(th)
      const sn = Math.sin(th)
      const up = sn >= 0
      const n = up ? N_TOP : N_BOT
      const h = up ? s.top - s.yc : s.yc - s.bot
      const o = (i * V + j) * 3
      pos[o] = s.w * s.f * spow(c, 2 / n)
      pos[o + 1] = s.yc + h * s.f * spow(sn, 2 / n)
      pos[o + 2] = zs[i]
    }
  }
  const tailPole = R * V
  const nosePole = R * V + 1
  pos.set([0, section(Z_TAIL, s).yc, Z_TAIL], tailPole * 3)
  pos.set([0, section(Z_NOSE, s).yc, Z_NOSE], nosePole * 3)

  const idx: number[] = []
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < V; j++) {
      const j1 = (j + 1) % V
      const a = i * V + j
      const c = i * V + j1
      const b = (i + 1) * V + j
      const d = (i + 1) * V + j1
      idx.push(a, c, b, c, d, b)
    }
  }
  const last = (R - 1) * V
  for (let j = 0; j < V; j++) {
    const j1 = (j + 1) % V
    idx.push(tailPole, j1, j)
    idx.push(nosePole, last + j, last + j1)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

// Greenhouse: raked windscreen from the cowl, a short roof, then a long fastback.
const G_REAR = -1.86
const G_FRONT = 0.74
const ROOF_R = -0.72
const ROOF_F = 0.02
const GH_WB = curve([[-1.86, 0.7], [-1.2, 0.82], [-0.5, 0.845], [0.2, 0.84], [0.74, 0.74]])
const GH_WT = curve([[-1.86, 0.5], [-1.2, 0.57], [-0.5, 0.6], [0.02, 0.6], [0.4, 0.68], [0.74, 0.72]])

function roofPeak(z: number) {
  const k = (z + 0.32) / 0.4
  return 1.25 - 0.045 * k * k
}

/** Greenhouse top line; both ends dip just under the body so the cabin grows out of it. */
function roofY(z: number) {
  if (z > ROOF_F) {
    const p = (z - ROOF_F) / (G_FRONT - ROOF_F)
    return THREE.MathUtils.lerp(roofPeak(ROOF_F), TOP(G_FRONT) - 0.015, Math.pow(p, 1.08))
  }
  if (z < ROOF_R) {
    const p = (ROOF_R - z) / (ROOF_R - G_REAR)
    // Starts at the roof's own slope and steepens slightly toward the deck.
    return THREE.MathUtils.lerp(roofPeak(ROOF_R), TOP(G_REAR) - 0.015, p * (0.8 + 0.2 * p))
  }
  return roofPeak(z)
}

/** Material slots on the greenhouse mesh. */
const PAINT = 0
const GLASS = 1
const TRIM = 2

/**
 * The cabin: an open upper superellipse lofted from the deck to the cowl, its lower edge
 * buried in the body. Bands of columns become belt trim, side glass, roof rail and the
 * centre (windscreen / roof / rear window); z ranges then pick paint, glass or black trim.
 */
function greenhouseGeometry(): THREE.BufferGeometry {
  const zs: number[] = []
  const seg = (a: number, b: number, n: number, withEnd: boolean) => {
    for (let k = 0; k < n + (withEnd ? 1 : 0); k++) zs.push(a + ((b - a) * k) / n)
  }
  seg(G_REAR, ROOF_R, 14, false)
  seg(ROOF_R, ROOF_F, 8, false)
  seg(ROOF_F, G_FRONT, 10, true)

  // Column angles for the right half; q = sqrt(sin t) is the height fraction, so t = asin(q^2).
  const tq = (q: number) => Math.asin(q * q)
  const right = [0, tq(0.12), tq(0.24), tq(0.4), tq(0.55), tq(0.7), tq(0.82), tq(0.92), 1.09, 1.2, 1.32, 1.45, Math.PI / 2]
  const ts = right.slice()
  for (let k = right.length - 2; k >= 0; k--) ts.push(Math.PI - right[k])
  const half = right.length - 1
  const band = (segIdx: number) => {
    const k = segIdx < half ? segIdx : 2 * half - 1 - segIdx
    return k < 2 ? "belt" : k < 7 ? "side" : k === 7 ? "rail" : "centre"
  }

  const C = ts.length
  const pos = new Float32Array(zs.length * C * 3)
  for (let i = 0; i < zs.length; i++) {
    const z = zs[i]
    const yb = TOP(z) - 0.2
    const h = roofY(z) - yb
    const wb = GH_WB(z)
    const wt = GH_WT(z)
    for (let j = 0; j < C; j++) {
      const c = Math.cos(ts[j])
      const q = Math.sqrt(Math.max(0, Math.sin(ts[j])))
      const o = (i * C + j) * 3
      pos[o] = THREE.MathUtils.lerp(wb, wt, q) * spow(c, 2 / N_GH)
      pos[o + 1] = yb + h * q
      pos[o + 2] = z
    }
  }

  const slots: number[][] = [[], [], []]
  for (let i = 0; i < zs.length - 1; i++) {
    const zm = (zs[i] + zs[i + 1]) / 2
    const zone = zm > ROOF_F ? "screen" : zm < ROOF_R ? "back" : "roof"
    for (let j = 0; j < C - 1; j++) {
      const b = band(j)
      let m = PAINT
      if (b === "belt") m = TRIM
      else if (b === "side") m = zone === "back" ? PAINT : GLASS
      else if (b === "rail") m = zone === "screen" ? TRIM : PAINT
      else m = zone === "roof" ? PAINT : GLASS
      const a = i * C + j
      const cc = i * C + j + 1
      const bb = (i + 1) * C + j
      const d = (i + 1) * C + j + 1
      slots[m].push(a, cc, bb, cc, d, bb)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
  const idx: number[] = []
  for (let m = 0; m < 3; m++) {
    g.addGroup(idx.length, slots[m].length, m)
    for (const v of slots[m]) idx.push(v)
  }
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

const tmpA = new THREE.Vector3()
const tmpB = new THREE.Vector3()
const tmpN = new THREE.Vector3()

/**
 * An indexed grid surface from a point function. Winding is fixed up afterwards so faces
 * point along `outward`, which keeps every decal builder free of winding bookkeeping.
 */
function grid(cols: number, rows: number, at: (i: number, j: number, out: THREE.Vector3) => void, outward: THREE.Vector3) {
  const pos = new Float32Array(cols * rows * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      at(i, j, v)
      v.toArray(pos, (i * rows + j) * 3)
    }
  }
  const idx: number[] = []
  for (let i = 0; i < cols - 1; i++) {
    for (let j = 0; j < rows - 1; j++) {
      const a = i * rows + j
      const b = (i + 1) * rows + j
      const c = i * rows + j + 1
      const d = (i + 1) * rows + j + 1
      idx.push(a, b, c, b, d, c)
    }
  }
  const sum = new THREE.Vector3()
  for (let k = 0; k < idx.length; k += 3) {
    v.fromArray(pos, idx[k] * 3)
    tmpA.fromArray(pos, idx[k + 1] * 3).sub(v)
    tmpB.fromArray(pos, idx[k + 2] * 3).sub(v)
    sum.add(tmpN.crossVectors(tmpA, tmpB))
  }
  if (sum.dot(outward) < 0) {
    for (let k = 0; k < idx.length; k += 3) {
      const t = idx[k + 1]
      idx[k + 1] = idx[k + 2]
      idx[k + 2] = t
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

const FORWARD = new THREE.Vector3(0, 0, 1)
const BACKWARD = new THREE.Vector3(0, 0, -1)

/**
 * A strip shrink-wrapped onto the nose or tail: for each x it finds the end surface at the
 * given heights and floats a few millimetres proud of it, so lights follow the body's curve.
 */
function endRibbon(end: 1 | -1, x0: number, x1: number, cols: number, ys: (x: number) => number[], off: number) {
  const rows = ys(x0).length
  return grid(
    cols,
    rows,
    (i, j, out) => {
      const x = THREE.MathUtils.lerp(x0, x1, i / (cols - 1))
      const y = ys(x)[j]
      out.set(x, y, endZ(x, y, end) + end * off)
    },
    end > 0 ? FORWARD : BACKWARD,
  )
}

/** Merges geometries (normalising index state) and frees the inputs. */
function merged(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const anyIndexed = geos.some((g) => g.index)
  const allIndexed = geos.every((g) => g.index)
  const parts = anyIndexed && !allIndexed ? geos.map((g) => (g.index ? g.toNonIndexed() : g)) : geos
  const out = mergeGeometries(parts)
  for (const g of geos) g.dispose()
  for (const g of parts) g.dispose()
  return out
}

// ---- Wheels ----------------------------------------------------------------------------

/** Tyre: a lathed superellipse section, bulging sidewalls that curl in to the bead. */
function tyreGeometry() {
  const pts: THREE.Vector2[] = []
  const rc = 0.282
  const rr = WHEEL_R - rc
  const aa = 0.122
  const n = 3.2
  const span = Math.PI / 2 + 0.6
  const N = 16
  for (let k = 0; k <= N; k++) {
    const phi = -span + (2 * span * k) / N
    pts.push(new THREE.Vector2(rc + rr * spow(Math.cos(phi), 2 / n), aa * spow(Math.sin(phi), 2 / n)))
  }
  // Lathe revolves about y; turn that onto x, the axle.
  return new THREE.LatheGeometry(pts, 36).rotateZ(-Math.PI / 2)
}

/** Rim face for a right-hand wheel (outer face +x): five dished spokes, hub and lip. */
function rimGeometry() {
  const shape = new THREE.Shape()
  shape.moveTo(-0.026, 0.055)
  shape.lineTo(0.026, 0.055)
  shape.lineTo(0.014, 0.214)
  shape.lineTo(-0.014, 0.214)
  shape.closePath()
  const spoke = new THREE.ExtrudeGeometry(shape, {
    depth: 0.022,
    bevelEnabled: true,
    bevelThickness: 0.007,
    bevelSize: 0.006,
    bevelSegments: 2,
    curveSegments: 1,
  })
  // Tilt the outer end outward (concave dish), then lay the face onto the x axle.
  spoke.rotateX(0.2).rotateY(Math.PI / 2).translate(0.035, 0, 0)
  const parts: THREE.BufferGeometry[] = []
  for (let k = 0; k < 5; k++) parts.push(spoke.clone().rotateX((k / 5) * Math.PI * 2))
  spoke.dispose()
  parts.push(new THREE.CylinderGeometry(0.072, 0.078, 0.05, 24).rotateZ(-Math.PI / 2).translate(0.06, 0, 0))
  parts.push(new THREE.TorusGeometry(0.228, 0.014, 8, 40).rotateY(Math.PI / 2).translate(0.104, 0, 0))
  return merged(parts)
}

// ---- Contact shadow ----------------------------------------------------------------------

/** Soft elongated blob for a ground contact shadow (taller than wide, like the car). */
export function contactShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas")
  c.width = 128
  c.height = 256
  const g = c.getContext("2d")!
  g.setTransform(1, 0, 0, 2, 0, 0)
  const grad = g.createRadialGradient(64, 64, 2, 64, 64, 64)
  grad.addColorStop(0, "rgba(0,0,0,0.7)")
  grad.addColorStop(0.5, "rgba(0,0,0,0.36)")
  grad.addColorStop(0.8, "rgba(0,0,0,0.1)")
  grad.addColorStop(1, "rgba(0,0,0,0)")
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(c)
}

// ---- Assembly ----------------------------------------------------------------------------

export function buildCoupe(color = "#f2f2f0"): Coupe {
  const group = new THREE.Group()

  const paint = new THREE.MeshPhysicalMaterial({ color, roughness: 0.36, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.14 })
  // Not a perfect mirror: on a flat window a perfect mirror reflects the moon/sun across the whole pane at once (a glowing rectangle).
  const glass = new THREE.MeshPhysicalMaterial({ color: "#0d1016", roughness: 0.16, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.18, specularIntensity: 0.6, envMapIntensity: 1.1 })
  const trim = new THREE.MeshStandardMaterial({ color: "#0a0b0d", roughness: 0.4, metalness: 0.2 })
  // Decals sit millimetres off the body; polygon offset keeps them from z-fighting at range.
  const decal = { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }
  const trimDecal = new THREE.MeshStandardMaterial({ color: "#0a0b0d", roughness: 0.35, metalness: 0.2, ...decal })
  const matte = new THREE.MeshStandardMaterial({ color: "#08090b", roughness: 0.85, ...decal })
  const headlights = new THREE.MeshStandardMaterial({ color: "#fff6e0", emissive: "#fff2cc", emissiveIntensity: 0.4, ...decal })
  const tail = new THREE.MeshStandardMaterial({ color: "#5a0710", emissive: "#ff1a3c", emissiveIntensity: 0.8, ...decal })
  const plate = new THREE.MeshStandardMaterial({ color: "#e2e2dc", roughness: 0.55, ...decal })
  const rubber = new THREE.MeshStandardMaterial({ color: "#121214", roughness: 0.92 })
  const rimMat = new THREE.MeshStandardMaterial({ color: "#b8bcc4", metalness: 1, roughness: 0.25 })
  const barrelMat = new THREE.MeshStandardMaterial({ color: "#2a2b2e", metalness: 0.6, roughness: 0.5, side: THREE.DoubleSide })
  const discMat = new THREE.MeshStandardMaterial({ color: "#6d6f73", metalness: 0.8, roughness: 0.45 })
  const caliperMat = new THREE.MeshStandardMaterial({ color: "#c2272d", roughness: 0.5 })
  const well = new THREE.MeshStandardMaterial({ color: "#0b0c0e", roughness: 0.95, side: THREE.DoubleSide })
  const chrome = new THREE.MeshStandardMaterial({ color: "#c0c4ca", metalness: 1, roughness: 0.2, side: THREE.DoubleSide })

  const shadowed = (m: THREE.Mesh) => {
    m.castShadow = true
    m.receiveShadow = false
    return m
  }

  group.add(shadowed(new THREE.Mesh(bodyGeometry(), paint)))
  group.add(shadowed(new THREE.Mesh(greenhouseGeometry(), [paint, glass, trim])))

  // Dark tub between the wheels and liners over them, so the arches read as deep wells
  // instead of showing the painted underside of the fenders.
  const tub = new THREE.Mesh(new THREE.BoxGeometry(1.34, 0.45, 3.7).translate(0, 0.475, 0), well)
  const liners: THREE.BufferGeometry[] = []
  const calipers: THREE.BufferGeometry[] = []
  for (const a of AXLES) {
    for (const sx of [-1, 1]) {
      liners.push(
        new THREE.CylinderGeometry(ARCH_R - 0.007, ARCH_R - 0.007, 0.25, 20, 1, true, 0, Math.PI)
          .rotateZ(Math.PI / 2)
          .translate(sx * 0.8, WHEEL_R, a),
      )
      // Calipers grip the disc behind the spokes; they stay put while the wheel spins.
      calipers.push(
        new THREE.BoxGeometry(0.07, 0.1, 0.13)
          .rotateX(-Math.atan2(0.1, 0.11))
          .translate(sx * (HALF_TRACK - 0.02), WHEEL_R + 0.11, a - 0.1),
      )
    }
  }
  group.add(tub, new THREE.Mesh(merged(liners), well), new THREE.Mesh(merged(calipers), caliperMat))

  // Lights and dark details, wrapped onto the nose and tail.
  const headlightTrim: THREE.BufferGeometry[] = []
  const headlightStrips: THREE.BufferGeometry[] = []
  for (const sx of [-1, 1]) {
    const lo = (x: number) => {
      const t = (Math.abs(x) - 0.36) / 0.44
      return 0.553 + 0.06 * t * t
    }
    const thick = (x: number) => 0.026 * (1 - 0.4 * ((Math.abs(x) - 0.36) / 0.44))
    headlightTrim.push(endRibbon(1, sx * 0.34, sx * 0.81, 14, (x) => [lo(x) - 0.016, lo(x) + thick(x) / 2, lo(x) + thick(x) + 0.01], 0.004))
    headlightStrips.push(endRibbon(1, sx * 0.36, sx * 0.8, 14, (x) => [lo(x), lo(x) + thick(x) / 2, lo(x) + thick(x)], 0.008))
  }
  group.add(new THREE.Mesh(merged(headlightStrips), headlights))

  const trimDecals = [
    ...headlightTrim,
    endRibbon(-1, -0.85, 0.85, 34, () => [0.748, 0.779, 0.81], 0.004),
    endRibbon(-1, -0.285, 0.285, 6, () => [0.52, 0.65], 0.005),
  ]
  group.add(new THREE.Mesh(merged(trimDecals), trimDecal))
  group.add(new THREE.Mesh(endRibbon(-1, -0.83, 0.83, 34, () => [0.768, 0.79], 0.008), tail))
  group.add(new THREE.Mesh(endRibbon(-1, -0.26, 0.26, 6, () => [0.535, 0.635], 0.009), plate))

  const matteDecals = [
    endRibbon(1, -0.6, 0.6, 20, () => [0.37, 0.415, 0.46], 0.005),
    endRibbon(-1, -0.62, 0.62, 20, () => [0.43, 0.465, 0.5], 0.005),
  ]
  // Side skirts: a thin blade along the sill between the arches.
  const z0 = AXLE_R + ARCH_R + ARCH_LIP + 0.02
  const z1 = AXLE_F - ARCH_R - ARCH_LIP - 0.02
  const lift = [0.03, 0.07, 0.115]
  const out = [0.008, 0.016, 0.004]
  for (const sx of [-1, 1]) {
    matteDecals.push(
      grid(
        16,
        3,
        (i, j, p) => {
          const z = THREE.MathUtils.lerp(z0, z1, i / 15)
          const y = BOT(z) + lift[j]
          p.set(sx * (sideX(z, y) + out[j]), y, z)
        },
        new THREE.Vector3(sx, 0, 0),
      ),
    )
  }
  group.add(new THREE.Mesh(merged(matteDecals), matte))

  // Exhaust tips poke out of the diffuser.
  const tubes: THREE.BufferGeometry[] = []
  const tubeEnds: THREE.BufferGeometry[] = []
  for (const sx of [-1, 1]) {
    const x = sx * 0.48
    const y = 0.465
    const zs = endZ(x, y, -1)
    tubes.push(new THREE.CylinderGeometry(0.042, 0.042, 0.13, 18, 1, true).rotateX(Math.PI / 2).translate(x, y, zs + 0.035))
    tubeEnds.push(new THREE.CircleGeometry(0.038, 18).rotateY(Math.PI).translate(x, y, zs - 0.015))
  }
  group.add(new THREE.Mesh(merged(tubes), chrome), new THREE.Mesh(merged(tubeEnds), trim))

  // Side mirrors on short stalks just behind the A-pillars.
  const housings: THREE.BufferGeometry[] = []
  const mirrorGlass: THREE.BufferGeometry[] = []
  const stalks: THREE.BufferGeometry[] = []
  for (const sx of [-1, 1]) {
    housings.push(new THREE.SphereGeometry(1, 16, 10).scale(0.1, 0.055, 0.075).translate(sx * 0.97, 0.905, 0.44))
    // Just behind the housing's rear pole (z 0.365): any further forward and the ellipsoid
    // swallows the middle of the glass, leaving only a ring visible from behind.
    mirrorGlass.push(new THREE.CircleGeometry(1, 18).scale(0.08, 0.042, 1).rotateY(Math.PI).translate(sx * 0.97, 0.905, 0.361))
    stalks.push(new THREE.BoxGeometry(0.22, 0.03, 0.05).rotateZ(sx * 0.32).translate(sx * 0.85, 0.865, 0.46))
  }
  const housingMesh = shadowed(new THREE.Mesh(merged(housings), paint))
  group.add(housingMesh, new THREE.Mesh(merged(mirrorGlass), glass), new THREE.Mesh(merged(stalks), trim))

  // Wheels: each a Group at its hub so rotation.x spins it cleanly; left faces are flipped
  // by an inner group so the spin axis stays the same for all four.
  const tyreGeo = tyreGeometry()
  const rimGeo = rimGeometry()
  const barrelGeo = new THREE.CylinderGeometry(0.228, 0.228, 0.2, 36, 1, true).rotateZ(-Math.PI / 2).translate(-0.005, 0, 0)
  const discGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.022, 32).rotateZ(-Math.PI / 2).translate(-0.02, 0, 0)
  const wheels: THREE.Object3D[] = []
  for (const [sx, z] of [[-1, AXLE_F], [1, AXLE_F], [-1, AXLE_R], [1, AXLE_R]]) {
    const wheel = new THREE.Group()
    wheel.position.set(sx * HALF_TRACK, WHEEL_R, z)
    const inner = new THREE.Group()
    if (sx < 0) inner.rotation.y = Math.PI
    inner.add(
      shadowed(new THREE.Mesh(tyreGeo, rubber)),
      shadowed(new THREE.Mesh(rimGeo, rimMat)),
      new THREE.Mesh(barrelGeo, barrelMat),
      new THREE.Mesh(discGeo, discMat),
    )
    wheel.add(inner)
    group.add(wheel)
    wheels.push(wheel)
  }

  const beam = new THREE.SpotLight("#fff1d6", 0, 95, 0.62, 0.55, 1.1)
  beam.position.set(0, 0.8, 2.4)
  beam.target.position.set(0, 0, 18)
  group.add(beam, beam.target)

  return {
    group,
    wheels,
    headlights,
    tail,
    beam,
    paint,
    setColor(hex: string) {
      paint.color.set(hex)
    },
    dispose() {
      const geos = new Set<THREE.BufferGeometry>()
      const mats = new Set<THREE.Material>()
      group.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return
        geos.add(o.geometry)
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m)
      })
      for (const g of geos) g.dispose()
      for (const m of mats) m.dispose()
    },
  }
}
