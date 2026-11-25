import * as THREE from "three"
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js"
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js"
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js"
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js"
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js"
import { LANE, ROAD_HALF, Road, STEP, groundHeight, rightOf, rng, type RoadSample } from "./road"
import { PALM_SPECIES, palmGeometry, palmMaterials } from "./palms"
import { buildCoupe, type Coupe } from "./car"
import { FOLIAGE, broadleafTreeGeometry, bushGeometry, grassCardGeometry, grassMaterial, impostorGeometry, impostorMaterial, treeMaterials } from "./vegetation"
import { FarTerrain } from "./farTerrain"
import { GrassField } from "./grassField"
import { ColliderSet } from "./collisions"
import { CarPhysics, autopilot, type DriveControls } from "./physics"
import { STRIP_OFFSETS, TerrainQuery } from "./terrainQuery"
import { HAZE, HAZE_PARS, hazeApply, hazeObject } from "./haze"
import { analyseSky, downscaleHdr, loadHdr, loadKit, loadPbr, loadUserCar, type Kit, type PbrSet, type UserCar } from "./assets"

// ---- Time of day ---------------------------------------------------------------------

export type TimeOfDay = "sunset" | "dusk" | "night" | "morning"
export const TIMES: { id: TimeOfDay; label: string }[] = [
  { id: "sunset", label: "Golden hour" },
  { id: "dusk", label: "Neon dusk" },
  { id: "night", label: "Midnight" },
  { id: "morning", label: "Morning" },
]

interface Look {
  /** Brightness the horizon lands at after exposure: how bright this time of day feels. */
  key: number
  /** Sunlight strength (after exposure). */
  sun: number
  /** Blend of the photographed sun colour (0) towards this tint (1). */
  sunTint: THREE.Color
  sunTintMix: number
  /** How much the sky photo fills in shadows (lower = more contrast from the sun). */
  env: number
  /** How dark it is for the car's lights (headlights on above 0.3): 0..1 */
  lamps: number
  bloom: number
  /** Colour grade, applied after tone mapping. */
  saturation: number
  contrast: number
  tint: THREE.Color
  /** Aerial-perspective haze density (per metre, at sea level). */
  haze: number
  /** Soft sky/ground fill light (after exposure). */
  fill: number
  water: THREE.Color
}

const C = (hex: string) => new THREE.Color(hex)
const LOOKS: Record<TimeOfDay, Look> = {
  sunset: { key: 0.6, sun: 3.8, sunTint: C("#ff9a5c"), sunTintMix: 0.55, env: 0.7, lamps: 0.1, bloom: 0.32, saturation: 1.1, contrast: 1.05, tint: new THREE.Color(1.03, 0.98, 0.97), haze: 0.00055, fill: 0.55, water: C("#24305a") },
  dusk: { key: 0.38, sun: 1.1, sunTint: C("#ff7fb0"), sunTintMix: 0.6, env: 0.8, lamps: 1, bloom: 0.5, saturation: 1.12, contrast: 1.05, tint: new THREE.Color(1.02, 0.96, 1.04), haze: 0.0006, fill: 0.5, water: C("#18204a") },
  night: { key: 0.12, sun: 0.7, sunTint: C("#9fb4ff"), sunTintMix: 1, env: 0.85, lamps: 1, bloom: 0.55, saturation: 1.0, contrast: 1.08, tint: new THREE.Color(0.94, 0.97, 1.06), haze: 0.0007, fill: 0.5, water: C("#0b1230") },
  morning: { key: 0.72, sun: 4.5, sunTint: C("#ffd9a0"), sunTintMix: 0.5, env: 0.65, lamps: 0, bloom: 0.16, saturation: 1.12, contrast: 1.04, tint: new THREE.Color(1.02, 1.0, 0.97), haze: 0.00038, fill: 0.5, water: C("#145a7a") },
}

// ---- Quality -------------------------------------------------------------------------

export type Quality = "low" | "medium" | "high"
export type QualitySetting = Quality | "auto"
export const QUALITY_LABELS: { id: QualitySetting; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
]

interface QualityProfile {
  /** Render-resolution range (fraction of CSS pixels); the frame-time governor moves within it. */
  minDpr: number
  maxDpr: number
  shadows: boolean
  shadowSize: number
  bloom: boolean
  /** Chunks of road built ahead of the car (128 m each). */
  ahead: number
  /** Scales how many palms and shrubs a chunk gets. */
  density: number
  /** Grass clumps per 24 m cell of the grass field around the car. */
  grass: number
  /** Radius (m) of the grass field around the car (it follows the car anywhere, off-road too). */
  grassRadius: number
  /** Far-terrain ring resolution and distant forest (impostor) count. */
  farN: number
  farTrees: number
  /** Sky texture downscale from the 4k files: 2 = 2k, 4 = 1k. */
  skyDownscale: number
  /** Multisampling for the post-processing targets (0 = off). */
  msaa: number
}

const PROFILES: Record<Quality, QualityProfile> = {
  low: { minDpr: 0.75, maxDpr: 1, shadows: false, shadowSize: 512, bloom: false, ahead: 4, density: 0.4, grass: 30, grassRadius: 56, farN: 80, farTrees: 1800, skyDownscale: 4, msaa: 0 },
  medium: { minDpr: 0.85, maxDpr: 1.25, shadows: true, shadowSize: 1024, bloom: true, ahead: 6, density: 0.7, grass: 60, grassRadius: 72, farN: 120, farTrees: 4200, skyDownscale: 2, msaa: 2 },
  high: { minDpr: 1, maxDpr: 1.5, shadows: true, shadowSize: 2048, bloom: true, ahead: 8, density: 1, grass: 100, grassRadius: 92, farN: 160, farTrees: 8000, skyDownscale: 2, msaa: 4 },
}

/** A first guess from the GPU's name: integrated/mobile/software → low, Apple silicon → medium. */
function guessQuality(gl: WebGLRenderingContext | WebGL2RenderingContext): Quality {
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info")
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    if (/swiftshader|llvmpipe|software|mali|adreno|powervr|intel\(r\) (hd|uhd)|intel hd|intel uhd/i.test(name)) return "low"
    if (/apple m\d (max|ultra|pro)|rtx|radeon rx|geforce gtx 1[06-9]|geforce gtx 20/i.test(name)) return "high"
    return "medium"
  } catch {
    return "medium"
  }
}

// ---- Shaders -------------------------------------------------------------------------

const WATER_VERT = /* glsl */ `
#include <fog_pars_vertex>
uniform float uTime;
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  wp.y += sin(wp.x * 0.05 + uTime * 0.8) * 0.12 + sin(wp.z * 0.07 - uTime * 0.6) * 0.1;
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`

const WATER_FRAG = /* glsl */ `
#include <fog_pars_fragment>
${HAZE_PARS}
uniform sampler2D uEnv; uniform float uEnvIntensity;
uniform vec3 uDeep; uniform vec3 uSunDir; uniform float uSun; uniform float uTime;
varying vec3 vWorld;
vec2 equirect(vec3 d) {
  return vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
}
void main() {
  vec3 view = normalize(cameraPosition - vWorld);
  float t = uTime;
  vec2 p = vWorld.xz;
  vec3 n = normalize(vec3(
    sin(p.x * 0.21 + t * 1.3) * 0.05 + sin(p.y * 0.53 - t * 1.9) * 0.035 + sin((p.x + p.y) * 1.7 + t * 3.1) * 0.012,
    1.0,
    cos(p.y * 0.17 + t * 1.1) * 0.05 + sin(p.x * 0.47 + t * 2.1) * 0.035 + cos((p.x - p.y) * 1.9 - t * 2.7) * 0.012));
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, view), 0.0), 5.0);
  vec3 r = reflect(-view, n);
  r.y = abs(r.y);
  vec3 sky = texture2D(uEnv, equirect(r)).rgb * uEnvIntensity;
  vec3 col = mix(uDeep, sky, clamp(fres, 0.0, 1.0));
  float glint = pow(max(dot(r, uSunDir), 0.0), 600.0);
  col += vec3(1.0, 0.85, 0.65) * glint * uSun * 4.0;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  ${hazeApply("vWorld")}
}`

