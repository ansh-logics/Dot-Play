import * as THREE from "three"
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import { rng } from "./road"

/*
 * Vegetation pieces built to be drawn as InstancedMesh with thousands of instances: grass
 * clumps, broadleaf trees and far-distance tree impostors. Everything is procedural (canvas
 * textures, generated geometry). Shaders only patch r170 chunks and keep every #include, so
 * the engine's haze wrapper (which chains onto onBeforeCompile) still finds <common> and
 * <fog_vertex>/<fog_fragment>.
 */

const UP = new THREE.Vector3(0, 1, 0)

/**
 * Sun direction (world, towards the sun) and colour × intensity (scene units, i.e. the
 * directional light's colour × intensity) for foliage translucency. The engine updates these
 * with the time of day; every foliage material shares these uniform objects.
 */
export const FOLIAGE = {
  uFolSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uFolSunColor: { value: new THREE.Color(0, 0, 0) },
}

/**
 * Leaves let light through: looking towards the sun, a canopy glows green-gold instead of
 * going black (the main reason backlit trees looked like flat cut-outs), and its sunlit side
 * shows some light through the back faces too. Composes with any onBeforeCompile already set.
 */
function addTranslucency(mat: THREE.Material, strength: number, key: string) {
  const prev = mat.onBeforeCompile
  const baseKey = mat.customProgramCacheKey()
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer)
    Object.assign(shader.uniforms, FOLIAGE)
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uFolSunDir;\nuniform vec3 uFolSunColor;")
      .replace(
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>
        {
          vec3 folL = normalize(mat3(viewMatrix) * uFolSunDir);
          vec3 folV = normalize(vViewPosition);
          float folBack = pow(max(dot(-folV, folL), 0.0), 4.0);
          float folThrough = max(dot(-normal, folL), 0.0);
          reflectedLight.directDiffuse += diffuseColor.rgb * uFolSunColor * (folBack * 0.55 + folThrough * 0.22) * ${strength.toFixed(2)};
        }`,
      )
  }
  mat.customProgramCacheKey = () => `${baseKey}|${key}`
}

// ---------------------------------------------------------------------------------------
// Shared shader bits
// ---------------------------------------------------------------------------------------

/** Declares the wind clock once, after <common>, leaving <common> in place for the haze patch. */
const WIND_PARS = "#include <common>\nuniform float uWindTime;"

/** Instance origin, used as the wind phase so neighbours don't move in lockstep. */
const INSTANCE_ORIGIN = /* glsl */ `
  #ifdef USE_INSTANCING
    vec3 ip = vec3(instanceMatrix[3]);
  #else
    vec3 ip = vec3(0.0);
  #endif`

/**
 * Adds a world-space offset `w` to `transformed`. The wind is authored in world space so the
 * whole field bends one way whatever each instance's random yaw is: object offset =
 * Mᵀ·w / |M.x| for a rotation × uniform-scale instance matrix, which lands as w × scale.
 */
const ADD_WORLD_OFFSET = /* glsl */ `
  #ifdef USE_INSTANCING
    mat3 wim = mat3(instanceMatrix);
    transformed += transpose(wim) * w / max(length(wim[0]), 1e-4);
  #else
    transformed += w;
  #endif`

/** Grass: sway grows with uv.y² (0 at the roots), with gust fronts rolling across the field. */
const GRASS_WIND = /* glsl */ `#include <begin_vertex>
{
  ${INSTANCE_ORIGIN}
  float gh = uv.y * uv.y;
  float front = dot(ip.xz, vec2(0.8, 0.6));
  float gust = 0.55 + 0.45 * sin(uWindTime * 0.8 - front * 0.12);
  float ph = ip.x * 0.37 + ip.z * 0.23;
  float sway = (0.5 + 0.5 * sin(uWindTime * 1.9 - front * 0.5 + ph)) * gust;
  vec3 w = vec3(0.8, 0.0, 0.6) * sway * 0.16 + vec3(-0.6, 0.0, 0.8) * sin(uWindTime * 2.7 + ph * 1.3) * 0.03;
  w *= gh;
  // Tips dip as they bend, so blades read as bending rather than shearing sideways.
  w.y = -dot(w.xz, w.xz) * 1.5;
  ${ADD_WORLD_OFFSET}
}`

/** Canopy: a slow whole-crown sway plus a small per-vertex rustle so the crown shimmers. */
const CANOPY_WIND = /* glsl */ `#include <begin_vertex>
{
  ${INSTANCE_ORIGIN}
  float hh = clamp(position.y / 10.0, 0.0, 1.0);
  hh *= hh;
  float ph = ip.x * 0.07 + ip.z * 0.05;
  float s = sin(uWindTime * 0.7 + ph) * 0.07 + sin(uWindTime * 1.6 + ph * 1.7) * 0.025;
  vec3 w = vec3(0.8, 0.0, 0.6) * s * hh;
  float rv = dot(position, vec3(1.7, 2.3, 1.9));
  w += vec3(sin(uWindTime * 3.1 + rv + ph), sin(uWindTime * 2.7 + rv * 1.3), cos(uWindTime * 3.4 + rv * 0.9 + ph)) * 0.025 * hh;
  ${ADD_WORLD_OFFSET}
}`

/**
 * Patches a material's vertex shader with a wind block. The cache key must be explicit:
 * three's default key is the callback's source text, shared by every material patched here.
 */
function patchWind(mat: THREE.Material, time: () => { value: number }, block: string, key: string) {
  mat.customProgramCacheKey = () => key
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = time()
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", WIND_PARS)
      .replace("#include <begin_vertex>", block)
  }
}

