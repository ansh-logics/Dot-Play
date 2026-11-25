// Palm geometry and materials for endless coastal driving scenes.
// Real thin geometry is used instead of alpha-tested leaf cards to prevent
// depth sorting artifacts, maintain crisp silhouettes from 5m to 300m,
// and enable fast instancing under daylight sun and sky illumination.

import * as THREE from "three"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"

export type PalmSpecies = "coconut" | "royal" | "fan"
export const PALM_SPECIES: PalmSpecies[] = ["coconut", "royal", "fan"]

export interface PalmParts {
  trunk: THREE.BufferGeometry
  crown: THREE.BufferGeometry
  height: number
}

// Triangle budget per palm (target <= 2600 tris total):
// - coconut: trunk 480 tris (10 radial x 24 rings x 2)
//            crown ~1816 tris (14 fronds x 124 tris + ~4 coconuts x 20 tris)
//            total ~2296 tris
// - royal:   trunk 480 tris (10 radial x 24 rings x 2)
//            crown 1984 tris (16 fronds x 124 tris)
//            total 2464 tris
// - fan:     trunk 480 tris (10 radial x 24 rings x 2)
//            crown 672 tris (18 fan leaves x 30 tris + 22 skirt strips x 6 tris)
//            total 1152 tris

// Mulberry32 seeded 32-bit PRNG for deterministic, reproducible palm variation.
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Evaluates the trunk center line position at height y (in meters).
function trunkCenter(
  species: PalmSpecies,
  y: number,
  _height: number,
  sideways: number,
  seed: number
): [number, number, number] {
  if (species === "coconut") {
    // Curved lean: center x = 0.018 * y^2 with subtle random sideways drift
    return [0.018 * y * y, y, sideways * y * y]
  }
  if (species === "fan") {
    // Very slim straight trunk with gentle organic wobble
    return [0.03 * Math.sin(y * 0.4 + seed), y, 0.03 * Math.cos(y * 0.35 + seed)]
  }
  // Royal palm grows straight upright
  return [0, y, 0]
}

// Evaluates the trunk radius and RGB tint at height y.
function trunkProfile(
  species: PalmSpecies,
  y: number,
  height: number
): { radius: number; color: [number, number, number] } {
  const t = Math.min(Math.max(y / height, 0), 1)

  if (species === "coconut") {
    // Tapers 0.20m base -> 0.13m top with annular ring bulges every ~0.3m (2*PI/21 ~= 0.3m)
    const baseR = 0.20 - 0.07 * t
    const bulge = 1 + 0.04 * Math.max(0, Math.sin(y * 21))
    return {
      radius: baseR * bulge,
      color: [0.55, 0.47, 0.38]
    }
  }

  if (species === "royal") {
    // Royal palm: swollen bottom up to 1m (0.28m -> 0.34m), 0.20m mid,
    // top 1.6m is the vibrant green crownshaft (radius 0.22m).
    const crownshaftY = height - 1.6
    if (y >= crownshaftY) {
      return {
        radius: 0.22,
        color: [0.33, 0.48, 0.24]
      }
    }
    let radius: number
    if (y <= 1.0) {
      radius = 0.28 + 0.06 * Math.sin((y / 1.0) * Math.PI * 0.5)
    } else {
      const s = (y - 1.0) / (crownshaftY - 1.0)
      radius = (0.34 * (1 - s) + 0.22 * s) - 0.28 * s * (1 - s)
    }
    return {
      radius,
      color: [0.72, 0.71, 0.68]
    }
  }

  // Fan palm: slim 0.17m base tapering to 0.12m with slight surface irregularities
  const baseR = 0.17 - 0.05 * t
  const irregular = 1 + 0.02 * Math.sin(y * 7.3) + 0.015 * Math.cos(y * 13.1)
  return {
    radius: baseR * irregular,
    color: [0.46, 0.40, 0.33]
  }
}