/**
 * The one full-screen pass after the scene (and bloom): exposure + Khronos PBR Neutral tone
 * mapping + sRGB encode + colour grade + vignette + grain + the time-of-day fade. Doing it
 * in one pass instead of three.js's OutputPass followed by a grade pass saves a whole
 * full-screen read and write every frame.
 */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1 },
    uSaturation: { value: 1.1 },
    uContrast: { value: 1.05 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uFade: { value: 0 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uExposure; uniform float uSaturation; uniform float uContrast;
    uniform vec3 uTint; uniform float uFade; uniform float uTime;
    varying vec2 vUv;
    // Khronos PBR Neutral (same curve as THREE.NeutralToneMapping).
    vec3 neutralTone(vec3 color) {
      const float startCompression = 0.8 - 0.04;
      const float desaturation = 0.15;
      float x = min(color.r, min(color.g, color.b));
      float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
      color -= offset;
      float peak = max(color.r, max(color.g, color.b));
      if (peak < startCompression) return color;
      float d = 1.0 - startCompression;
      float newPeak = 1.0 - d * d / (peak + d - startCompression);
      color *= newPeak / peak;
      float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
      return mix(color, vec3(newPeak), g);
    }
    vec3 toSRGB(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
    }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure;
      c = toSRGB(clamp(neutralTone(c), 0.0, 1.0));
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      c = (c - 0.5) * uContrast + 0.5;
      c *= uTint;
      vec2 q = vUv - 0.5;
      c *= 1.0 - dot(q, q) * 0.55;
      c += (hash(vUv * 1000.0 + uTime) - 0.5) * 0.014;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0) * uFade, 1.0);
    }`,
}

/**
 * Emissive intensity so a light lands at `target` luminance after exposure, whatever its
 * colour: the bloom threshold is in luminance, and a deep pink or red neon has far less
 * of it than white at the same intensity, so it would never glow.
 */
const glow = (c: THREE.Color, target: number, exposure: number) =>
  target / Math.max(0.05, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / exposure

/** Shared haze uniforms (merge() would clone them, so they're attached after). */
const withHaze = (u: Record<string, THREE.IUniform>) => Object.assign(u, HAZE)

/**
 * A soft dark ellipse under the car: grounds it even when real shadows are off (low tier)
 * or the sun is behind it. Cheap: one transparent quad.
 */
function contactShadow(): THREE.Mesh {
  const c = document.createElement("canvas")
  c.width = c.height = 128
  const g = c.getContext("2d")!
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64)
  grad.addColorStop(0, "rgba(0,0,0,0.62)")
  grad.addColorStop(0.55, "rgba(0,0,0,0.32)")
  grad.addColorStop(1, "rgba(0,0,0,0)")
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  const tex = new THREE.CanvasTexture(c)
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2.7, 5.6).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }),
  )
  mesh.renderOrder = 2
  return mesh
}

// ---- Road markings -------------------------------------------------------------------

function markingsTexture() {
  const c = document.createElement("canvas")
  c.width = 256
  c.height = 512
  const g = c.getContext("2d")!
  g.clearRect(0, 0, 256, 512)
  const px = (m: number) => ((m + ROAD_HALF) / (ROAD_HALF * 2)) * 256
  const r = rng(11)
  // Gravel shoulders outside the edge lines: speckled, lighter than the asphalt.
  for (const [a, b] of [[-ROAD_HALF, -5.45], [5.45, ROAD_HALF]]) {
    for (let k = 0; k < 2600; k++) {
      const x = px(a) + r() * (px(b) - px(a))
      const v = 120 + Math.floor(r() * 70)
      g.fillStyle = `rgba(${v},${v - 6},${v - 14},${0.35 + r() * 0.4})`
      g.fillRect(x, r() * 512, 1.6, 1.6)
    }
  }
  // Worn tyre tracks in each lane: slightly darker, polished strips.
  for (const lane of [-LANE, LANE])
    for (const wheel of [-0.78, 0.78]) {
      const c = px(lane + wheel)
      const grad = g.createLinearGradient(c - 9, 0, c + 9, 0)
      grad.addColorStop(0, "rgba(10,10,14,0)")
      grad.addColorStop(0.5, "rgba(10,10,14,0.16)")
      grad.addColorStop(1, "rgba(10,10,14,0)")
      g.fillStyle = grad
      g.fillRect(c - 9, 0, 18, 512)
    }
  g.fillStyle = "rgba(236, 232, 222, 0.92)"
  g.fillRect(px(-5.3) - 3, 0, 6, 512)
  g.fillRect(px(5.3) - 3, 0, 6, 512)
  g.fillStyle = "rgba(242, 190, 40, 0.95)"
  g.fillRect(px(-0.18) - 3, 0, 5, 300)
  g.fillRect(px(0.18) - 2, 0, 5, 300)
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 8
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

// ---- Shared world resources ----------------------------------------------------------

const CHUNK_SAMPLES = 32 // 128 m per chunk
const WATER_SIZE = 8000
const WATER_SEGMENTS = 96
/** Metres per ground texture tile. */
const GROUND_UV_M = 3.2
const CHUNK_LEN = CHUNK_SAMPLES * STEP
const BEHIND = 1
/** Cross-section offsets for the ground (negative = inland, positive = ocean side). */
/**
 * Cross-section offsets for the near ground (negative = inland, positive = ocean side).
 * Starts just under the asphalt edge (no gap). Inland it stops at 212 m, inside the
 * tightest bend radius (240 m) so strips never fold; the far-terrain ring takes over.
 */
const GROUND_OFFSETS = STRIP_OFFSETS // shared with the physics' terrain lookup


interface World {
  roadMat: THREE.MeshStandardMaterial
  markMat: THREE.MeshStandardMaterial
  groundMat: THREE.MeshStandardMaterial
  /** One kit per palm species (coconut, royal, fan). */
  palm: Kit[]
  /** Light code-built bushes (two shapes). */
  shrubs: Kit[]
  barrier: Kit
  grass: { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }
  /** A few broadleaf tree shapes (live oaks on the hills). */
  trees: Kit[]
  /** Textures referenced only from shader uniforms (not material slots). */
  extraTextures: THREE.Texture[]
  time: { value: number }
}

/** Vertex patch for the breeze: sway grows with height; instances get their own phase. */
function windPatch(height: number, flutter: number) {
  return `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3]);
        #else
          vec3 ip = vec3(0.0);
        #endif
        float hh = clamp(position.y / ${height.toFixed(1)}, 0.0, 1.2);
        float ph = ip.x * 0.07 + ip.z * 0.05;
        float sway = sin(uWindTime * 0.9 + ph) * 0.16 + sin(uWindTime * 2.1 + ph * 1.7) * 0.05;
        transformed.x += sway * hh * hh;
        transformed.z += cos(uWindTime * 0.7 + ph) * 0.09 * hh * hh;
        transformed.y += sin(uWindTime * 3.3 + position.z * 1.3 + ph) * ${flutter.toFixed(3)} * hh;`
}

/**
 * Sways vertices with height (palms and shrubs in the sea breeze). Instanced: phase from
 * position. Also builds a matching shadow-pass material, so shadows sway with the leaves.
 */
function addWind(mat: THREE.Material, time: { value: number }, height: number, flutter: number) {
  const patch = (target: THREE.Material, key: string) => {
    // Each variant compiles its own program (the callbacks share source text, so three's
    // default cache key would hand every material the first one).
    target.customProgramCacheKey = () => `${key}:${height}:${flutter}`
    target.onBeforeCompile = (shader) => {
      shader.uniforms.uWindTime = time
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uWindTime;")
        .replace("#include <begin_vertex>", windPatch(height, flutter))
    }
  }
  patch(mat, "wind")
  const src = mat as THREE.MeshStandardMaterial
  const depth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: src.map ?? null,
    alphaTest: src.alphaTest,
    side: src.side,
  })
  patch(depth, "wind-depth")
  mat.userData.windDepth = depth
}

/**
 * Ground: grass and sand photo textures blended by vertex colour (r = sand, g = brightness),
 * on world-space uvs, with the grass normal map for relief. Two rotated samples blended by a
 * slow macro pattern hide the texture repeating.
 */
function groundMaterial(sand: PbrSet, grass: PbrSet): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: grass.map,
    normalMap: grass.normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughnessMap: grass.arm,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  })
  mat.customProgramCacheKey = () => "ground-splat-3"
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSand = { value: sand.map }
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGroundView;")
      .replace("#include <fog_vertex>", "#include <fog_vertex>\nvGroundView = mvPosition.xyz;")
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uSand;\nvarying vec3 vGroundView;")
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
          vec2 uvA = vMapUv;
          // Scales chosen so a uv shift of 100 keeps every sample seamless (chunks rebase by
          // multiples of 100 to keep uvs small): 1.25·0.8, 1.25·0.6, 0.04, 0.03, 0.05, 0.8.
          vec2 uvB = mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 1.25 + vec2(0.31, 0.17);
          float macro = texture2D(map, vMapUv * 0.04).g;
          float pick = smoothstep(0.35, 0.65, texture2D(uSand, vMapUv * 0.03).r);
          vec3 grassC = mix(texture2D(map, uvA).rgb, texture2D(map, uvB).rgb, pick) * (0.72 + 0.6 * macro);
          grassC *= vec3(0.98, 1.12, 0.86);
          vec3 sandC = mix(texture2D(uSand, uvA * 0.8).rgb, texture2D(uSand, uvB).rgb, pick);
          sandC *= 0.85 + 0.3 * texture2D(uSand, vMapUv * 0.05).r;
          vec3 groundC = mix(grassC, sandC, vColor.r);
          // Steep banks: bare earth.
          vec3 earthC = mix(grassC, vec3(0.34, 0.25, 0.17), 0.75);
          groundC = mix(groundC, earthC, smoothstep(0.25, 0.55, vColor.b) * (1.0 - vColor.r));
          // Far away the photo texture just averages to mud: fade it into a soft macro
          // green with slow hue drift, which is what distant fields look like anyway.
          float farT = smoothstep(70.0, 420.0, length(vGroundView));
          float hue = texture2D(map, vMapUv * 0.01).g;
          vec3 macroGrass = mix(vec3(0.19, 0.33, 0.08), vec3(0.34, 0.46, 0.13), hue);
          vec3 macroC = mix(macroGrass, vec3(0.62, 0.52, 0.36), vColor.r);
          // Near the road the photo texture is mostly soil; blend in the macro green there too
          // (not on sand) so verges and hillsides read as grassland, not bare dirt.
          groundC = mix(groundC, macroC, max(farT, 0.45 * (1.0 - vColor.r)));
          diffuseColor.rgb *= groundC * vColor.g;
        #endif`,
      )
      .replace("#include <color_fragment>", "")
  }
  return mat
}

// ---- Chunks --------------------------------------------------------------------------

interface Chunk {
  index: number
  group: THREE.Group
  /** Obstacle circles (x, z, r triples) for the car's collisions. */
  colliders: Float32Array
}

/**
 * Scenery never moves once built: compute its world matrices once and tell three.js to
 * skip it in the per-frame matrix walk (hundreds of objects otherwise, every frame).
 */
function freeze(root: THREE.Object3D) {
  root.updateMatrixWorld(true)
  root.traverse((o) => {
    o.matrixAutoUpdate = false
    o.matrixWorldAutoUpdate = false
  })
}

/** Triangles in a geometry (indexed or not). */
const triCount = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute("position").count) / 3