/** Shadow-pass twin of a wind material, so cast shadows move with the leaves/blades. */
function windDepth(map: THREE.Texture | null, alphaTest: number, side: THREE.Side) {
  return new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest, side })
}

/** Small canvas helper. */
function canvas2d(w: number, h: number) {
  const c = document.createElement("canvas")
  c.width = w
  c.height = h
  return { c, g: c.getContext("2d")! }
}

function canvasTexture(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.needsUpdate = true
  return t
}

// ---------------------------------------------------------------------------------------
// Grass
// ---------------------------------------------------------------------------------------

/**
 * A grass clump: 3 crossed vertical quads (0°, 60°, 120°), ~1 m wide × 0.7 m tall, base at
 * y = 0. Each quad has a mid-height vertex row so the uv.y² wind bends it in a curve rather
 * than shearing it. Normals lean mostly up so clumps light like the ground they sit on.
 */
export function grassCardGeometry(): THREE.BufferGeometry {
  const H = 0.7
  // Narrower at the root, flaring at the tips: reads as a tuft rather than a flat card.
  const rows = [
    { v: 0, y: 0, half: 0.4 },
    { v: 0.5, y: H * 0.5, half: 0.5 },
    { v: 1, y: H, half: 0.56 },
  ]
  const pos: number[] = []
  const nrm: number[] = []
  const uvs: number[] = []
  const idx: number[] = []
  const n = new THREE.Vector3()
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI) / 3
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    // Card's own normal (its +z rotated by a), blended heavily toward up.
    n.set(sa, 0, ca).multiplyScalar(0.3).add(UP).normalize()
    const base = pos.length / 3
    for (const r of rows)
      for (let c = 0; c < 2; c++) {
        const x = c === 0 ? -r.half : r.half
        pos.push(x * ca, r.y, -x * sa)
        nrm.push(n.x, n.y, n.z)
        uvs.push(c, r.v)
      }
    for (let r = 0; r < rows.length - 1; r++) {
      const i = base + r * 2
      idx.push(i, i + 1, i + 3, i, i + 3, i + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(idx)
  g.computeBoundingSphere()
  g.computeBoundingBox()
  g.userData.shared = true
  return g
}

let grassTex: THREE.CanvasTexture | null = null

/**
 * 512×256 blade sheet: many thin tapered blades (quadratic curves), several greens with
 * dry-yellow tips, transparent background, densest near the ground (v = 0 at the bottom).
 * Cached: the colour and shadow materials share one upload.
 */
export function grassTexture(): THREE.CanvasTexture {
  if (grassTex) return grassTex
  const W = 512
  const H = 256
  const { c, g } = canvas2d(W, H)
  const r = rng(7331)
  const greens = ["#3f6b23", "#4d7a2a", "#5c8a31", "#6e9a3a", "#557d2c", "#7a9c42"]
  const dry = ["#c9b867", "#b9a95a", "#d6c27a", "#a8a456"]
  const blades: { x: number; h: number }[] = []
  for (let i = 0; i < 460; i++) {
    // pow > 1 biases toward short blades, so the bottom of the sheet is densest.
    blades.push({ x: 6 + r() * (W - 12), h: H * (0.18 + 0.8 * Math.pow(r(), 1.5)) })
  }
  // Tall ones first, short ones in front of their roots.
  blades.sort((a, b) => b.h - a.h)
  for (const b of blades) {
    const w = 2.2 + r() * 4
    const lean = (r() - 0.5) * b.h * 0.55
    const tx = Math.min(W - 2, Math.max(2, b.x + lean))
    const ty = H - b.h
    const cx = b.x + lean * 0.15
    const cy = H - b.h * 0.55
    const grad = g.createLinearGradient(b.x, H, tx, ty)
    const green = greens[Math.floor(r() * greens.length)]
    grad.addColorStop(0, "#22401a")
    grad.addColorStop(0.35, green)
    const dryTip = r() < 0.65
    grad.addColorStop(0.75, dryTip ? green : greens[Math.floor(r() * greens.length)])
    grad.addColorStop(1, dryTip ? dry[Math.floor(r() * dry.length)] : green)
    g.fillStyle = grad
    g.beginPath()
    g.moveTo(b.x - w / 2, H)
    g.quadraticCurveTo(cx - w * 0.3, cy, tx, ty)
    g.quadraticCurveTo(cx + w * 0.3, cy, b.x + w / 2, H)
    g.closePath()
    g.fill()
  }
  grassTex = canvasTexture(c)
  return grassTex
}

let grassTime: { value: number } = { value: 0 }

/**
 * Shadow-pass material for grass: same uv.y² sway, alpha-tested on the blade sheet. Its map
 * and clock are hooked up by grassMaterial(), so call that first (it also stores this in
 * material.userData.windDepth, which the engine's instance() assigns as customDepthMaterial).
 */
export const grassDepthMaterial = windDepth(null, 0.5, THREE.DoubleSide)
patchWind(grassDepthMaterial, () => grassTime, GRASS_WIND, "grass-wind-depth")

/**
 * Where a grass field reaches, for its shader: a segment a→b (world x/z) and a radius.
 * Tufts shrink to nothing over the outer fifth of the reach, so cells streaming in or out
 * at the edge never pop.
 */
export interface GrassFade {
  uGrassA: { value: THREE.Vector2 }
  uGrassB: { value: THREE.Vector2 }
  uGrassR: { value: number }
}

export function grassFade(): GrassFade {
  return { uGrassA: { value: new THREE.Vector2() }, uGrassB: { value: new THREE.Vector2() }, uGrassR: { value: 1e6 } }
}

const GRASS_FADE_PARS = /* glsl */ `
uniform vec2 uGrassA;
uniform vec2 uGrassB;
uniform float uGrassR;`

const GRASS_FADE = /* glsl */ `
#ifdef USE_INSTANCING
{
  vec2 gp = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
  vec2 gab = uGrassB - uGrassA;
  float gt = clamp(dot(gp - uGrassA, gab) / max(dot(gab, gab), 1e-4), 0.0, 1.0);
  float gd = length(gp - (uGrassA + gab * gt));
  transformed *= 1.0 - smoothstep(uGrassR * 0.8, uGrassR, gd);
}
#endif`

/**
 * Grass clump material. Per-clump tint comes from InstancedMesh.setColorAt (instanceColor
 * multiplies the diffuse), not vertex colours: vary hue/brightness per instance there.
 */
export function grassMaterial(time: { value: number }, fade?: GrassFade): THREE.MeshStandardMaterial {
  const map = grassTexture()
  const mat = new THREE.MeshStandardMaterial({
    map,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
  })
  mat.customProgramCacheKey = () => (fade ? "grass-wind-fade" : "grass-wind")
  mat.onBeforeCompile = (shader) => {
    if (fade) Object.assign(shader.uniforms, fade)
    shader.uniforms.uWindTime = time
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", WIND_PARS + (fade ? GRASS_FADE_PARS : ""))
      .replace("#include <begin_vertex>", GRASS_WIND + (fade ? GRASS_FADE : ""))
    // Double-sided materials flip the normal on back faces; with up-leaning normals that
    // would light the back of every card from below. Undo the flip: both sides face the sky.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <normal_fragment_begin>",
      `#include <normal_fragment_begin>
      #if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
        normal *= faceDirection;
      #endif`,
    )
  }
  grassTime = time
  grassDepthMaterial.map = map
  grassDepthMaterial.needsUpdate = true
  mat.userData.windDepth = grassDepthMaterial
  return mat
}