// Blends geometric face normal 60% towards world up (0,1,0) to simulate
// volumetric translucent foliage lighting under sun/sky without dark edge-on shading.
function foliageNormal(
  p0: [number, number, number],
  p1: [number, number, number],
  p2: [number, number, number]
): [number, number, number] {
  const ax = p1[0] - p0[0]
  const ay = p1[1] - p0[1]
  const az = p1[2] - p0[2]
  const bx = p2[0] - p0[0]
  const by = p2[1] - p0[1]
  const bz = p2[2] - p0[2]

  let gx = ay * bz - az * by
  let gy = az * bx - ax * bz
  let gz = ax * by - ay * bx
  const glen = Math.hypot(gx, gy, gz) || 1
  gx /= glen
  gy /= glen
  gz /= glen

  // Flip if pointing downwards so the top-facing leaflet surface catches sky light
  if (gy < 0) {
    gx = -gx
    gy = -gy
    gz = -gz
  }

  // 40% geometric normal + 60% world up
  let nx = gx * 0.4
  let ny = gy * 0.4 + 0.6
  let nz = gz * 0.4
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

// Appends a quad as 2 non-indexed triangles with foliage normals and vertex colors.
function pushCrownQuad(
  positions: number[],
  normals: number[],
  colors: number[],
  v0: [number, number, number],
  v1: [number, number, number],
  v2: [number, number, number],
  v3: [number, number, number],
  c0: [number, number, number],
  c1: [number, number, number],
  c2: [number, number, number],
  c3: [number, number, number]
) {
  const norm = foliageNormal(v0, v1, v2)

  // Triangle 1: v0, v1, v2
  positions.push(
    v0[0], v0[1], v0[2],
    v1[0], v1[1], v1[2],
    v2[0], v2[1], v2[2]
  )
  normals.push(
    norm[0], norm[1], norm[2],
    norm[0], norm[1], norm[2],
    norm[0], norm[1], norm[2]
  )
  colors.push(
    c0[0], c0[1], c0[2],
    c1[0], c1[1], c1[2],
    c2[0], c2[1], c2[2]
  )

  // Triangle 2: v0, v2, v3
  positions.push(
    v0[0], v0[1], v0[2],
    v2[0], v2[1], v2[2],
    v3[0], v3[1], v3[2]
  )
  normals.push(
    norm[0], norm[1], norm[2],
    norm[0], norm[1], norm[2],
    norm[0], norm[1], norm[2]
  )
  colors.push(
    c0[0], c0[1], c0[2],
    c2[0], c2[1], c2[2],
    c3[0], c3[1], c3[2]
  )
}

// Generates a single pinnate frond (rachis stem + 26 pairs of tapered leaflets).
function buildPinnateFrond(
  crownTop: [number, number, number],
  azimuth: number,
  elevation: number,
  length: number,
  droop: number,
  isDying: boolean,
  brightness: number
): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []

  const dirH: [number, number, number] = [Math.cos(azimuth), 0, Math.sin(azimuth)]
  const sideH: [number, number, number] = [-Math.sin(azimuth), 0, Math.cos(azimuth)]
  const cosE = Math.cos(elevation)
  const sinE = Math.sin(elevation)

  // Evaluates position along the rachis curve point(t)
  const rachisPoint = (t: number): [number, number, number] => [
    crownTop[0] + dirH[0] * length * t * cosE,
    crownTop[1] + length * t * sinE - droop * length * t * t,
    crownTop[2] + dirH[2] * length * t * cosE
  ]

  // Evaluates rachis tangent d(point)/dt
  const rachisTangent = (t: number): [number, number, number] => {
    const tx = dirH[0] * length * cosE
    const ty = length * sinE - 2 * droop * length * t
    const tz = dirH[2] * length * cosE
    const len = Math.hypot(tx, ty, tz) || 1
    return [tx / len, ty / len, tz / len]
  }

  // 1. Rachis stem ribbon (10 segments = 20 triangles)
  const stemBaseCol: [number, number, number] = isDying
    ? [0.48, 0.42, 0.22]
    : [0.45 * brightness, 0.50 * brightness, 0.25 * brightness]
  const stemSegments = 10
  for (let s = 0; s < stemSegments; s++) {
    const t0 = s / stemSegments
    const t1 = (s + 1) / stemSegments
    const p0 = rachisPoint(t0)
    const p1 = rachisPoint(t1)
    const w0 = (0.05 * (1 - t0) + 0.01 * t0) * 0.5
    const w1 = (0.05 * (1 - t1) + 0.01 * t1) * 0.5

    const v0: [number, number, number] = [p0[0] - sideH[0] * w0, p0[1], p0[2] - sideH[2] * w0]
    const v1: [number, number, number] = [p0[0] + sideH[0] * w0, p0[1], p0[2] + sideH[2] * w0]
    const v2: [number, number, number] = [p1[0] + sideH[0] * w1, p1[1], p1[2] + sideH[2] * w1]
    const v3: [number, number, number] = [p1[0] - sideH[0] * w1, p1[1], p1[2] - sideH[2] * w1]

    pushCrownQuad(positions, normals, colors, v0, v1, v2, v3, stemBaseCol, stemBaseCol, stemBaseCol, stemBaseCol)
  }

  // 2. Leaflets: 26 pairs along t in [0.08, 0.97]
  const leafBaseCol: [number, number, number] = isDying
    ? [0.52, 0.40, 0.20]
    : [0.20 * brightness, 0.34 * brightness, 0.11 * brightness]
  const leafTipCol: [number, number, number] = isDying
    ? [0.58, 0.45, 0.24]
    : [0.42 * brightness, 0.47 * brightness, 0.20 * brightness]

  const rad35 = 35 * (Math.PI / 180)
  const rad25 = 25 * (Math.PI / 180)
  const cos35 = Math.cos(rad35)
  const sin35 = Math.sin(rad35)
  const cos25 = Math.cos(rad25)
  const sin25 = Math.sin(rad25)

  for (let pair = 0; pair < 26; pair++) {
    const t = 0.08 + (pair / 25) * (0.97 - 0.08)
    const leafLen = 0.95 * Math.pow(Math.sin(Math.PI * t), 0.7) + 0.15
    const pt = rachisPoint(t)
    const tang = rachisTangent(t)

    // Left (sideSign = -1) and Right (sideSign = +1) mirrored leaflets
    for (const sideSign of [-1, 1]) {
      const sX = sideH[0] * sideSign
      const sZ = sideH[2] * sideSign

      // Angled 35 deg forward along stem, raised 25 deg up for V-fold
      const dirX = (sX * cos35 + tang[0] * sin35) * cos25
      const dirY = tang[1] * sin35 * cos25 + sin25
      const dirZ = (sZ * cos35 + tang[2] * sin35) * cos25
      const dLen = Math.hypot(dirX, dirY, dirZ) || 1
      const nx = dirX / dLen
      const ny = dirY / dLen
      const nz = dirZ / dLen

      // Leaflet tips droop by 0.25 * length
      const tipCenter: [number, number, number] = [
        pt[0] + nx * leafLen,
        pt[1] + ny * leafLen - 0.25 * leafLen,
        pt[2] + nz * leafLen
      ]

      // Tapered quad: base width 0.07m, tip width 0.01m along tangent
      const bw = 0.07 * 0.5
      const tw = 0.01 * 0.5

      const v0: [number, number, number] = [pt[0] - tang[0] * bw, pt[1] - tang[1] * bw, pt[2] - tang[2] * bw]
      const v1: [number, number, number] = [pt[0] + tang[0] * bw, pt[1] + tang[1] * bw, pt[2] + tang[2] * bw]
      const v2: [number, number, number] = [tipCenter[0] + tang[0] * tw, tipCenter[1] + tang[1] * tw, tipCenter[2] + tang[2] * tw]
      const v3: [number, number, number] = [tipCenter[0] - tang[0] * tw, tipCenter[1] - tang[1] * tw, tipCenter[2] - tang[2] * tw]

      pushCrownQuad(positions, normals, colors, v0, v1, v2, v3, leafBaseCol, leafBaseCol, leafTipCol, leafTipCol)
    }
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3))
  return geom
}