function instance(group: THREE.Group, kit: Kit, mats: THREE.Matrix4[], castShadow = false, label = "props", collide = 0) {
  if (mats.length === 0) return
  if (collide > 0) {
    // Solid obstacle: a circle per instance at its base, radius scaled with the instance.
    const list = (group.userData.colliders ??= []) as number[]
    for (const m of mats) {
      const e = m.elements
      list.push(e[12], e[14], collide * Math.hypot(e[0], e[1], e[2]))
    }
  }
  for (const part of kit) {
    // Per-label triangle tally for the performance overlay.
    const tally = (group.userData.tris ??= {}) as Record<string, number>
    tally[label] = (tally[label] ?? 0) + triCount(part.geometry) * mats.length
    const im = new THREE.InstancedMesh(part.geometry, part.material, mats.length)
    mats.forEach((m, k) => im.setMatrixAt(k, m))
    im.castShadow = castShadow
    if (part.material.userData.windDepth) im.customDepthMaterial = part.material.userData.windDepth
    im.receiveShadow = true
    im.computeBoundingSphere()
    group.add(im)
  }
}

function buildChunk(road: Road, index: number, w: World, density: number): Chunk {
  const group = new THREE.Group()
  const i0 = index * CHUNK_SAMPLES
  road.ensure((i0 + CHUNK_SAMPLES + 2) * STEP)
  const rand = rng(1000 + index * 7919)
  const rows = CHUNK_SAMPLES + 1

  // Asphalt + markings ribbons.
  const ribbon = (lift: number, uScale: number, vScale: number, mat: THREE.Material, overlay = false) => {
    const pos = new Float32Array(rows * 2 * 3)
    const uv = new Float32Array(rows * 2 * 2)
    // Distance along the road, rebased by whole texture periods (keeps v small).
    const period = vScale * 64
    const vBase = Math.floor((i0 * STEP) / period) * period
    const idx: number[] = []
    for (let r = 0; r < rows; r++) {
      const i = i0 + r
      const [rx, rz] = rightOf(road.hs[i])
      for (let side = 0; side < 2; side++) {
        const off = side === 0 ? -ROAD_HALF : ROAD_HALF
        const v = r * 2 + side
        pos.set([road.xs[i] + rx * off, road.ys[i] + lift, road.zs[i] + rz * off], v * 3)
        uv.set([side * uScale, (i * STEP - vBase) / vScale], v * 2)
      }
      if (r < rows - 1) {
        const a = r * 2, b = a + 1, c = a + 2, d = a + 3
        idx.push(a, b, c, b, d, c)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3))
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2))
    geo.setIndex(idx)
    geo.computeVertexNormals()
    const mesh = new THREE.Mesh(geo, mat)
    mesh.receiveShadow = true
    if (overlay) mesh.renderOrder = 1
    group.add(mesh)
  }
  ribbon(0.02, 3, 4, w.roadMat)
  ribbon(0.03, 1, 24, w.markMat, true)

  // Ground strips either side. Positions are computed for one extra row before and after
  // the chunk, so normals at the chunk's edges match its neighbours (no seams).
  {
    const cols = GROUND_OFFSETS.length
    const ext = rows + 2 // rows -1 .. rows
    const P = new Float32Array(ext * cols * 3)
    for (let r = -1; r <= rows; r++) {
      const i = Math.max(0, i0 + r)
      const [rx, rz] = rightOf(road.hs[i])
      for (let c = 0; c < cols; c++) {
        const off = GROUND_OFFSETS[c]
        const x = road.xs[i] + rx * off
        const z = road.zs[i] + rz * off
        P.set([x, groundHeight(road.ys[i], off, x, z), z], ((r + 1) * cols + c) * 3)
      }
    }
    const at = (r: number, c: number, k: number) => P[((r + 1) * cols + c) * 3 + k]
    // Columns either side of the asphalt are not neighbours of each other.
    const firstOcean = GROUND_OFFSETS.findIndex((o) => o > 0)
    const sideMin = (c: number) => (c < firstOcean ? 0 : firstOcean)
    const sideMax = (c: number) => (c < firstOcean ? firstOcean - 1 : cols - 1)

    const pos = new Float32Array(rows * cols * 3)
    const nor = new Float32Array(rows * cols * 3)
    const col = new Float32Array(rows * cols * 3)
    const guv = new Float32Array(rows * cols * 2)
    // Rebase uvs by whole periods so they stay small (float precision) however far we drive.
    const uvBaseX = Math.floor(road.xs[i0] / GROUND_UV_M / 100) * 100
    const uvBaseZ = Math.floor(road.zs[i0] / GROUND_UV_M / 100) * 100
    const idx: number[] = []
    const tA = new THREE.Vector3(), tB = new THREE.Vector3(), n = new THREE.Vector3()
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const off = GROUND_OFFSETS[c]
        const x = at(r, c, 0), y = at(r, c, 1), z = at(r, c, 2)
        const v = r * cols + c
        pos.set([x, y, z], v * 3)
        // Normal from neighbours: across the strip and along the road.
        const c0 = Math.max(sideMin(c), c - 1), c1 = Math.min(sideMax(c), c + 1)
        tA.set(at(r, c1, 0) - at(r, c0, 0), at(r, c1, 1) - at(r, c0, 1), at(r, c1, 2) - at(r, c0, 2))
        tB.set(at(r + 1, c, 0) - at(r - 1, c, 0), at(r + 1, c, 1) - at(r - 1, c, 1), at(r + 1, c, 2) - at(r - 1, c, 2))
        n.crossVectors(tA, tB).normalize()
        if (n.y < 0) n.negate()
        nor.set([n.x, n.y, n.z], v * 3)
        guv.set([x / GROUND_UV_M - uvBaseX, z / GROUND_UV_M - uvBaseZ], v * 2)
        let sand: number, bright: number
        if (Math.abs(off) < 10) {
          sand = 0.6
          bright = 0.85 // dusty shoulder
        } else if (off > 0) {
          sand = 1 - Math.max(0, Math.min(1, (y - 3.5) / 3))
          bright = y < 0.4 ? 0.62 : 1 // wet sand at the waterline
        } else {
          sand = Math.max(0, Math.sin(x * 0.013) * Math.cos(z * 0.011) * 0.5) * (1 - Math.min(1, -off / 200))
          bright = 0.88 + Math.sin(x * 0.02 + z * 0.015) * 0.12
        }
        // b = slope (0 flat .. 1 vertical): bare earth on steep banks.
        col.set([sand, bright, 1 - n.y], v * 3)
        if (r < rows - 1 && c < cols - 1 && !(GROUND_OFFSETS[c] < 0 && GROUND_OFFSETS[c + 1] > 0)) {
          const a = v, b = v + 1, cc = v + cols, d = v + cols + 1
          idx.push(a, b, cc, b, d, cc)
        }
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3))
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3))
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3))
    geo.setAttribute("uv", new THREE.BufferAttribute(guv, 2))
    geo.setIndex(idx)
    const ground = new THREE.Mesh(geo, w.groundMat)
    ground.receiveShadow = true
    group.add(ground)
    // Skirt: a strip hanging 30 m down from the inland edge, so the seam where this near
    // ground meets the coarser far terrain never shows a gap (visible when off-roading).
    {
      const sp = new Float32Array(rows * 2 * 3)
      const sn = new Float32Array(rows * 2 * 3)
      const sc = new Float32Array(rows * 2 * 3)
      const su = new Float32Array(rows * 2 * 2)
      const sidx: number[] = []
      for (let r = 0; r < rows; r++) {
        const [rx, rz] = rightOf(road.hs[i0 + r])
        for (let k = 0; k < 2; k++) {
          const v = r * 2 + k
          sp.set([at(r, 0, 0), at(r, 0, 1) - k * 30, at(r, 0, 2)], v * 3)
          sn.set([-rx, 0, -rz], v * 3)
          sc.set([col[r * cols * 3], col[r * cols * 3 + 1], col[r * cols * 3 + 2]], v * 3)
          su.set([guv[r * cols * 2], guv[r * cols * 2 + 1] + k * 9], v * 2)
        }
        if (r < rows - 1) {
          const a = r * 2, b = a + 1, c = a + 2, d = a + 3
          sidx.push(a, c, b, b, c, d)
        }
      }
      const sg = new THREE.BufferGeometry()
      sg.setAttribute("position", new THREE.BufferAttribute(sp, 3))
      sg.setAttribute("normal", new THREE.BufferAttribute(sn, 3))
      sg.setAttribute("color", new THREE.BufferAttribute(sc, 3))
      sg.setAttribute("uv", new THREE.BufferAttribute(su, 2))
      sg.setIndex(sidx)
      const skirt = new THREE.Mesh(sg, w.groundMat)
      skirt.receiveShadow = true
      group.add(skirt)
    }
  }

  const q = new THREE.Quaternion()
  const s3 = new THREE.Vector3()
  const p3 = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const at = (iFloat: number, off: number) => placeOnStrip(road, i0, iFloat, off)
  const mat = (x: number, y: number, z: number, yaw: number, scale: number) =>
    new THREE.Matrix4().compose(p3.set(x, y, z), q.setFromAxisAngle(up, yaw), s3.setScalar(scale))

  // Palms: a promenade row of coconut and royal palms by the beach, a mix inland (fan palms
  // stand tall behind). Species per tree from the chunk's own random sequence.
  {
    const per: THREE.Matrix4[][] = w.palm.map(() => [])
    for (let k = 0; k < CHUNK_LEN / 16; k++) {
      const p = at(i0 + (k * 16 + rand() * 6) / STEP, 10.5 + rand() * 3)
      const sp = rand() < 0.7 ? 0 : 1 // coconut or royal by the beach
      per[sp].push(mat(p.x, p.y - 0.2, p.z, rand() * Math.PI * 2, 0.85 + rand() * 0.3))
    }
    const extra = Math.round((12 + Math.floor(rand() * 12)) * density)
    for (let k = 0; k < extra; k++) {
      const beach = rand() < 0.35
      const off = beach ? 16 + rand() * 30 : -(10 + rand() * 120)
      const p = at(i0 + rand() * CHUNK_SAMPLES, off)
      if (p.y < 0.5) continue
      const sp = beach ? (rand() < 0.8 ? 0 : 1) : Math.floor(rand() * w.palm.length)
      per[sp].push(mat(p.x, p.y - 0.2, p.z, rand() * Math.PI * 2, 0.8 + rand() * 0.4))
    }
    w.palm.forEach((kit, i) => instance(group, kit, per[i], true, "palms", 0.32))
  }

  // Bushes: thick along the inland verge, sparse on the dunes (cheap code-built shapes).
  if (w.shrubs.length) {
    const per: THREE.Matrix4[][] = w.shrubs.map(() => [])
    const n = Math.round((22 + Math.floor(rand() * 14)) * density)
    for (let k = 0; k < n; k++) {
      const inland = rand() < 0.75
      const off = inland ? -(8 + rand() * rand() * 70) : 12 + rand() * 26
      const p = at(i0 + rand() * CHUNK_SAMPLES, off)
      if (p.y < 0.6) continue
      per[Math.floor(rand() * per.length)].push(mat(p.x, p.y - 0.1, p.z, rand() * Math.PI * 2, 0.8 + rand() * 0.9))
    }
    w.shrubs.forEach((kit, i) => instance(group, kit, per[i], false, "bushes"))
  }

  // Broadleaf trees inland, in clumps (a slow noise decides where the woods are).
  if (w.trees.length) {
    const per: THREE.Matrix4[][] = w.trees.map(() => [])
    const n = Math.round((20 + rand() * 18) * density)
    for (let k = 0; k < n; k++) {
      const off = -(20 + rand() * 180)
      const p = at(i0 + rand() * CHUNK_SAMPLES, off)
      const woods = Math.sin(p.x * 0.006 + 1.7) * Math.cos(p.z * 0.0051 - 0.4) + Math.sin(p.x * 0.017 - p.z * 0.013) * 0.4
      if (woods < -0.15 || p.y < 1.2) continue
      per[Math.floor(rand() * per.length)].push(mat(p.x, p.y - 0.15, p.z, rand() * Math.PI * 2, 0.75 + rand() * 0.6))
    }
    w.trees.forEach((kit, i) => instance(group, kit, per[i], true, "trees", 0.42))
  }

  // Concrete barriers on the sea side through bends.
  {
    const bend = Math.abs(road.hs[i0 + CHUNK_SAMPLES] - road.hs[i0])
    if (bend > 0.12 && w.barrier.length) {
      const mats: THREE.Matrix4[] = []
      for (let d = 0; d < CHUNK_LEN; d += 1.6) {
        const p = at(i0 + d / STEP, ROAD_HALF + 0.6)
        mats.push(mat(p.x, p.y, p.z, p.heading + Math.PI / 2, 1))
      }
      instance(group, w.barrier, mats, false, "barriers", 0.55)
    }
  }

  return { index, group, colliders: new Float32Array((group.userData.colliders ?? []) as number[]) }
}