// ---------------------------------------------------------------------------------------
// Roadside bush
// ---------------------------------------------------------------------------------------

/**
 * A small roadside bush: a few noise-displaced blobs, vertex-coloured like the tree canopies
 * (darker underneath, lighter on top). Replaces the heavy photo-scanned shrubs: ~300 triangles
 * instead of ~6,000, and no alpha cards.
 */
export function bushGeometry(seed: number): THREE.BufferGeometry {
  const r = rng(seed * 9781 + 17)
  const targetW = 0.9 + r() * 0.9
  const targetH = 0.6 + r() * 0.7
  const numBlobs = 3 + Math.floor(r() * 3) // 3–5 blobs (80 triangles each)

  type Blob = { c: THREE.Vector3; rad: number }
  const blobs: Blob[] = []

  // Main central blob
  const mainRad = targetW * (0.34 + r() * 0.05)
  const FLAT = (targetH * 0.5) / mainRad
  blobs.push({
    c: new THREE.Vector3((r() - 0.5) * 0.06 * targetW, mainRad * FLAT - 0.1, (r() - 0.5) * 0.06 * targetW),
    rad: mainRad,
  })

  // Satellite overlapping blobs to span width and cluster naturally
  const numSat = numBlobs - 1
  const a0 = r() * Math.PI * 2
  for (let i = 0; i < numSat; i++) {
    const a = a0 + (i / numSat) * Math.PI * 2 + (r() - 0.5) * 0.4
    const rad = targetW * (0.24 + r() * 0.05)
    const dist = targetW * 0.48 - rad * (0.8 + r() * 0.2)
    blobs.push({
      c: new THREE.Vector3(Math.cos(a) * dist, rad * FLAT - 0.1, Math.sin(a) * dist),
      rad,
    })
  }

  const centre = new THREE.Vector3()
  for (const b of blobs) centre.add(b.c)
  centre.divideScalar(blobs.length)
  centre.y -= 0.3

  const phases = [0, 0, 0, 0, 0, 0].map(() => r() * Math.PI * 2)
  const parts: THREE.BufferGeometry[] = []
  for (const b of blobs) {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(b.rad, 1)
    g.deleteAttribute("uv")
    g.deleteAttribute("normal")
    g = mergeVertices(g)
    const p = g.getAttribute("position")
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const y = p.getY(i)
      const z = p.getZ(i)
      const wx = x + b.c.x
      const wy = y + b.c.y
      const wz = z + b.c.z
      const d = 1 + 0.15 * noise3(wx * 1.8, wy * 1.8, wz * 1.8, phases)
      p.setXYZ(i, wx + x * (d - 1), b.c.y + y * d * FLAT, wz + z * (d - 1))
    }
    g.computeVertexNormals()
    parts.push(g)
  }
  const bush = mergeGeometries(parts)!

  // Ensure base sits slightly below y = 0 (-0.1) so it never floats
  bush.computeBoundingBox()
  const box = bush.boundingBox!
  const shiftY = -0.1 - box.min.y
  bush.translate(0, shiftY, 0)
  centre.y += shiftY
  box.min.y += shiftY
  box.max.y += shiftY

  // Bake shading into vertex colours and bend normals outward from centre
  const pos = bush.getAttribute("position")
  const nrm = bush.getAttribute("normal")
  const col = new Float32Array(pos.count * 3)
  const dark = new THREE.Color(0.12, 0.2, 0.07)
  const light = new THREE.Color(0.3, 0.42, 0.14)
  const tint = new THREE.Color().setHSL(0.23 + (r() - 0.5) * 0.12, 0.5, 0.5)
  const tmp = new THREE.Color()
  const tinted = new THREE.Color()
  const v = new THREE.Vector3()
  const n = new THREE.Vector3()
  const out = new THREE.Vector3()
  let maxD = 0
  for (let i = 0; i < pos.count; i++) maxD = Math.max(maxD, v.fromBufferAttribute(pos, i).distanceTo(centre))
  const hSpan = Math.max(box.max.y - box.min.y, 1e-3)
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    n.fromBufferAttribute(nrm, i)
    out.subVectors(v, centre)
    const dist = out.length()
    out.divideScalar(Math.max(dist, 1e-4))
    n.multiplyScalar(0.5).addScaledVector(out, 0.5).normalize()
    nrm.setXYZ(i, n.x, n.y, n.z)
    const sky = n.y * 0.5 + 0.5
    const outer = dist / maxD
    const ht = (v.y - box.min.y) / hSpan
    const shade = Math.min(1.0, Math.max(0.0, 0.05 + 0.4 * sky + 0.3 * outer * outer + 0.3 * ht))
    tmp.copy(dark).lerp(light, shade)
    // Random per-bush hue shift (some greener, some more olive)
    tmp.lerp(tinted.copy(tint).multiplyScalar(tmp.g * 1.6), 0.14)
    col[i * 3] = tmp.r
    col[i * 3 + 1] = tmp.g
    col[i * 3 + 2] = tmp.b
  }
  nrm.needsUpdate = true
  bush.setAttribute("color", new THREE.BufferAttribute(col, 3))
  bush.computeBoundingSphere()
  bush.userData.shared = true
  return bush
}