// Generates 3-6 low-poly coconuts clustered just below the coconut palm crown.
function buildCoconuts(
  crownTop: [number, number, number],
  rand: () => number
): THREE.BufferGeometry[] {
  const count = 3 + Math.floor(rand() * 4) // 3 to 6 coconuts
  const coconuts: THREE.BufferGeometry[] = []

  for (let i = 0; i < count; i++) {
    const ico = new THREE.IcosahedronGeometry(0.11, 0).toNonIndexed()
    ico.deleteAttribute("uv")

    const vCount = ico.getAttribute("position").count
    const colors = new Float32Array(vCount * 3)
    const isGreen = rand() > 0.5
    const r = isGreen ? 0.32 : 0.45
    const g = isGreen ? 0.36 : 0.33
    const b = isGreen ? 0.14 : 0.15

    for (let c = 0; c < vCount; c++) {
      colors[c * 3] = r
      colors[c * 3 + 1] = g
      colors[c * 3 + 2] = b
    }
    ico.setAttribute("color", new THREE.BufferAttribute(colors, 3))

    const angle = (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.5
    const dist = 0.16 + rand() * 0.08
    const cx = crownTop[0] + Math.cos(angle) * dist
    const cy = crownTop[1] - 0.15 - rand() * 0.12
    const cz = crownTop[2] + Math.sin(angle) * dist
    ico.translate(cx, cy, cz)

    coconuts.push(ico)
  }

  return coconuts
}

// Generates a single palmate fan leaf (petiole stem + 14 radiating pleated segments).
function buildFanLeaf(
  crownTop: [number, number, number],
  azimuth: number,
  elevation: number,
  tilt: number,
  brightness: number
): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []

  const dirH: [number, number, number] = [Math.cos(azimuth), 0, Math.sin(azimuth)]
  const sideH: [number, number, number] = [-Math.sin(azimuth), 0, Math.cos(azimuth)]

  // 1. Petiole stem: 1.2m long thin strip
  const stemLen = 1.2
  const cosE = Math.cos(elevation)
  const sinE = Math.sin(elevation)
  const stemEnd: [number, number, number] = [
    crownTop[0] + dirH[0] * stemLen * cosE,
    crownTop[1] + stemLen * sinE,
    crownTop[2] + dirH[2] * stemLen * cosE
  ]

  const stemCol: [number, number, number] = [0.40 * brightness, 0.42 * brightness, 0.25 * brightness]
  const sw0 = 0.04 * 0.5
  const sw1 = 0.02 * 0.5

  const sv0: [number, number, number] = [crownTop[0] - sideH[0] * sw0, crownTop[1], crownTop[2] - sideH[2] * sw0]
  const sv1: [number, number, number] = [crownTop[0] + sideH[0] * sw0, crownTop[1], crownTop[2] + sideH[0] * sw0]
  const sv2: [number, number, number] = [stemEnd[0] + sideH[0] * sw1, stemEnd[1], stemEnd[2] + sideH[0] * sw1]
  const sv3: [number, number, number] = [stemEnd[0] - sideH[0] * sw1, stemEnd[1], stemEnd[2] - sideH[0] * sw1]
  pushCrownQuad(positions, normals, colors, sv0, sv1, sv2, sv3, stemCol, stemCol, stemCol, stemCol)

  // 2. Palmate fan: 14 narrow pleated segments radiating from stemEnd
  // Fan plane tilted outward and down by tilt (20-40 deg)
  const cosT = Math.cos(-tilt)
  const sinT = Math.sin(-tilt)
  const fanFwd: [number, number, number] = [dirH[0] * cosT, sinT, dirH[2] * cosT]
  const fanSide: [number, number, number] = [sideH[0], sideH[1], sideH[2]]

  // Fan plane normal: fanSide x fanFwd
  const fnX = fanSide[1] * fanFwd[2] - fanSide[2] * fanFwd[1]
  const fnY = fanSide[2] * fanFwd[0] - fanSide[0] * fanFwd[2]
  const fnZ = fanSide[0] * fanFwd[1] - fanSide[1] * fanFwd[0]
  const fnLen = Math.hypot(fnX, fnY, fnZ) || 1
  const fanNormal: [number, number, number] = [fnX / fnLen, fnY / fnLen, fnZ / fnLen]

  const fanBaseCol: [number, number, number] = [0.27 * brightness, 0.40 * brightness, 0.16 * brightness]
  const fanTipCol: [number, number, number] = [0.48 * brightness, 0.52 * brightness, 0.26 * brightness]

  const segCount = 14
  const pleatRad = 8 * (Math.PI / 180)
  for (let s = 0; s < segCount; s++) {
    const segAngle = -Math.PI * 0.42 + (s / (segCount - 1)) * (Math.PI * 0.84)
    const cosA = Math.cos(segAngle)
    const sinA = Math.sin(segAngle)

    const inPlaneX = fanFwd[0] * cosA + fanSide[0] * sinA
    const inPlaneY = fanFwd[1] * cosA + fanSide[1] * sinA
    const inPlaneZ = fanFwd[2] * cosA + fanSide[2] * sinA

    // Alternating up/down pleat (+-8 deg) prevents planar edge-on culling
    const pleat = (s % 2 === 0 ? 1 : -1) * pleatRad
    const cosP = Math.cos(pleat)
    const sinP = Math.sin(pleat)

    const pDirX = inPlaneX * cosP + fanNormal[0] * sinP
    const pDirY = inPlaneY * cosP + fanNormal[1] * sinP
    const pDirZ = inPlaneZ * cosP + fanNormal[2] * sinP
    const pLen = Math.hypot(pDirX, pDirY, pDirZ) || 1
    const dir: [number, number, number] = [pDirX / pLen, pDirY / pLen, pDirZ / pLen]

    const latX = fanSide[0] * cosA - fanFwd[0] * sinA
    const latY = fanSide[1] * cosA - fanFwd[1] * sinA
    const latZ = fanSide[2] * cosA - fanFwd[2] * sinA

    const tipCenter: [number, number, number] = [
      stemEnd[0] + dir[0] * 1.1,
      stemEnd[1] + dir[1] * 1.1,
      stemEnd[2] + dir[2] * 1.1
    ]

    const bw = 0.01
    const tw = 0.03

    const v0: [number, number, number] = [stemEnd[0] - latX * bw, stemEnd[1] - latY * bw, stemEnd[2] - latZ * bw]
    const v1: [number, number, number] = [stemEnd[0] + latX * bw, stemEnd[1] + latY * bw, stemEnd[2] + latZ * bw]
    const v2: [number, number, number] = [tipCenter[0] + latX * tw, tipCenter[1] + latY * tw, tipCenter[2] + latZ * tw]
    const v3: [number, number, number] = [tipCenter[0] - latX * tw, tipCenter[1] - latY * tw, tipCenter[2] - latZ * tw]

    pushCrownQuad(positions, normals, colors, v0, v1, v2, v3, fanBaseCol, fanBaseCol, fanTipCol, fanTipCol)
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3))
  return geom
}