/**
 * A point `off` metres beside the road at fractional sample `iFloat` (interpolated along
 * the road, so props don't line up in 4 m rows), with its height taken from the strip
 * mesh itself (linear between the two ground columns either side, like the triangles),
 * so things sit on the visible ground instead of the exact terrain function.
 */
function placeOnStrip(road: Road, i0: number, iFloat: number, off: number) {
  const f = Math.min(i0 + CHUNK_SAMPLES - 1e-6, Math.max(i0, iFloat))
  const i = Math.floor(f), t = f - i
  const heading = road.hs[i] + (road.hs[i + 1] - road.hs[i]) * t
  const [rx, rz] = rightOf(heading)
  const cx = road.xs[i] + (road.xs[i + 1] - road.xs[i]) * t
  const cz = road.zs[i] + (road.zs[i + 1] - road.zs[i]) * t
  const roadY = road.ys[i] + (road.ys[i + 1] - road.ys[i]) * t
  // Bracketing ground columns on this side of the road.
  let c = 0
  while (c < GROUND_OFFSETS.length - 2 && GROUND_OFFSETS[c + 1] <= off) c++
  const o0 = GROUND_OFFSETS[c], o1 = GROUND_OFFSETS[c + 1]
  const sameSide = Math.sign(o0) === Math.sign(o1)
  const u = sameSide ? Math.min(1, Math.max(0, (off - o0) / (o1 - o0))) : 0
  const h0 = groundHeight(roadY, o0, cx + rx * o0, cz + rz * o0)
  const h1 = sameSide ? groundHeight(roadY, o1, cx + rx * o1, cz + rz * o1) : h0
  const y = sameSide ? h0 + (h1 - h0) * u : groundHeight(roadY, off, cx + rx * off, cz + rz * off)
  return { x: cx + rx * off, z: cz + rz * off, y, heading }
}

function disposeChunk(chunk: Chunk) {
  chunk.group.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) o.dispose()
    else if (o instanceof THREE.Mesh) {
      if (!o.geometry.userData.shared) o.geometry.dispose()
      if (o.userData.perChunk) (o.material as THREE.Material).dispose()
    }
  })
}

// ---- The drive -----------------------------------------------------------------------

export type CameraMode = "chase" | "hood" | "cinematic" | "flyby"
const CAMERA_MODES: CameraMode[] = ["chase", "hood", "cinematic", "flyby"]
/** Shots the wallpaper director cycles through when nobody is touching the keys. */
const DIRECTOR: CameraMode[] = ["chase", "cinematic", "flyby", "chase", "flyby", "cinematic"]

export interface DriveInput {
  throttle: boolean
  brake: boolean
  left: boolean
  right: boolean
  boost: boolean
}

export interface DriveFrame {
  speedKmh: number
  autopilot: boolean
  distanceKm: number
  time: TimeOfDay
  camera: CameraMode
  director: boolean
  /** Frames stay slow even at the lowest resolution for this tier. */
  struggling: boolean
}

interface SkyState {
  tex: THREE.DataTexture
  env: THREE.WebGLRenderTarget
  sunDir: THREE.Vector3
  sunColor: THREE.Color
  exposure: number
  horizon: THREE.Color
}

export class DriveEngine {
  private renderer: THREE.WebGLRenderer
  private composer: EffectComposer
  private bloom: UnrealBloomPass
  private grade: ShaderPass
  private fxaa: ShaderPass
  private pmrem: THREE.PMREMGenerator
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private road: Road
  private chunks = new Map<number, Chunk>()
  private world: World | null = null
  private far: FarTerrain | null = null
  /** Grass in a field around the car, wherever it is (Slow Roads style). */
  private grassField: GrassField | null = null
  private car: Coupe
  /** Use the heavy Datsun (public/drive/car.glb) instead of the built-in coupe. */
  private classicCar = false
  private userCar: UserCar | null = null
  /** Soft shadow under the car: kept flat on the road, not rolled with the body. */
  private shadowQuad: THREE.Mesh
  private water: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  private sun = new THREE.DirectionalLight()
  /** Soft sky-from-above, grass-from-below fill so backlit hills never go black. */
  private fill = new THREE.HemisphereLight()
  private fog: THREE.Fog
  private sky: SkyState | null = null
  private skyCache = new Map<TimeOfDay, Promise<SkyState>>()
  /** Loaded skies (resolved entries of skyCache), so they can be freed synchronously. */
  private skyStates = new Map<TimeOfDay, SkyState>()
  /** A sky replaced by a reload at another resolution, freed once its successor shows. */
  private retiredSky: SkyState | null = null
  private look: Look = LOOKS.sunset
  private fade = 0 // 0 black .. 1 full picture
  private fadeTarget = 1
  private pendingSky: { time: TimeOfDay; state: SkyState } | null = null

  /**
   * Distance along the road. The drive starts 20 km in, so there is a long road behind as
   * well as ahead (the road is generated from its start; the world is seeded, so any
   * stretch can be rebuilt identically whenever the car comes back to it).
   */
  private s = 20000
  private speed = 0
  /** Distance actually driven (the road position can go backwards). */
  private odometer = 0
  /** The car's physics (grip, suspension, terrain) and the controls fed to it each frame. */
  private phys: CarPhysics
  private ctl: DriveControls = { throttle: 0, brake: 0, steer: 0, boost: false, handbrake: false }
  /** A second terrain lookup for things other than the car (it keeps its own walk hint). */
  private ground: TerrainQuery
  /** Obstacles the car can hit (trunks, poles, barriers), from the chunks around it. */
  private colliders = new ColliderSet()
  /** 0..1: headlights fade on at dusk and off at dawn. */
  private headlightsOn = 0
  /** Tail-light brightness when not braking (set with the time of day). */
  private tailBase = 1
  private userTailBase = 1
  private autopilot = true
  private cruise = 25 // m/s ≈ 90 km/h
  private time: TimeOfDay = "sunset"
  private cameraMode: CameraMode = "chase"
  private elapsed = 0
  private idle = 0
  private wallpaper = true
  private directorOn = false
  private directorShot = 0
  private directorClock = 0
  private flybyAt: THREE.Vector4 | null = null
  private camPos = new THREE.Vector3()
  private tmpFwd = new THREE.Vector3()
  private tmpDesired = new THREE.Vector3()
  private tmpLook = new THREE.Vector3()
  private camSample: RoadSample = { x: 0, y: 0, z: 0, heading: 0 }
  private covered = { from: 0, to: 0 }
  private static UP = new THREE.Vector3(0, 1, 0)
  private camLook = new THREE.Vector3()
  private sample: RoadSample = { x: 0, y: 0, z: 0, heading: 0 }
  private disposed = false
  readonly ready: Promise<void>

  // Quality and the frame-time governor.
  private qualitySetting: QualitySetting
  private quality: Quality
  private profile: QualityProfile
  private dpr = 1
  private frameEma = 1 / 60
  private governorClock = 0
  private frameJitter = 0
  private goodSeconds = 0
  private frameCap = 0
  private frameNo = 0
  private slowSeconds = 0
  private upBlockedUntil = 0
  private slowFor = 0
  private width = 0
  private height = 0
  private userCarLoad: Promise<UserCar | null> | null = null

  private carColor: string