// ---------------------------------------------------------------------------------------
// Broadleaf tree
// ---------------------------------------------------------------------------------------

/** A tapered, open-ended cylinder from `start` along `dir`, with bark uvs scaled to length. */
function limb(start: THREE.Vector3, dir: THREE.Vector3, len: number, r0: number, r1: number) {
  const g = new THREE.CylinderGeometry(r1, r0, len, 7, 3, true)
  g.translate(0, len / 2, 0)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize()))
  g.translate(start.x, start.y, start.z)
  const uv = g.getAttribute("uv")
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2, uv.getY(i) * (len / 1.4))
  return g
}

/** Cheap smooth 3D noise (sum of sine products), roughly -1..1; seeded by phase offsets. */
function noise3(x: number, y: number, z: number, p: number[]) {
  return (
    Math.sin(x * 1.3 + p[0]) * Math.sin(y * 1.7 + p[1]) * Math.sin(z * 1.1 + p[2]) * 0.6 +
    Math.sin(x * 2.9 + p[3]) * Math.sin(y * 2.3 + p[4]) * Math.sin(z * 3.1 + p[5]) * 0.4
  ) * 1.6
}

/**
 * Coastal live-oak / tropical broadleaf, 7–10 m tall, base at y = 0. Trunk: a leaning
 * tapered cylinder plus 2–3 branches (merged, bark uvs). Canopy: 5–8 noise-displaced
 * icosahedron blobs merged, flattened into a broad crown. The big blobs at the branch tips
 * and the crown top are detail 2 (180 tris each in r170) and the fill blobs detail 1 (80),
 * which keeps the canopy at roughly 0.6–1.05k triangles. Vertex colours bake fake AO (dark underneath and inside) and sky light
 * (lighter on top); normals lean outward from the crown centre so it shades as one mass.
 */