// Builds the shaggy skirt of 22 dead hanging fronds for the fan palm.
function buildFanSkirt(
  crownTop: [number, number, number],
  trunkRadius: number,
  rand: () => number
): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []

  const skirtCount = 22
  const attachY = crownTop[1] - 0.25

  for (let i = 0; i < skirtCount; i++) {
    const angle = (i / skirtCount) * Math.PI * 2 + (rand() - 0.5) * 0.15
    const len = 1.8 + rand() * 1.2
    const b = 0.85 + rand() * 0.3
    const col: [number, number, number] = [0.48 * b, 0.38 * b, 0.24 * b]

    const cosA = Math.cos(angle)
    const sinA = Math.sin(angle)
    const sideX = -sinA
    const sideZ = cosA

    // Flared outward at top, hanging tight to the trunk at bottom
    const steps = [
      { t: 0.0, rad: trunkRadius + 0.18, w: 0.06 },
      { t: 0.33, rad: trunkRadius + 0.20, w: 0.055 },
      { t: 0.66, rad: trunkRadius + 0.11, w: 0.045 },
      { t: 1.0, rad: trunkRadius + 0.04, w: 0.03 }
    ]

    for (let s = 0; s < 3; s++) {
      const s0 = steps[s]
      const s1 = steps[s + 1]

      const y0 = attachY - s0.t * len
      const y1 = attachY - s1.t * len

      const c0x = crownTop[0] + cosA * s0.rad
      const c0z = crownTop[2] + sinA * s0.rad
      const c1x = crownTop[0] + cosA * s1.rad
      const c1z = crownTop[2] + sinA * s1.rad

      const v0: [number, number, number] = [c0x - sideX * s0.w, y0, c0z - sideZ * s0.w]
      const v1: [number, number, number] = [c0x + sideX * s0.w, y0, c0z + sideZ * s0.w]
      const v2: [number, number, number] = [c1x + sideX * s1.w, y1, c1z + sideZ * s1.w]
      const v3: [number, number, number] = [c1x - sideX * s1.w, y1, c1z - sideZ * s1.w]

      pushCrownQuad(positions, normals, colors, v0, v1, v2, v3, col, col, col, col)
    }
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3))
  return geom
}