  constructor(
    canvas: HTMLCanvasElement,
    seed: number,
    quality: QualitySetting = "auto",
    car: { color?: string; classic?: boolean } = {},
  ) {
    this.carColor = car.color ?? "#f2f2f0"
    this.classicCar = car.classic ?? false
    // Antialiasing is fixed at creation: decide it from the starting tier.
    // The picture is drawn through post-processing targets, so antialiasing is done there
    // (multisampled targets), not on the canvas.
    const probe = canvas.getContext("webgl2", { antialias: false, alpha: false, stencil: false, powerPreference: "high-performance" })
    const guessed = probe ? guessQuality(probe) : "low"
    this.qualitySetting = quality
    this.quality = quality === "auto" ? guessed : quality
    this.profile = PROFILES[this.quality]
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context: probe ?? undefined,
      antialias: false,
      powerPreference: "high-performance",
    })
    this.dpr = Math.min(window.devicePixelRatio, this.profile.maxDpr)
    this.renderer.setPixelRatio(this.dpr)
    // Neutral keeps hues (ACES shifted the greens towards olive and crushed them).
    this.renderer.toneMapping = THREE.NeutralToneMapping
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // The shadow map is redrawn every other frame (see frame()): half the shadow cost,
    // and at driving speed the difference isn't visible.
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.info.autoReset = false
    this.pmrem = new THREE.PMREMGenerator(this.renderer)

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.3, 6000)
    this.road = new Road(seed)
    this.ground = new TerrainQuery(this.road)
    this.phys = new CarPhysics(new TerrainQuery(this.road))
    this.phys.colliders = this.colliders
    {
      const start = this.road.sample(this.s)
      const [rx, rz] = rightOf(start.heading)
      this.phys.reset(start.x + rx * LANE, start.z + rz * LANE, start.heading, 0)
    }
    // Scene fog only supplies the colour (and turns fog on in shaders); the haze maths is ours.
    this.fog = new THREE.Fog(new THREE.Color("#c77a6a"), 1, 2)
    this.scene.fog = this.fog

    this.sun.castShadow = this.profile.shadows
    this.sun.shadow.mapSize.set(this.profile.shadowSize, this.profile.shadowSize)
    const sc = this.sun.shadow.camera
    sc.left = -48
    sc.right = 48
    sc.top = 48
    sc.bottom = -48
    sc.near = 1
    sc.far = 500
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.04
    this.scene.add(this.sun, this.sun.target, this.fill)

    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE, WATER_SEGMENTS, WATER_SEGMENTS).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        vertexShader: WATER_VERT,
        fragmentShader: WATER_FRAG,
        fog: true,
        uniforms: withHaze(THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            uEnv: { value: null },
            uEnvIntensity: { value: 1 },
            uDeep: { value: new THREE.Color() },
            uSun: { value: 1 },
            uSunDir: { value: new THREE.Vector3(0, 1, 0) },
            uTime: { value: 0 },
          },
        ])),
      }),
    )
    this.scene.add(this.water)

    this.car = buildCoupe(this.carColor)
    this.shadowQuad = contactShadow()
    hazeObject(this.shadowQuad)
    this.scene.add(this.shadowQuad)
    hazeObject(this.car.group)
    this.scene.add(this.car.group)

    this.composer = new EffectComposer(this.renderer)
    this.setMsaa(this.profile.msaa)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.3, 0.4, 4)
    // Cap what feeds the glow: a sun glint on the car's clearcoat can be hundreds of times
    // brighter than white, and the glow's low-resolution layers then draw it as a square.
    const highPass = this.bloom.materialHighPassFilter
    highPass.uniforms.uBloomMax = { value: 4 }
    highPass.fragmentShader = highPass.fragmentShader
      .replace("void main() {", "uniform float uBloomMax;\nvoid main() {")
      .replace("gl_FragColor = mix( outputColor, texel, alpha );", "gl_FragColor = min( mix( outputColor, texel, alpha ), vec4( uBloomMax ) );")
    highPass.needsUpdate = true
    this.bloom.enabled = this.profile.bloom
    this.composer.addPass(this.bloom)
    this.grade = new ShaderPass(FinalShader)
    this.composer.addPass(this.grade)
    // Cheap edge smoothing when there's no multisampling (Low): after the final pass, so it
    // works on display colours.
    this.fxaa = new ShaderPass(FXAAShader)
    this.fxaa.enabled = this.profile.msaa === 0
    this.composer.addPass(this.fxaa)

    this.placeCar(0)
    this.camPos.copy(this.car.group.position).add(new THREE.Vector3(0, 3, -9))
    this.ready = this.init()
  }

  private async init() {
    const time = { value: 0 }
    const startTime = this.time
    const [sand, grass, bark, asphalt, barrierKits, sky] = await Promise.all([
      loadPbr("coast_sand_01"),
      loadPbr("sparse_grass"),
      loadPbr("palm_tree_bark"),
      loadPbr("asphalt_02"),
      loadKit("concrete_road_barrier").catch(() => [[]] as Kit[]),
      this.loadSky(startTime),
    ])
    if (this.disposed) return

    // Palms: three species built in code (palms.ts); bark texture on the trunks.
    const palmMats = palmMaterials()
    palmMats.trunk.map = bark.map
    palmMats.trunk.normalMap = bark.normalMap
    palmMats.trunk.roughnessMap = bark.arm
    addWind(palmMats.trunk, time, 12, 0)
    addWind(palmMats.crown, time, 12, 0.04)
    const palms: Kit[] = PALM_SPECIES.map((sp, i) => {
      const g = palmGeometry(sp, 101 + i * 37)
      return [
        { geometry: g.trunk, material: palmMats.trunk },
        { geometry: g.crown, material: palmMats.crown },
      ]
    })

    // Bushes: two code-built shapes sharing a foliage material.
    const bushMat = treeMaterials(time).canopy
    const bushes: Kit[] = [7, 19].map((seed) => [{ geometry: bushGeometry(seed), material: bushMat }])

    const roadMat = new THREE.MeshStandardMaterial({
      map: asphalt.map,
      normalMap: asphalt.normalMap,
      roughnessMap: asphalt.arm,
      aoMap: asphalt.arm,
      roughness: 1,
      metalness: 0,
    })
    const markMat = new THREE.MeshStandardMaterial({
      map: markingsTexture(),
      transparent: true,
      roughness: 0.55,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      depthWrite: false,
    })

    this.world = {
      roadMat,
      markMat,
      groundMat: groundMaterial(sand, grass),
      palm: palms,
      shrubs: bushes,
      barrier: barrierKits[0] ?? [],
      grass: { geometry: grassCardGeometry(), material: grassMaterial(time) },
      trees: (() => {
        const mats = treeMaterials(time)
        return [11, 37].map((seed) => {
          const g = broadleafTreeGeometry(seed)
          return [
            { geometry: g.trunk, material: mats.trunk },
            { geometry: g.canopy, material: mats.canopy },
          ]
        })
      })(),
      extraTextures: [sand.map, sand.normalMap, sand.arm, grass.arm, bark.arm, asphalt.arm],
      time,
    }
    // The user may already have picked another time while the world loaded.
    if (this.pendingSky) this.freeSkies(this.pendingSky.state)
    else {
      this.look = LOOKS[startTime]
      this.applySky(sky)
    }
    // The far ring: world-space hills out to the horizon, with painted-in distant forests.
    this.far = new FarTerrain({
      material: this.world.groundMat,
      n: this.profile.farN,
      trees: this.profile.farTrees,
      impostorGeometry: impostorGeometry(),
      impostorMaterial: impostorMaterial(),
    })
    hazeObject(this.far.object)
    this.scene.add(this.far.object)
    // Grass: one field around the car, built from world cells (same grass when you return).
    this.grassField = new GrassField({
      geometry: this.world.grass.geometry,
      material: this.world.grass.material,
      query: new TerrainQuery(this.road),
      cell: 24,
      radius: this.profile.grassRadius,
      perCell: this.profile.grass,
    })
    hazeObject(this.grassField.mesh)
    this.scene.add(this.grassField.mesh)
    // Build the first stretch up front, so the drive opens on a finished world.
    const current = Math.floor(this.s / CHUNK_LEN)
    for (let i = Math.max(0, current - BEHIND); i <= current + this.profile.ahead; i++) this.addChunk(i)

    this.syncCar()
  }

  /** The built-in coupe, or the heavy Datsun (car.glb) if chosen and present. */
  private syncCar() {
    if (!this.classicCar) {
      if (this.userCar) {
        this.scene.remove(this.userCar.group)
        this.car.group.add(this.car.beam, this.car.beam.target)
        this.scene.add(this.car.group)
        this.userCar = null
        this.placeCar(0)
      }
      return
    }
    this.userCarLoad ??= loadUserCar()
    void this.userCarLoad.then((car) => {
      if (!car || this.disposed || !this.classicCar || this.userCar === car) return
      this.scene.remove(this.car.group)
      // Keep the built-in headlight beam on the new car.
      car.group.add(this.car.beam, this.car.beam.target)
      this.userCar = car
      hazeObject(car.group)
      this.scene.add(car.group)
      if (this.sky) this.applySky(this.sky)
      this.placeCar(0)
    })
  }

  /**
   * Loads a sky. Only the one on screen is kept: any other loaded sky is freed as soon as
   * a new one is showing (or when it was superseded before it got there).
   * Background and water use the sky at the tier's resolution (2k max: the background is
   * turned into a cube map of half its height); lighting (PMREM) is built from a 1k copy,
   * which is plenty for blurred reflections and a fraction of the memory.
   */
  private loadSky(time: TimeOfDay): Promise<SkyState> {
    let p = this.skyCache.get(time)
    if (!p) {
      const downscale = this.profile.skyDownscale
      p = loadHdr(time).then((raw) => {
        if (this.disposed) {
          raw.dispose()
          throw new Error("disposed")
        }
        const width = (raw.image as unknown as { width: number }).width
        const tex = downscale > 1 ? downscaleHdr(raw, downscale) : raw
        if (tex !== raw) raw.dispose()
        const { sunDir, sunColor, horizon } = analyseSky(tex)
        if (sunDir.y < 0.02) sunDir.set(0.35, 0.75, 0.25).normalize() // sun set: light from the sky dome
        const look = LOOKS[time]
        const lum = Math.max(1e-4, 0.2126 * horizon.r + 0.7152 * horizon.g + 0.0722 * horizon.b)
        const exposure = THREE.MathUtils.clamp(look.key / lum, 0.02, 4)
        const lightFactor = Math.max(1, Math.round(width / downscale / 1024))
        const small = lightFactor > 1 ? downscaleHdr(tex, lightFactor) : tex
        const env = this.pmrem.fromEquirectangular(small)
        if (small !== tex) small.dispose()
        // Frees the generator's working target until the next sky.
        this.pmrem.dispose()
        const state: SkyState = { tex, env, sunDir, sunColor, exposure, horizon }
        this.skyStates.set(time, state)
        return state
      })
      p.catch(() => {
        // A failed (or abandoned) load can be retried later.
        if (this.skyCache.get(time) === p) this.skyCache.delete(time)
      })
      this.skyCache.set(time, p)
    }
    return p
  }

  /** Frees every loaded sky except `keep` (and one that's about to be shown). */
  private freeSkies(keep: SkyState | null) {
    for (const [t, state] of this.skyStates) {
      // Keep the one on screen, the one about to be, and the one for the time just picked.
      if (state === keep || state === this.pendingSky?.state || t === this.time) continue
      this.skyStates.delete(t)
      this.skyCache.delete(t)
      state.tex.dispose()
      state.env.dispose()
    }
  }

  private applySky(state: SkyState) {
    this.sky = state
    const L = this.look
    const e = state.exposure
    this.scene.background = state.tex
    this.scene.environment = state.env.texture
    this.scene.environmentIntensity = L.env
    this.grade.uniforms.uExposure.value = e
    this.fog.color.copy(state.horizon)
    HAZE.uHazeDensity.value = L.haze
    HAZE.uHazeSunDir.value.copy(state.sunDir)
    // Glow towards the sun: the horizon's brightness in the sun's (tinted) colour.
    const hLum = 0.2126 * state.horizon.r + 0.7152 * state.horizon.g + 0.0722 * state.horizon.b
    HAZE.uHazeSunColor.value.copy(state.sunColor).lerp(L.sunTint, L.sunTintMix).multiplyScalar(hLum * 1.8)
    // Fill: the sky's horizon colour from above, a warm grass bounce from below.
    const hPeak = Math.max(state.horizon.r, state.horizon.g, state.horizon.b, 1e-4)
    this.fill.color.copy(state.horizon).multiplyScalar(1 / hPeak)
    this.fill.groundColor.set("#6b7a3a").lerp(this.fill.color, 0.25)
    this.fill.intensity = L.fill / e
    this.sun.color.copy(state.sunColor).lerp(L.sunTint, L.sunTintMix)
    this.sun.intensity = L.sun / e
    // Foliage translucency follows the sun (and the moon at night).
    FOLIAGE.uFolSunDir.value.copy(state.sunDir)
    FOLIAGE.uFolSunColor.value.copy(this.sun.color).multiplyScalar(this.sun.intensity)
    this.sun.castShadow = this.profile.shadows && L.sun > 0.6 && state.sunDir.y > 0.05
    const wu = this.water.material.uniforms
    wu.uEnv.value = state.tex
    ;(wu.uDeep.value as THREE.Color).copy(L.water).multiplyScalar(0.35 / e)
    wu.uSun.value = L.sun / 3 / e
    ;(wu.uSunDir.value as THREE.Vector3).copy(state.sunDir)
    // Bloom only what ends up brighter than white after exposure (the scene is HDR here).
    this.bloom.threshold = 1.1 / e
    this.bloom.materialHighPassFilter.uniforms.uBloomMax.value = 3 / e
    this.bloom.strength = L.bloom
    this.grade.uniforms.uSaturation.value = L.saturation
    this.grade.uniforms.uContrast.value = L.contrast
    ;(this.grade.uniforms.uTint.value as THREE.Color).copy(L.tint)
    // Headlights/tail lights are driven per frame (auto on/off, brake lights); here only
    // their exposure-dependent bases.
    this.tailBase = glow(this.car.tail.emissive, 0.35 + L.lamps * 0.9, e)
    this.userTailBase = (0.25 + L.lamps * 0.9) / e
    this.freeSkies(state)
  }

  resize(width: number, height: number) {
    if (width <= 0 || height <= 0) return
    this.width = width
    this.height = height
    this.renderer.setPixelRatio(this.dpr)
    this.renderer.setSize(width, height, false)
    // The composer keeps its own size (it starts at the canvas's 300×150 default): set both.
    this.composer.setPixelRatio(this.dpr)
    this.composer.setSize(width, height)
    ;(this.fxaa.uniforms.resolution.value as THREE.Vector2).set(1 / (width * this.dpr), 1 / (height * this.dpr))
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  /** A deliberate frame cap (0 = none): the resolution governor then aims for that rate. */
  setFrameCap(fps: number) {
    this.frameCap = fps > 0 ? fps : 0
    this.goodSeconds = 0
    this.slowFor = 0
  }

  /** Paint colour of the built-in coupe. */
  setCarColor(hex: string) {
    this.carColor = hex
    this.car.setColor(hex)
  }

  /** True when the detailed Datsun is actually on screen (car.glb found and loaded). */
  get classicShowing() {
    return this.userCar !== null
  }

  /** Switch between the built-in coupe and the detailed Datsun (if car.glb exists). */
  setClassicCar(on: boolean) {
    this.classicCar = on
    this.syncCar()
  }

  /** Quality tier: "auto" starts from a GPU guess and steps down if frames stay slow. */
  setQuality(setting: QualitySetting) {
    this.qualitySetting = setting
    this.applyQuality(setting === "auto" ? this.quality : setting)
  }

  get qualityInfo() {
    return { setting: this.qualitySetting, active: this.quality, resolution: this.dpr }
  }

  private setMsaa(samples: number) {
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (rt.samples === samples) continue
      rt.samples = samples
      rt.dispose() // reallocated with the new sample count on next use
    }
  }

  private applyQuality(q: Quality) {
    const before = this.profile
    this.quality = q
    this.profile = PROFILES[q]
    this.dpr = THREE.MathUtils.clamp(this.dpr, this.profile.minDpr, this.profile.maxDpr)
    this.resize(this.width, this.height)
    this.bloom.enabled = this.profile.bloom
    this.setMsaa(this.profile.msaa)
    this.fxaa.enabled = this.profile.msaa === 0
    if (before.shadowSize !== this.profile.shadowSize) {
      this.sun.shadow.mapSize.set(this.profile.shadowSize, this.profile.shadowSize)
      this.sun.shadow.map?.dispose()
      this.sun.shadow.map = null
    }
    if (this.sky) this.applySky(this.sky)
    if (before.skyDownscale !== this.profile.skyDownscale) {
      // Reload the current sky at the new resolution; it swaps in through the usual fade.
      const time = this.time
      this.skyCache.delete(time)
      this.skyStates.forEach((st, t) => {
        if (st !== this.sky) {
          this.skyStates.delete(t)
          st.tex.dispose()
          st.env.dispose()
        }
      })
      if (this.sky) for (const [t, st] of this.skyStates) if (st === this.sky) this.skyStates.delete(t)
      const onScreen = this.sky
      void this.loadSky(time)
        .then((state) => {
          if (this.disposed || this.time !== time) return
          this.pendingSky = { time, state }
          this.fadeTarget = 0
          // The old-resolution sky is no longer tracked; free it once the new one shows.
          if (onScreen) this.retiredSky = onScreen
        })
        .catch(() => {})
    }
    if (before.density !== this.profile.density) {
      // Rebuild the scenery around the car at the new density.
      for (const [i, chunk] of this.chunks) {
        this.scene.remove(chunk.group)
        disposeChunk(chunk)
        this.colliders.remove(i)
      }
      this.chunks.clear()
      const current = Math.floor(this.s / CHUNK_LEN)
      for (let i = Math.max(0, current - BEHIND); i <= current + this.profile.ahead; i++) this.addChunk(i)
    }
    if (this.grassField && (before.grass !== this.profile.grass || before.grassRadius !== this.profile.grassRadius)) {
      this.scene.remove(this.grassField.mesh)
      this.grassField.setDensity(this.profile.grass, this.profile.grassRadius)
      hazeObject(this.grassField.mesh)
      this.scene.add(this.grassField.mesh)
    }
    this.far?.setDetail(this.profile.farN, this.profile.farTrees)
    if (this.far) hazeObject(this.far.object)
    this.syncCar()
  }

  /**
   * Keeps the frame rate up: render resolution steps down when frames are slow, and only
   * climbs back after several good seconds (and not straight after a drop), so it settles
   * instead of flickering between two sizes. On "auto", a tier that stays slow even at its
   * lowest resolution steps down — unless the frames are locked to a steady 30 fps, which
   * means the display or Low Power Mode is capping the frame rate, not the GPU struggling.
   */
  private govern(dt: number) {
    this.frameEma += (dt - this.frameEma) * 0.05
    this.frameJitter += (Math.abs(dt - this.frameEma) - this.frameJitter) * 0.05
    this.governorClock += dt
    if (this.governorClock < 1) return
    this.governorClock = 0
    const p = this.profile
    const top = Math.min(p.maxDpr, window.devicePixelRatio)
    // Budget: 60 fps normally, or the user's chosen cap.
    const target = this.frameCap || 60
    const slow = this.frameEma > 1 / (target * 0.75)
    const good = this.frameEma < 1 / (target * 0.95)
    // A steady 30 fps is a display or Low Power Mode cap, not the GPU struggling.
    const capped = (this.frameCap === 0 || this.frameCap > 30) && Math.abs(this.frameEma - 1 / 30) < 0.0015 && this.frameJitter < 0.002
    const atFloor = this.dpr <= p.minDpr + 1e-3
    this.slowSeconds = this.frameEma > 1 / (target * 0.47) && atFloor && !capped ? this.slowSeconds + 1 : 0

    // Sharpness comes last: on "auto", shed effects (a lower tier) before resolution;
    // resolution only drifts down within the tier's floor, which stays crisp.
    if (slow && !capped && this.qualitySetting === "auto" && this.quality !== "low") {
      this.slowFor++
      if (this.slowFor >= 3) {
        this.slowFor = 0
        this.goodSeconds = 0
        this.upBlockedUntil = this.elapsed + 15
        this.applyQuality(this.quality === "high" ? "medium" : "low")
      }
      return
    }
    this.slowFor = 0
    if (slow && !capped && this.dpr > p.minDpr) {
      this.dpr = Math.max(p.minDpr, this.dpr - 0.1)
      this.upBlockedUntil = this.elapsed + 15
      this.goodSeconds = 0
      this.resize(this.width, this.height)
    } else if (good) {
      this.goodSeconds++
      if (this.goodSeconds >= 3 && this.elapsed > this.upBlockedUntil && this.dpr < top) {
        this.dpr = Math.min(top, this.dpr + 0.05)
        this.goodSeconds = 0
        this.resize(this.width, this.height)
      }
    } else this.goodSeconds = 0
  }

  /** Numbers for the on-screen performance overlay (P). */
  get stats() {
    const info = this.renderer.info
    return {
      fps: 1 / Math.max(1e-3, this.frameEma),
      frameMs: this.frameEma * 1000,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      resolution: this.dpr,
      quality: this.quality,
      chunks: this.chunks.size,
      grass: this.grassField?.cells ?? 0,
      /** Where the triangles go (scenery that exists, before culling), biggest first. */
      breakdown: this.triangleBreakdown(),
    }
  }

  private triangleBreakdown(): [string, number][] {
    const t: Record<string, number> = {}
    for (const c of this.chunks.values())
      for (const [k, v] of Object.entries((c.group.userData.tris ?? {}) as Record<string, number>)) t[k] = (t[k] ?? 0) + v
    t.grass = this.grassField && this.world ? triCount(this.world.grass.geometry) * this.grassField.count : 0
    if (this.far) t.far = triCount(this.far.mesh.geometry) + (this.far.forest ? triCount(this.far.forest.geometry) * this.far.forest.count : 0)
    t.car = 0
    ;(this.userCar?.group ?? this.car.group).traverse((o) => {
      if (o instanceof THREE.Mesh) t.car += triCount(o.geometry)
    })
    return Object.entries(t).sort((a, b) => b[1] - a[1])
  }

  /** Changes the time of day: fades out, swaps the sky, fades back in. */
  setTime(time: TimeOfDay) {
    if (time === this.time) return
    this.time = time
    void this.loadSky(time)
      .then((state) => {
        if (this.disposed) return
        if (this.time !== time) {
          // Superseded by another pick while it loaded.
          this.freeSkies(this.sky)
          return
        }
        this.pendingSky = { time, state }
        this.fadeTarget = 0
      })
      .catch(() => {})
  }

  cycleTime() {
    const i = TIMES.findIndex((t) => t.id === this.time)
    this.setTime(TIMES[(i + 1) % TIMES.length].id)
  }

  cycleCamera() {
    this.cameraMode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.cameraMode) + 1) % CAMERA_MODES.length]
    this.flybyAt = null
    this.idle = 0
    this.directorOn = false
  }

  setAutopilot(on: boolean) {
    this.autopilot = on
    if (on) this.cruise = Math.max(18, Math.min(32, this.speed || 25))
  }

  /** Live wallpaper: when left alone, cruise resumes and the camera starts cutting between shots. */
  setWallpaper(on: boolean) {
    this.wallpaper = on
    if (!on) this.directorOn = false
  }

  get isAutopilot() {
    return this.autopilot
  }

  private get carGroup() {
    return this.userCar?.group ?? this.car.group
  }

  private placeCar(_dt: number) {
    const p = this.phys
    this.road.sample(this.s, this.sample)
    const g = this.carGroup
    g.position.copy(p.position)
    g.rotation.set(p.pitch, p.yaw, p.roll, "YXZ")
    if (this.shadowQuad) {
      const gy = this.ground.heightAt(p.position.x, p.position.z)
      this.shadowQuad.position.set(p.position.x, gy + 0.035, p.position.z)
      this.shadowQuad.rotation.set(p.pitch, p.yaw, 0, "YXZ")
    }
    // Wheels: spin, steer (front pair) and suspension travel. car.ts orders them FR, FL,
    // RR, RL in physics terms, hence i ^ 1.
    const wheels = this.car.wheels
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i]
      if (w.userData.baseY === undefined) {
        w.userData.baseY = w.position.y
        w.rotation.order = "YXZ"
      }
      w.position.y = (w.userData.baseY as number) + p.wheelCompression[i ^ 1]
      w.rotation.x = p.wheelSpin
      w.rotation.y = i < 2 ? -p.steerAngle : 0
    }
    if (this.userCar) for (const w of this.userCar.wheels) w.pivot.quaternion.setFromAxisAngle(w.axle, p.wheelSpin)
  }

  /**
   * Headlights switch on by themselves when it gets dark (fading over a second, with
   * daytime running lights otherwise); tail lights flare when braking.
   */
  private updateCarLights(dt: number) {
    const e = this.sky?.exposure ?? 1
    const want = this.look.lamps > 0.3 ? 1 : 0
    this.headlightsOn += Math.sign(want - this.headlightsOn) * Math.min(Math.abs(want - this.headlightsOn), dt)
    const h = this.headlightsOn
    this.car.headlights.emissiveIntensity = (0.35 + h * 1.6) / e
    for (const m of this.userCar?.headlights ?? []) m.emissiveIntensity = (0.25 + h * 1.6) / e
    this.car.beam.intensity = (h * 95) / e
    const brake = this.phys.braking ? 3.2 : 1
    this.car.tail.emissiveIntensity = this.tailBase * brake
    for (const m of this.userCar?.taillights ?? []) m.emissiveIntensity = this.userTailBase * brake
  }

  private addChunk(i: number) {
    if (!this.world || this.chunks.has(i)) return
    this.far?.invalidate()
    const chunk = buildChunk(this.road, i, this.world, this.profile.density)
    this.chunks.set(i, chunk)
    hazeObject(chunk.group)
    freeze(chunk.group)
    this.scene.add(chunk.group)
    this.colliders.set(i, chunk.colliders)
  }

  /**
   * Builds scenery in the direction the car is actually travelling (forward along the road
   * normally, backward after a U-turn, both ways when it's crossing the road off-road), and
   * recycles what's far behind. Chunks are seeded by index, so a stretch you come back to is
   * rebuilt exactly as it was: like Slow Roads, the world never ends in any direction.
   */
  private updateChunks() {
    if (!this.world) return
    const current = Math.floor(this.s / CHUNK_LEN)
    const ahead = this.profile.ahead
    // +1 = travelling with the road, -1 = against it, 0 = across it (off-road).
    const along = Math.cos(this.phys.yaw - this.sample.heading)
    const dir = along > 0.35 ? 1 : along < -0.35 ? -1 : 0
    const half = Math.ceil(ahead / 2)
    const lo = Math.max(0, dir > 0 ? current - BEHIND : dir < 0 ? current - ahead : current - half)
    const hi = dir > 0 ? current + ahead : dir < 0 ? current + BEHIND : current + half
    // Nearest missing chunk first (one per frame keeps frame times smooth).
    for (let d = 0; d <= ahead; d++) {
      const a = current + d, b = current - d
      if (a >= lo && a <= hi && !this.chunks.has(a)) {
        this.addChunk(a)
        break
      }
      if (b >= lo && b <= hi && b >= 0 && !this.chunks.has(b)) {
        this.addChunk(b)
        break
      }
    }
    // Keep one spare chunk either side of the window so a quick turn doesn't rebuild.
    for (const [i, chunk] of this.chunks) {
      if (i < lo - 1 || i > hi + 1) {
        this.scene.remove(chunk.group)
        disposeChunk(chunk)
        this.chunks.delete(i)
        this.colliders.remove(i)
        this.far?.invalidate()
      }
    }
  }

  private updateCamera(dt: number) {
    const car = this.carGroup
    // Scratch vectors are reused every frame (no garbage, no GC hitches).
    const fwd = this.tmpFwd.set(Math.sin(car.rotation.y), 0, Math.cos(car.rotation.y))
    const desired = this.tmpDesired
    const lookAt = this.tmpLook
    let follow = 1 - Math.exp(-dt * 5)
    let lookFollow = 1 - Math.exp(-dt * 8)
    const mode = this.cameraMode
    if (mode === "chase") {
      // Chase framing close behind the car.
      // On the road: follow the road's bends. Off it (off-roading): follow the car itself.
      // Close chase camera; it eases back a little and widens with speed so speed is felt.
      const sp = Math.min(Math.abs(this.speed), 45)
      const camBack = 5.4 + sp * 0.04
      const camUp = 1.9 + sp * 0.01
      // Tight chase: positioned from the car itself (not the road), close behind and above,
      // looking just ahead of it, with only a little smoothing so it stays glued to the car.
      desired.copy(car.position).addScaledVector(fwd, -camBack)
      desired.y += camUp
      lookAt.copy(car.position).addScaledVector(fwd, 12)
      lookAt.y += 1.0
      this.camera.fov = 58 + sp * 0.22
      follow = 1 - Math.exp(-dt * 10)
      lookFollow = 1 - Math.exp(-dt * 14)
    } else if (mode === "hood") {
      desired.copy(car.position).addScaledVector(fwd, 0.6)
      desired.y += 1.3
      lookAt.copy(car.position).addScaledVector(fwd, 30)
      lookAt.y += 1.0
      this.camera.fov = 66
      follow = lookFollow = 1
    } else if (mode === "cinematic") {
      const [rx, rz] = rightOf(this.sample.heading)
      const swing = Math.sin(this.elapsed * 0.08) * 10
      desired.copy(car.position).addScaledVector(fwd, 14 + swing)
      desired.x += rx * 12
      desired.y += 2.4
      desired.z += rz * 12
      lookAt.copy(car.position)
      lookAt.y += 0.8
      this.camera.fov = 40
      follow = 1 - Math.exp(-dt * 1.5)
    } else {
      // Flyby: a fixed roadside camera the car sweeps past, then the next one down the road.
      const dir = Math.cos(this.phys.yaw - this.sample.heading) >= 0 ? 1 : -1
      // w = the camera's road position: move on once the car is 40 m past it (either way),
      // or if it's somehow far away (U-turn, off-road).
      const passed = this.flybyAt ? (this.s - this.flybyAt.w) * dir > 40 || Math.abs(this.flybyAt.w - this.s) > 220 : true
      if (!this.flybyAt || passed) {
        const camS = Math.max(0, this.s + (110 + Math.random() * 60) * dir)
        const p = this.road.sample(camS, this.camSample)
        const [rx, rz] = rightOf(p.heading)
        const off = (Math.random() < 0.6 ? 1 : -1) * (9 + Math.random() * 8)
        this.flybyAt = new THREE.Vector4(p.x + rx * off, p.y + 1.2 + Math.random() * 3.5, p.z + rz * off, camS)
        this.camPos.set(this.flybyAt.x, this.flybyAt.y, this.flybyAt.z)
        this.camLook.copy(car.position)
      }
      desired.set(this.flybyAt.x, this.flybyAt.y, this.flybyAt.z)
      lookAt.copy(car.position)
      lookAt.y += 0.9
      this.camera.fov = 34
      follow = 1
      lookFollow = 1 - Math.exp(-dt * 6)
    }
    // A short shake on impacts (decays with phys.impact).
    const shake = Math.min(this.phys.impact, 15) * 0.012
    if (shake > 0.001) {
      desired.x += Math.sin(this.elapsed * 53) * shake
      desired.y += Math.sin(this.elapsed * 61 + 1.3) * shake
    }
    this.camPos.lerp(desired, follow)
    this.camLook.lerp(lookAt, lookFollow)
    // Above the ground under the camera (not the road: the car may be off-road, below it),
    // and above the water surface.
    this.camPos.y = Math.max(this.camPos.y, this.ground.heightAt(this.camPos.x, this.camPos.z) + 0.8, 0.6)
    this.camera.position.copy(this.camPos)
    this.camera.lookAt(this.camLook)
    this.camera.updateProjectionMatrix()
  }

  /** Advances the drive by dt seconds and renders a frame. */
  frame(dt: number, input: DriveInput): DriveFrame {
    if (this.disposed) return this.snapshot()
    // The governor sees the real frame time; the simulation gets a clamped step.
    const rawDt = Math.min(dt, 0.25)
    dt = Math.min(dt, 0.05)
    this.elapsed += dt

    const touching = input.throttle || input.brake || input.left || input.right
    if (touching) {
      this.autopilot = false
      this.idle = 0
      if (this.directorOn) {
        this.directorOn = false
        this.cameraMode = "chase"
      }
    } else this.idle += dt

    // Live wallpaper: hands off the keys → cruise again, then cut between shots.
    if (this.wallpaper) {
      if (!this.autopilot && this.idle > 12) this.setAutopilot(true)
      if (!this.directorOn && this.idle > 45) {
        this.directorOn = true
        this.directorClock = 0
      }
      if (this.directorOn) {
        this.directorClock -= dt
        if (this.directorClock <= 0) {
          this.directorShot = (this.directorShot + 1) % DIRECTOR.length
          this.cameraMode = DIRECTOR[this.directorShot]
          this.flybyAt = null
          this.directorClock = this.cameraMode === "flyby" ? 26 : 18
        }
      }
    }

    // Driving: the physics model (grip, weight transfer, suspension over the terrain).
    // Hands off → the autopilot steers and brakes like a relaxed driver; keys → you drive.
    if (this.world) {
      const c = this.ctl
      if (this.autopilot) {
        const wander = Math.sin(this.elapsed * 0.13) * 0.25
        autopilot(this.phys, this.road, { lane: LANE + wander, cruise: this.cruise, dt }, c)
      } else {
        c.throttle = input.throttle ? 1 : 0
        c.brake = input.brake ? 1 : 0
        c.steer = (input.right ? 1 : 0) - (input.left ? 1 : 0)
        c.boost = input.boost
        c.handbrake = false
      }
      this.phys.step(dt, c)
    }
    this.s = this.phys.location.s
    this.speed = this.phys.speed
    this.odometer += Math.abs(this.speed) * dt
    // The road only extends forwards from its start: reversing back past it would leave the
    // world, so set the car down just inside it.
    if (this.s < 3 && this.world) {
      const back = this.road.sample(10)
      const [rx, rz] = rightOf(back.heading)
      const off = THREE.MathUtils.clamp(this.phys.location.off, -ROAD_HALF, ROAD_HALF)
      this.phys.reset(back.x + rx * off, back.z + rz * off, this.phys.yaw, 0)
      this.s = this.phys.location.s
      this.speed = 0
    }
    this.placeCar(dt)
    this.road.ensure(this.s + (this.profile.ahead + 2) * CHUNK_LEN)
    this.updateChunks()

    // Time-of-day fade: out, swap the sky, back in.
    if (this.pendingSky && this.world && (this.fade <= 0.001 || !this.sky)) {
      this.look = LOOKS[this.pendingSky.time]
      this.applySky(this.pendingSky.state)
      this.pendingSky = null
      if (this.retiredSky && this.retiredSky !== this.sky) {
        this.retiredSky.tex.dispose()
        this.retiredSky.env.dispose()
        this.retiredSky = null
      }
      this.fadeTarget = 1
    }
    if (this.sky && this.world) {
      const rate = this.fadeTarget > this.fade ? 1.2 : 2.2
      this.fade += Math.sign(this.fadeTarget - this.fade) * Math.min(Math.abs(this.fadeTarget - this.fade), dt * rate)
    }
    this.grade.uniforms.uFade.value = this.fade * this.fade
    this.grade.uniforms.uTime.value = this.elapsed % 100

    this.updateCamera(dt)

    const car = this.carGroup
    // Snap by the mesh's vertex spacing so the waves don't jump when the plane follows.
    const cell = WATER_SIZE / WATER_SEGMENTS
    this.water.position.set(Math.round(this.camPos.x / cell) * cell, 0, Math.round(this.camPos.z / cell) * cell)
    this.water.material.uniforms.uTime.value = this.elapsed
    if (this.world) this.world.time.value = this.elapsed
    const sunDir = this.sky?.sunDir ?? DriveEngine.UP
    this.sun.position.copy(car.position).addScaledVector(sunDir, 250)
    this.sun.target.position.copy(car.position)

    this.updateCarLights(dt)
    this.grassField?.update(car.position.x, car.position.z, this.camera.position.x, this.camera.position.z)
    if (this.far) {
      // Only the chunks that exist right now (they appear one per frame).
      let lo = Infinity, hi = -Infinity
      for (const i of this.chunks.keys()) {
        if (i < lo) lo = i
        if (i > hi) hi = i
      }
      this.covered.from = Number.isFinite(lo) ? lo * CHUNK_SAMPLES : 0
      this.covered.to = Number.isFinite(hi) ? (hi + 1) * CHUNK_SAMPLES : 0
      this.far.update(car.position.x, car.position.z, this.road, this.covered)
    }
    this.frameNo++
    this.renderer.shadowMap.needsUpdate = this.frameNo % 2 === 0
    this.renderer.info.reset()
    this.composer.render(dt)
    this.govern(rawDt)
    return this.snapshot()
  }

  private snapshot(): DriveFrame {
    return {
      speedKmh: Math.abs(this.speed) * 3.6,
      autopilot: this.autopilot,
      distanceKm: this.odometer / 1000,
      time: this.time,
      camera: this.cameraMode,
      director: this.directorOn,
      struggling: this.slowSeconds >= 6,
    }
  }

  dispose() {
    this.disposed = true
    for (const chunk of this.chunks.values()) {
      this.scene.remove(chunk.group)
      disposeChunk(chunk)
    }
    this.chunks.clear()
    // Everything still in memory: the scene, both cars (one may be detached), the world kits.
    const textures = new Set<THREE.Texture>()
    const materials = new Set<THREE.Material>()
    const geometries = new Set<THREE.BufferGeometry>()
    const collect = (root: THREE.Object3D) =>
      root.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return
        geometries.add(o.geometry)
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m)
        if (o instanceof THREE.InstancedMesh) o.dispose()
      })
    this.grassField?.dispose()
    this.far?.dispose()
    collect(this.scene)
    collect(this.car.group)
    if (this.userCar) collect(this.userCar.group)
    void this.userCarLoad?.then((car) => {
      // A detailed car that finished loading after we closed (or was swapped out).
      if (!car || car === this.userCar) return
      car.group.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return
        o.geometry.dispose()
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose()
      })
    })
    const w = this.world
    if (w) {
      for (const kit of [...w.palm, w.barrier, ...w.shrubs])
        for (const part of kit) {
          geometries.add(part.geometry)
          materials.add(part.material)
          if (part.material.userData.windDepth) materials.add(part.material.userData.windDepth)
        }
      geometries.add(w.grass.geometry)
      materials.add(w.grass.material)
      for (const kit of w.trees)
        for (const part of kit) {
          geometries.add(part.geometry)
          materials.add(part.material)
          if (part.material.userData.windDepth) materials.add(part.material.userData.windDepth)
        }
      for (const m of [w.roadMat, w.markMat, w.groundMat]) materials.add(m)
      for (const t of w.extraTextures) textures.add(t)
    }
    for (const m of materials)
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) textures.add(v)
    geometries.forEach((g) => g.dispose())
    materials.forEach((m) => m.dispose())
    textures.forEach((t) => t.dispose())
    for (const st of this.skyStates.values()) {
      st.tex.dispose()
      st.env.dispose()
    }
    this.retiredSky?.tex.dispose()
    this.retiredSky?.env.dispose()
    this.skyStates.clear()
    this.skyCache.clear()
    this.pmrem.dispose()
    this.bloom.dispose()
    this.grade.dispose()
    this.fxaa.dispose()
    this.composer.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
  }
}