export function broadleafTreeGeometry(seed: number): {
  trunk: THREE.BufferGeometry
  canopy: THREE.BufferGeometry
} {
  const r = rng(seed * 9781 + 17)
  const H = 7 + r() * 3
  const th = H * (0.34 + r() * 0.08)
  const leanA = r() * Math.PI * 2
  const leanAmt = 0.25 + r() * 0.35
  const top = new THREE.Vector3(Math.cos(leanA) * leanAmt, th, Math.sin(leanA) * leanAmt)
  const trunkR = 0.3 + r() * 0.12

  // Main trunk starts a little below ground so the base never floats on slopes.
  const trunkDir = top.clone().setY(th + 0.3)
  const limbs: THREE.BufferGeometry[] = [limb(new THREE.Vector3(0, -0.3, 0), trunkDir, trunkDir.length(), trunkR, trunkR * 0.62)]
  const ends: THREE.Vector3[] = []
  const nb = 2 + Math.floor(r() * 2)
  const a0 = r() * Math.PI * 2
  for (let i = 0; i < nb; i++) {
    const a = a0 + (i / nb) * Math.PI * 2 + (r() - 0.5) * 0.8
    const spread = 0.8 + r() * 0.5
    const dir = new THREE.Vector3(Math.cos(a) * spread, 0.75 + r() * 0.35, Math.sin(a) * spread).normalize()
    const len = 2.2 + r() * 1.2
    const start = top.clone().addScaledVector(top, -0.12)
    limbs.push(limb(start, dir, len, trunkR * 0.55, trunkR * 0.22))
    ends.push(start.clone().addScaledVector(dir, len))
  }
  const trunk = mergeGeometries(limbs)!
  trunk.computeBoundingSphere()
  trunk.computeBoundingBox()
  trunk.userData.shared = true

  // Blob layout: one at each branch tip, a crown top, then 1–4 smaller fill blobs.
  type Blob = { c: THREE.Vector3; rad: number; detail: number }
  const blobs: Blob[] = []
  const FLAT = 0.72
  for (const e of ends) blobs.push({ c: e.clone().add(new THREE.Vector3(0, 0.5, 0)), rad: 1.8 + r() * 0.6, detail: 2 })
  const crownR = 2.0 + r() * 0.5
  blobs.push({ c: new THREE.Vector3(top.x, H - crownR * FLAT, top.z), rad: crownR, detail: 2 })
  const fill = Math.max(2, 7 + Math.floor(r() * 4) - blobs.length)
  for (let i = 0; i < fill; i++) {
    const e = ends[i % ends.length]
    const t = 0.35 + r() * 0.4
    const c = new THREE.Vector3().lerpVectors(top, e, t)
    c.y = Math.max(c.y + 1.0, th + 1.2) + r() * 1.2
    c.x += (r() - 0.5) * 1.6
    c.z += (r() - 0.5) * 1.6
    blobs.push({ c, rad: 1.3 + r() * 0.5, detail: 1 })
  }

  const centre = new THREE.Vector3()
  for (const b of blobs) centre.add(b.c)
  centre.divideScalar(blobs.length)
  // Lowered, so normals across the upper crown point mostly at the sky.
  centre.y -= 1.0

  const phases = [0, 0, 0, 0, 0, 0].map(() => r() * Math.PI * 2)
  const parts: THREE.BufferGeometry[] = []
  for (const b of blobs) {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(b.rad, b.detail)
    // Weld the shared corners first so displacement and normals stay crack-free.
    g.deleteAttribute("uv")
    g.deleteAttribute("normal")
    g = mergeVertices(g)
    const p = g.getAttribute("position")
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i)
      const y = p.getY(i)
      const z = p.getZ(i)
      const wx = x + b.c.x
      const wy = y + b.c.y
      const wz = z + b.c.z
      // Two octaves: big lumps plus leaf-cluster bumps, so outlines read as foliage.
      const d = 1 + 0.26 * noise3(wx * 0.9, wy * 0.9, wz * 0.9, phases) + 0.1 * noise3(wx * 2.7, wy * 2.7, wz * 2.7, phases)
      p.setXYZ(i, wx + x * (d - 1), b.c.y + y * d * FLAT, wz + z * (d - 1))
    }
    g.computeVertexNormals()
    parts.push(g)
  }
  const canopy = mergeGeometries(parts)!

  // Bake shading into vertex colours and bend normals outward from the crown centre.
  canopy.computeBoundingBox()
  const box = canopy.boundingBox!
  const pos = canopy.getAttribute("position")
  const nrm = canopy.getAttribute("normal")
  const col = new Float32Array(pos.count * 3)
  const dark = new THREE.Color("#1a2a10")
  const light = new THREE.Color("#7a9440")
  const tint = new THREE.Color().setHSL(0.22 + (r() - 0.5) * 0.05, 0.5, 0.5)
  const tmp = new THREE.Color()
  const tinted = new THREE.Color()
  const v = new THREE.Vector3()
  const n = new THREE.Vector3()
  const out = new THREE.Vector3()
  let maxD = 0
  for (let i = 0; i < pos.count; i++) maxD = Math.max(maxD, v.fromBufferAttribute(pos, i).distanceTo(centre))
  const hSpan = Math.max(box.max.y - box.min.y, 1e-3)
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    n.fromBufferAttribute(nrm, i)
    out.subVectors(v, centre)
    const dist = out.length()
    out.divideScalar(Math.max(dist, 1e-4))
    n.multiplyScalar(0.5).addScaledVector(out, 0.5).normalize()
    nrm.setXYZ(i, n.x, n.y, n.z)
    const sky = n.y * 0.5 + 0.5
    const outer = dist / maxD
    const ht = (v.y - box.min.y) / hSpan
    const shade = Math.min(1.1, 0.05 + 0.4 * sky + 0.3 * outer * outer + 0.3 * ht)
    tmp.copy(dark).lerp(light, shade)
    // A faint per-tree hue shift keeps a grove from looking cloned.
    tmp.lerp(tinted.copy(tint).multiplyScalar(tmp.g * 1.6), 0.12)
    tmp.multiplyScalar(0.88 + 0.24 * (0.5 + 0.5 * Math.sin(i * 12.9898 + pos.getX(i) * 3.1 + pos.getZ(i) * 1.7)))
    col[i * 3] = tmp.r
    col[i * 3 + 1] = tmp.g
    col[i * 3 + 2] = tmp.b
  }
  nrm.needsUpdate = true
  canopy.setAttribute("color", new THREE.BufferAttribute(col, 3))
  canopy.computeBoundingSphere()
  canopy.userData.shared = true
  return { trunk, canopy }
}