export function palmGeometry(species: PalmSpecies, seed: number): PalmParts {
  const rand = rng(seed)

  // 1. Determine tree height from seed
  let height: number
  if (species === "coconut") {
    height = 8 + rand() * 3 // 8-11 m
  } else if (species === "royal") {
    height = 10 + rand() * 4 // 10-14 m
  } else {
    height = 11 + rand() * 5 // 11-16 m
  }

  const sideways = (rand() - 0.5) * 0.006

  // 2. Build trunk tube (10 radial segments, 24 rings -> 480 triangles)
  const trunkRings = 24
  const radialSegments = 10
  const trunkPositions: number[] = []
  const trunkNormals: number[] = []
  const trunkUvs: number[] = []
  const trunkColors: number[] = []

  const rings: Array<Array<{
    pos: [number, number, number]
    norm: [number, number, number]
    uv: [number, number]
    col: [number, number, number]
  }>> = []

  for (let r = 0; r <= trunkRings; r++) {
    const y = (r / trunkRings) * height
    const center = trunkCenter(species, y, height, sideways, seed)
    const { radius, color } = trunkProfile(species, y, height)

    // Evaluate tangent along trunk curve for tube cross-section orientation
    const yNext = Math.min(height, y + 0.05)
    const yPrev = Math.max(0, y - 0.05)
    const cNext = trunkCenter(species, yNext, height, sideways, seed)
    const cPrev = trunkCenter(species, yPrev, height, sideways, seed)
    const tx = cNext[0] - cPrev[0]
    const ty = cNext[1] - cPrev[1]
    const tz = cNext[2] - cPrev[2]
    const tLen = Math.hypot(tx, ty, tz) || 1
    const tang: [number, number, number] = [tx / tLen, ty / tLen, tz / tLen]

    const up: [number, number, number] = Math.abs(tang[2]) > 0.95 ? [1, 0, 0] : [0, 0, 1]
    const ux = up[1] * tang[2] - up[2] * tang[1]
    const uy = up[2] * tang[0] - up[0] * tang[2]
    const uz = up[0] * tang[1] - up[1] * tang[0]
    const uLen = Math.hypot(ux, uy, uz) || 1
    const u: [number, number, number] = [ux / uLen, uy / uLen, uz / uLen]

    const vx = tang[1] * u[2] - tang[2] * u[1]
    const vy = tang[2] * u[0] - tang[0] * u[2]
    const vz = tang[0] * u[1] - tang[1] * u[0]

    const ringVerts: Array<{
      pos: [number, number, number]
      norm: [number, number, number]
      uv: [number, number]
      col: [number, number, number]
    }> = []

    for (let j = 0; j <= radialSegments; j++) {
      const theta = (j / radialSegments) * Math.PI * 2
      const cosTh = Math.cos(theta)
      const sinTh = Math.sin(theta)

      const rx = u[0] * cosTh + vx * sinTh
      const ry = u[1] * cosTh + vy * sinTh
      const rz = u[2] * cosTh + vz * sinTh
      const rLen = Math.hypot(rx, ry, rz) || 1
      const norm: [number, number, number] = [rx / rLen, ry / rLen, rz / rLen]

      const pos: [number, number, number] = [
        center[0] + norm[0] * radius,
        center[1] + norm[1] * radius,
        center[2] + norm[2] * radius
      ]

      // uv.x wraps around (0..1), uv.y repeats bark texture every 1.2m
      const uv: [number, number] = [j / radialSegments, y / 1.2]

      ringVerts.push({ pos, norm, uv, col: color })
    }
    rings.push(ringVerts)
  }

  for (let r = 0; r < trunkRings; r++) {
    for (let j = 0; j < radialSegments; j++) {
      const v00 = rings[r][j]
      const v10 = rings[r + 1][j]
      const v11 = rings[r + 1][j + 1]
      const v01 = rings[r][j + 1]

      // Triangle 1: v00, v10, v11
      trunkPositions.push(
        v00.pos[0], v00.pos[1], v00.pos[2],
        v10.pos[0], v10.pos[1], v10.pos[2],
        v11.pos[0], v11.pos[1], v11.pos[2]
      )
      trunkNormals.push(
        v00.norm[0], v00.norm[1], v00.norm[2],
        v10.norm[0], v10.norm[1], v10.norm[2],
        v11.norm[0], v11.norm[1], v11.norm[2]
      )
      trunkUvs.push(
        v00.uv[0], v00.uv[1],
        v10.uv[0], v10.uv[1],
        v11.uv[0], v11.uv[1]
      )
      trunkColors.push(
        v00.col[0], v00.col[1], v00.col[2],
        v10.col[0], v10.col[1], v10.col[2],
        v11.col[0], v11.col[1], v11.col[2]
      )

      // Triangle 2: v00, v11, v01
      trunkPositions.push(
        v00.pos[0], v00.pos[1], v00.pos[2],
        v11.pos[0], v11.pos[1], v11.pos[2],
        v01.pos[0], v01.pos[1], v01.pos[2]
      )
      trunkNormals.push(
        v00.norm[0], v00.norm[1], v00.norm[2],
        v11.norm[0], v11.norm[1], v11.norm[2],
        v01.norm[0], v01.norm[1], v01.norm[2]
      )
      trunkUvs.push(
        v00.uv[0], v00.uv[1],
        v11.uv[0], v11.uv[1],
        v01.uv[0], v01.uv[1]
      )
      trunkColors.push(
        v00.col[0], v00.col[1], v00.col[2],
        v11.col[0], v11.col[1], v11.col[2],
        v01.col[0], v01.col[1], v01.col[2]
      )
    }
  }

  const trunk = new THREE.BufferGeometry()
  trunk.setAttribute("position", new THREE.Float32BufferAttribute(trunkPositions, 3))
  trunk.setAttribute("normal", new THREE.Float32BufferAttribute(trunkNormals, 3))
  trunk.setAttribute("uv", new THREE.Float32BufferAttribute(trunkUvs, 2))
  trunk.setAttribute("color", new THREE.Float32BufferAttribute(trunkColors, 3))
  trunk.userData.shared = true

  // 3. Build crown parts (all non-indexed, attributes: position, normal, color)
  const crownTop = trunkCenter(species, height, height, sideways, seed)
  const crownParts: THREE.BufferGeometry[] = []

  if (species === "coconut") {
    // 14 pinnate fronds evenly distributed with +-12 deg jitter
    const frondCount = 14
    const jitterRad = 12 * (Math.PI / 180)
    for (let i = 0; i < frondCount; i++) {
      const baseAzimuth = (i / frondCount) * Math.PI * 2
      const azimuth = baseAzimuth + (rand() - 0.5) * 2 * jitterRad
      const isDying = i < 3 // 2-3 lowest fronds are dying with heavy droop
      const elevation = isDying
        ? (-10 + rand() * 25) * (Math.PI / 180)
        : (35 + rand() * 20) * (Math.PI / 180)
      const length = 3.8 + rand() * 1.2
      const droop = isDying ? 0.72 : 0.55
      const brightness = 0.85 + rand() * 0.25

      crownParts.push(
        buildPinnateFrond(crownTop, azimuth, elevation, length, droop, isDying, brightness)
      )
    }

    // 3-6 coconuts clustered just below crown top
    crownParts.push(...buildCoconuts(crownTop, rand))
  } else if (species === "royal") {
    // 16 pinnate fronds in upright crown (40..70 deg)
    const frondCount = 16
    const jitterRad = 12 * (Math.PI / 180)
    for (let i = 0; i < frondCount; i++) {
      const baseAzimuth = (i / frondCount) * Math.PI * 2
      const azimuth = baseAzimuth + (rand() - 0.5) * 2 * jitterRad
      const elevation = (40 + rand() * 30) * (Math.PI / 180)
      const length = 3.5 + rand() * 1.0
      const droop = 0.35
      const brightness = 0.85 + rand() * 0.25

      crownParts.push(
        buildPinnateFrond(crownTop, azimuth, elevation, length, droop, false, brightness)
      )
    }
  } else {
    // Fan palm: 18 fan leaves + skirt of 22 dead brown fronds
    const leafCount = 18
    const jitterRad = 10 * (Math.PI / 180)
    for (let i = 0; i < leafCount; i++) {
      const baseAzimuth = (i / leafCount) * Math.PI * 2
      const azimuth = baseAzimuth + (rand() - 0.5) * 2 * jitterRad
      const elevation = (20 + (i % 3) * 14 + (rand() - 0.5) * 6) * (Math.PI / 180)
      const tilt = (20 + rand() * 20) * (Math.PI / 180)
      const brightness = 0.85 + rand() * 0.25

      crownParts.push(
        buildFanLeaf(crownTop, azimuth, elevation, tilt, brightness)
      )
    }

    const { radius: topRadius } = trunkProfile(species, height - 0.25, height)
    crownParts.push(buildFanSkirt(crownTop, topRadius, rand))
  }

  // Merge crown subgeometries into a single non-indexed BufferGeometry
  const crown = mergeGeometries(crownParts, false) || new THREE.BufferGeometry()
  crown.userData.shared = true

  return { trunk, crown, height }
}

export function palmMaterials(): { trunk: THREE.MeshStandardMaterial; crown: THREE.MeshStandardMaterial } {
  return {
    trunk: new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95
    }),
    crown: new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.75,
      metalness: 0
    })
  }
}