/** Bark: vertical fissured streaks, tiling (RepeatWrapping) along the trunk uvs. */
function barkTexture() {
  const { c, g } = canvas2d(128, 256)
  const r = rng(4242)
  g.fillStyle = "#5a4a3c"
  g.fillRect(0, 0, 128, 256)
  for (let i = 0; i < 220; i++) {
    const x = r() * 128
    const y = r() * 256
    const len = 20 + r() * 70
    const l = 18 + r() * 30
    g.strokeStyle = `hsl(28, ${12 + r() * 14}%, ${l}%)`
    g.lineWidth = 1 + r() * 3.5
    g.beginPath()
    g.moveTo(x, y)
    g.quadraticCurveTo(x + (r() - 0.5) * 8, y + len / 2, x + (r() - 0.5) * 6, y + len)
    g.stroke()
    // Wrap the stroke vertically so the texture tiles seamlessly.
    if (y + len > 256) {
      g.beginPath()
      g.moveTo(x, y - 256)
      g.quadraticCurveTo(x + (r() - 0.5) * 8, y - 256 + len / 2, x + (r() - 0.5) * 6, y - 256 + len)
      g.stroke()
    }
  }
  const t = canvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  return t
}

/**
 * Trunk and canopy materials. The canopy sways gently (whole crown plus a leaf rustle) and
 * its matching shadow material is in canopy.userData.windDepth (the engine's instance()
 * picks that up as customDepthMaterial). The trunk stays still.
 */
export function treeMaterials(time: { value: number }): {
  trunk: THREE.MeshStandardMaterial
  canopy: THREE.MeshStandardMaterial
} {
  const trunk = new THREE.MeshStandardMaterial({ map: barkTexture(), color: "#b8aa9a", roughness: 0.95, metalness: 0 })
  const canopy = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, flatShading: false })
  patchWind(canopy, () => time, CANOPY_WIND, "canopy-wind")
  const depth = windDepth(null, 0, THREE.FrontSide)
  patchWind(depth, () => time, CANOPY_WIND, "canopy-wind-depth")
  canopy.userData.windDepth = depth
  addTranslucency(canopy, 1.0, "fol")
  return { trunk, canopy }
}

// ---------------------------------------------------------------------------------------
// Distant-tree impostors
// ---------------------------------------------------------------------------------------

/** Atlas cells: 4 across, each 128×256 (aspect 1:2, so scale instances width = height / 2). */
const CELL_W = 128
const CELL_H = 256

function blob(g: CanvasRenderingContext2D, x: number, y: number, rad: number, color: string) {
  g.fillStyle = color
  g.beginPath()
  g.arc(x, y, rad, 0, Math.PI * 2)
  g.fill()
}

/** Painterly broadleaf: a short trunk and a crown of overlapping dabs, lighter on top. */
function paintBroadleaf(g: CanvasRenderingContext2D, ox: number, r: () => number, wide: boolean) {
  const cx = ox + CELL_W / 2
  g.strokeStyle = "#3d3127"
  g.lineCap = "round"
  for (const [w, dx] of [[7, 0], [4, -14], [4, 15]] as const) {
    g.lineWidth = w
    g.beginPath()
    g.moveTo(cx, CELL_H - 4)
    g.quadraticCurveTo(cx + dx * 0.3, CELL_H - 60, cx + dx, CELL_H - (dx === 0 ? 120 : 105))
    g.stroke()
  }
  const rx = wide ? 54 : 44
  const ry = wide ? 58 : 76
  const cy = wide ? 104 : 96
  const centres: [number, number][] = []
  for (let i = 0; i < 7; i++) centres.push([cx + (r() - 0.5) * rx * 1.3, cy + (r() - 0.5) * ry * 1.1])
  for (let i = 0; i < 260; i++) {
    const [bx, by] = centres[Math.floor(r() * centres.length)]
    const x = Math.min(ox + CELL_W - 10, Math.max(ox + 10, bx + (r() - 0.5) * 46))
    const y = Math.min(CELL_H - 50, Math.max(10, by + (r() - 0.5) * 46))
    const lift = 1 - (y - (cy - ry)) / (ry * 2) // 1 at the top of the crown
    const l = 18 + lift * 18 + r() * 8
    blob(g, x, y, 5 + r() * 9, `hsl(${85 + r() * 25}, ${30 + r() * 15}%, ${l}%)`)
  }
}

/** Palm: a curved trunk and drooping fronds with leaflet strokes. */
function paintPalm(g: CanvasRenderingContext2D, ox: number, r: () => number) {
  const bx = ox + CELL_W / 2 - 10
  const tx = ox + CELL_W / 2 + 10
  const ty = 50
  g.strokeStyle = "#6b5a45"
  g.lineCap = "round"
  g.lineWidth = 7
  g.beginPath()
  g.moveTo(bx, CELL_H - 4)
  g.quadraticCurveTo(bx - 6, 150, tx, ty)
  g.stroke()
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2 + r() * 0.3
    const dx = Math.cos(a) * (38 + r() * 14)
    const len = Math.abs(dx) + 20
    const ex = Math.min(ox + CELL_W - 6, Math.max(ox + 6, tx + dx))
    const ey = ty + 18 + Math.sin(a) * 10 + len * 0.45
    const mx = tx + dx * 0.55
    const my = ty - 14 - r() * 8
    g.strokeStyle = `hsl(${88 + r() * 20}, 38%, ${24 + r() * 10}%)`
    g.lineWidth = 4
    g.beginPath()
    g.moveTo(tx, ty)
    g.quadraticCurveTo(mx, my, ex, ey)
    g.stroke()
    // Leaflets hanging off the rachis.
    g.lineWidth = 2
    for (let s = 0.2; s < 1; s += 0.1) {
      const u = 1 - s
      const px = u * u * tx + 2 * u * s * mx + s * s * ex
      const py = u * u * ty + 2 * u * s * my + s * s * ey
      g.beginPath()
      g.moveTo(px, py)
      g.lineTo(px + (r() - 0.5) * 6, py + 8 + r() * 6)
      g.stroke()
    }
  }
}

/** Conifer-ish: stacked jagged tiers on a short trunk, blue-green and darker. */
function paintConifer(g: CanvasRenderingContext2D, ox: number, r: () => number) {
  const cx = ox + CELL_W / 2
  g.fillStyle = "#3a2e25"
  g.fillRect(cx - 3, CELL_H - 40, 6, 36)
  const tiers = 8
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1)
    const yTop = 14 + t * 150
    const yBot = yTop + 42
    const half = 10 + t * 44
    g.fillStyle = `hsl(${130 + r() * 15}, ${22 + r() * 10}%, ${16 + (1 - t) * 10 + r() * 5}%)`
    g.beginPath()
    g.moveTo(cx, yTop)
    const steps = 6
    for (let s = 0; s <= steps; s++) {
      const x = cx + half * (s / steps)
      g.lineTo(x + (r() - 0.5) * 4, yBot - (s % 2) * 8 + (r() - 0.5) * 4)
    }
    for (let s = steps; s >= 0; s--) {
      const x = cx - half * (s / steps)
      g.lineTo(x + (r() - 0.5) * 4, yBot - (s % 2) * 8 + (r() - 0.5) * 4)
    }
    g.closePath()
    g.fill()
  }
}

/**
 * 512×256 atlas of 4 distant-tree silhouettes side by side (broadleaf, broadleaf, palm,
 * conifer), soft and painterly, darker toward the bottom, transparent background. Each cell
 * keeps a margin so mipmaps don't bleed neighbours into each other.
 */
export function impostorTexture(): THREE.CanvasTexture {
  const { c, g } = canvas2d(CELL_W * 4, CELL_H)
  const r = rng(1999)
  paintBroadleaf(g, 0, r, true)
  paintBroadleaf(g, CELL_W, r, false)
  paintPalm(g, CELL_W * 2, r)
  paintConifer(g, CELL_W * 3, r)
  // Darken toward the ground (only where something is painted): fake ambient occlusion.
  g.globalCompositeOperation = "source-atop"
  const grad = g.createLinearGradient(0, 0, 0, CELL_H)
  grad.addColorStop(0, "rgba(255,250,220,0.08)")
  grad.addColorStop(0.45, "rgba(0,0,0,0)")
  grad.addColorStop(1, "rgba(0,0,0,0.4)")
  g.fillStyle = grad
  g.fillRect(0, 0, CELL_W * 4, CELL_H)
  g.globalCompositeOperation = "source-over"
  return canvasTexture(c)
}

/** Unit quad for impostors: x −0.5..0.5, y 0..1, base at the instance position. */
export function impostorGeometry(): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(1, 1)
  g.translate(0, 0.5, 0)
  g.userData.shared = true
  return g
}

/**
 * Cylindrical billboard: centre and per-axis scale come from the (model × instance) matrix;
 * the quad turns about world up to face the camera. `transformed` is then rewritten to the
 * object-space point that lands on the billboard corner, so every later chunk (shadow
 * coords, the engine's haze world position) sees the true billboarded position.
 */
const IMPOSTOR_PROJECT = /* glsl */ `
  #ifdef USE_INSTANCING
    mat4 bbM = modelMatrix * instanceMatrix;
  #else
    mat4 bbM = modelMatrix;
  #endif
  vec3 bbCenter = bbM[3].xyz;
  vec3 bbFwd = cameraPosition - bbCenter;
  bbFwd.y = 0.0;
  bbFwd = dot(bbFwd, bbFwd) > 1e-8 ? normalize(bbFwd) : vec3(0.0, 0.0, 1.0);
  vec3 bbRight = vec3(bbFwd.z, 0.0, -bbFwd.x);
  vec3 bbWorld = bbCenter + bbRight * (transformed.x * length(bbM[0].xyz)) + vec3(0.0, transformed.y * length(bbM[1].xyz), 0.0);
  transformed = (inverse(bbM) * vec4(bbWorld, 1.0)).xyz;
  vec4 mvPosition = viewMatrix * vec4(bbWorld, 1.0);
  gl_Position = projectionMatrix * mvPosition;`

/**
 * Atlas cell per instance from a hash of its position (a fract-based hash: sin() hashes
 * fall apart at large world coordinates on mobile/Apple GPUs).
 */
const IMPOSTOR_UV = /* glsl */ `#include <uv_vertex>
  #if defined( USE_MAP ) && defined( USE_INSTANCING )
  {
    // World position (the ring's model matrix holds its centre), so a tree keeps its
    // species when the ring re-centres.
    vec2 hp = fract((modelMatrix * instanceMatrix)[3].xz * vec2(0.1031, 0.1030));
    hp += dot(hp, hp.yx + 33.33);
    float cell = min(floor(fract((hp.x + hp.y) * hp.x) * 4.0), 3.0);
    vMapUv.x = (cell + mix(0.02, 0.98, vMapUv.x)) * 0.25;
  }
  #endif`

/**
 * Material for an InstancedMesh of impostorGeometry(). Scale instances non-uniformly
 * (x = width, y = height; the atlas cells are 1:2) and give them any position; rotation is
 * ignored (the quad always faces the camera, upright). Normals point up so impostors light
 * like the canopy. Don't let them cast shadows (the shadow pass has no billboard).
 */
export function impostorMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: impostorTexture(),
    alphaTest: 0.5,
    side: THREE.FrontSide,
    roughness: 0.9,
    metalness: 0,
  })
  mat.customProgramCacheKey = () => "impostor"
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <uv_vertex>", IMPOSTOR_UV)
      .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\nobjectNormal = vec3(0.0, 1.0, 0.0);")
      .replace("#include <project_vertex>", IMPOSTOR_PROJECT)
  }
  addTranslucency(mat, 0.8, "fol")
  return mat
}
