import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js"

/** Where the CC0 assets live (public/drive, served at the app root). */
export const ASSET_ROOT = "/drive"

/** One part of an instanced prop: a geometry with its material. */
export interface KitPart {
  geometry: THREE.BufferGeometry
  material: THREE.Material
  /** Lights up at night (lamp glass, bulbs). */
  glow?: boolean
}
export type Kit = KitPart[]

export interface PbrSet {
  map: THREE.Texture
  normalMap: THREE.Texture
  arm: THREE.Texture
}

const texLoader = new THREE.TextureLoader()
const gltfLoader = new GLTFLoader()

function loadTex(url: string, srgb: boolean): Promise<THREE.Texture> {
  return new Promise((resolve, reject) =>
    texLoader.load(
      url,
      (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping
        t.anisotropy = 8
        if (srgb) t.colorSpace = THREE.SRGBColorSpace
        resolve(t)
      },
      undefined,
      reject,
    ),
  )
}

export async function loadPbr(name: string): Promise<PbrSet> {
  const base = `${ASSET_ROOT}/tex/${name}`
  const [map, normalMap, arm] = await Promise.all([
    loadTex(`${base}_diff.jpg`, true),
    loadTex(`${base}_nor.jpg`, false),
    loadTex(`${base}_arm.jpg`, false),
  ])
  return { map, normalMap, arm }
}

/**
 * Loads a glTF and flattens it into instanceable parts: every mesh's world transform is
 * baked into its geometry. `split` keeps each top-level node as its own kit (variants).
 */
export async function loadKit(name: string, split = false): Promise<Kit[]> {
  const [gltf, lods] = await Promise.all([
    gltfLoader.loadAsync(`${ASSET_ROOT}/models/${name}/${name}.gltf`),
    loadLods(name),
  ])
  gltf.scene.updateMatrixWorld(true)
  const roots = split ? gltf.scene.children : [gltf.scene]
  return roots.map((root) => {
    const kit: Kit = []
    root.updateMatrixWorld(true)
    // Variants sit side by side in the file: cancel each root's own placement.
    const undo = new THREE.Matrix4()
    if (split) {
      const p = new THREE.Vector3()
      root.getWorldPosition(p)
      undo.makeTranslation(-p.x, 0, -p.z)
    }
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      const g = lodFor(o.geometry as THREE.BufferGeometry, lods) ?? (o.geometry as THREE.BufferGeometry).clone()
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(undo, o.matrixWorld))
      g.userData.shared = true
      kit.push({ geometry: g, material: o.material as THREE.Material })
    })
    return kit
  })
}

interface Lod {
  match: { tris: number; verts: number }
  position: string
  normal: string | null
  uv: string | null
  index: string | null
}

/**
 * Low-poly versions written by scripts/drive-simplify-models.mjs (<name>.lod.json). The
 * Poly Haven meshes are made for close-up renders; repeated along a road they cost
 * millions of triangles. Missing or unreadable file → the full meshes are used.
 */
async function loadLods(name: string): Promise<Lod[]> {
  try {
    const res = await fetch(`${ASSET_ROOT}/models/${name}/${name}.lod.json`)
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? (data as Lod[]) : []
  } catch {
    return [] // includes a dev server answering with index.html
  }
}

const b64 = (s: string) => {
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

/** The low-poly replacement for a loaded mesh, recognised by its original size. */
function lodFor(geo: THREE.BufferGeometry, lods: Lod[]): THREE.BufferGeometry | null {
  const tris = geo.index ? geo.index.count / 3 : geo.getAttribute("position").count / 3
  const verts = geo.getAttribute("position").count
  const lod = lods.find((l) => l.match.tris === tris && l.match.verts === verts)
  if (!lod) return null
  const out = new THREE.BufferGeometry()
  out.setAttribute("position", new THREE.BufferAttribute(new Float32Array(b64(lod.position)), 3))
  if (lod.normal) out.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(b64(lod.normal)), 3))
  else out.computeVertexNormals()
  if (lod.uv) out.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(b64(lod.uv)), 2))
  if (lod.index) out.setIndex(new THREE.BufferAttribute(new Uint32Array(b64(lod.index)), 1))
  return out
}

export async function loadHdr(name: string): Promise<THREE.DataTexture> {
  const t = await new RGBELoader().loadAsync(`${ASSET_ROOT}/sky/${name}.hdr`)
  t.mapping = THREE.EquirectangularReflectionMapping
  return t
}

const pi0 = (row: number, col: number, width: number) => (row * width + col) * 4

/** Box-filters an equirect HDR down by an integer factor (less video memory on slow PCs). */
export function downscaleHdr(tex: THREE.DataTexture, factor: number): THREE.DataTexture {
  const img = tex.image as unknown as { data: Uint16Array | Float32Array; width: number; height: number }
  const { data, width, height } = img
  const half = data instanceof Uint16Array
  const W = Math.floor(width / factor), H = Math.floor(height / factor)
  const out = new Uint16Array(W * H * 4)
  const read = (i: number) => (half ? THREE.DataUtils.fromHalfFloat((data as Uint16Array)[i]) : (data as Float32Array)[i])
  const n = factor * factor
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0
      for (let dy = 0; dy < factor; dy++)
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * width + (x * factor + dx)) * 4
          r += read(i)
          g += read(i + 1)
          b += read(i + 2)
        }
      const o = (y * W + x) * 4
      out[o] = THREE.DataUtils.toHalfFloat(r / n)
      out[o + 1] = THREE.DataUtils.toHalfFloat(g / n)
      out[o + 2] = THREE.DataUtils.toHalfFloat(b / n)
      out[o + 3] = THREE.DataUtils.toHalfFloat(1)
    }
  const small = new THREE.DataTexture(out, W, H, THREE.RGBAFormat, THREE.HalfFloatType)
  small.mapping = THREE.EquirectangularReflectionMapping
  small.colorSpace = tex.colorSpace
  small.flipY = tex.flipY
  small.minFilter = THREE.LinearFilter
  small.magFilter = THREE.LinearFilter
  small.generateMipmaps = false
  small.needsUpdate = true
  return small
}

/**
 * Reads an equirect HDR: where the sun is (its brightest spot) and its colour, the average
 * sky brightness, and the colour just above the horizon. Then tames the sun disc in the
 * texture itself: a photographed sun is thousands of times brighter than the sky, which
 * blows out the glow effect; the directional light stands in for it instead.
 */
export function analyseSky(tex: THREE.DataTexture) {
  const img = tex.image as unknown as { data: Uint16Array | Float32Array; width: number; height: number }
  const { data, width, height } = img
  const half = data instanceof Uint16Array
  const read = (i: number) => (half ? THREE.DataUtils.fromHalfFloat((data as Uint16Array)[i]) : (data as Float32Array)[i])
  const write = (i: number, v: number) => {
    if (half) (data as Uint16Array)[i] = THREE.DataUtils.toHalfFloat(v)
    else (data as Float32Array)[i] = v
  }
  const lumAt = (i: number) => 0.2126 * read(i) + 0.7152 * read(i + 1) + 0.0722 * read(i + 2)
  let best = -1, bestRow = 0, bestCol = 0
  const horizon = new THREE.Color(0, 0, 0)
  let hn = 0, skySum = 0, skyW = 0
  for (let row = 0; row < height / 2; row += 4) {
    // flipY: the first row is the top of the sky.
    const v = 1 - (row + 0.5) / height
    const w = Math.cos((v - 0.5) * Math.PI)
    for (let col = 0; col < width; col += 4) {
      const i = (row * width + col) * 4
      const lum = lumAt(i)
      skySum += lum * w
      skyW += w
      if (lum > best) {
        best = lum
        bestRow = row
        bestCol = col
      }
      if (v < 0.522) {
        horizon.r += read(i)
        horizon.g += read(i + 1)
        horizon.b += read(i + 2)
        hn++
      }
    }
  }
  if (hn) horizon.multiplyScalar(1 / hn)
  const skyAvg = skySum / Math.max(1, skyW)

  // Sun colour from the halo ring around the peak: the core itself is clipped (half-float
  // tops out at 65504), which reads as white even for a golden sun.
  const sunColor = new THREE.Color(0, 0, 0)
  {
    const rIn = Math.max(2, Math.round(width / 512))
    const rOut = Math.max(rIn + 3, Math.round(width / 170))
    let n = 0
    for (let dr = -rOut; dr <= rOut; dr++)
      for (let dc = -rOut; dc <= rOut; dc++) {
        const d = Math.hypot(dr, dc)
        if (d < rIn || d > rOut) continue
        const row = bestRow + dr
        if (row < 0 || row >= height) continue
        const i = (row * width + ((bestCol + dc + width) % width)) * 4
        const r = read(i), g = read(i + 1), b = read(i + 2)
        if (Math.max(r, g, b) >= 60000) continue
        sunColor.r += r
        sunColor.g += g
        sunColor.b += b
        n++
      }
    if (n === 0) sunColor.setRGB(read(pi0(bestRow, bestCol, width)), read(pi0(bestRow, bestCol, width) + 1), read(pi0(bestRow, bestCol, width) + 2))
    sunColor.multiplyScalar(1 / Math.max(sunColor.r, sunColor.g, sunColor.b, 1e-6))
  }

  // Tame the sun/moon: a photographed sun is thousands of times brighter than the sky.
  // A smooth logarithmic knee over the WHOLE image (not a hard cut inside a box, which left
  // a square edge around the sun and moon): brightness above the knee is compressed
  // gradually, so the disc and its halo stay round and still read as the brightest thing.
  const knee = Math.max(skyAvg * 12, 4)
  const n = width * height * 4
  for (let i = 0; i < n; i += 4) {
    const lum = lumAt(i)
    if (lum <= knee) continue
    const k = (knee * (1 + Math.log(lum / knee))) / lum
    write(i, read(i) * k)
    write(i + 1, read(i + 1) * k)
    write(i + 2, read(i + 2) * k)
  }
  tex.needsUpdate = true

  const v = 1 - (bestRow + 0.5) / height
  const u = (bestCol + 0.5) / width
  const phi = (u - 0.5) * Math.PI * 2
  const theta = (v - 0.5) * Math.PI
  const sunDir = new THREE.Vector3(Math.cos(theta) * Math.cos(phi), Math.sin(theta), Math.cos(theta) * Math.sin(phi)).normalize()
  return { sunDir, sunColor, horizon, skyAvg, peak: best }
}

export interface UserCar {
  group: THREE.Group
  /** Pivots centred on each wheel, with the axle to spin them about (car space). */
  wheels: WheelPivot[]
  /** Headlight and tail-light materials, lit at night. */
  headlights: THREE.MeshStandardMaterial[]
  taillights: THREE.MeshStandardMaterial[]
}

export interface WheelPivot {
  pivot: THREE.Object3D
  axle: THREE.Vector3
}

/** Centre and axle of a tyre mesh in car space, from its vertices (principal axes). */
function tyreAxis(mesh: THREE.Mesh, toCar: THREE.Matrix4) {
  const pos = mesh.geometry.getAttribute("position")
  if (!pos || pos.count < 12) return null
  const m = new THREE.Matrix4().multiplyMatrices(toCar, mesh.matrixWorld)
  const v = new THREE.Vector3()
  const step = Math.max(1, Math.floor(pos.count / 4000))
  const pts: THREE.Vector3[] = []
  const mean = new THREE.Vector3()
  let minY = Infinity, maxY = -Infinity
  for (let i = 0; i < pos.count; i += step) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m)
    pts.push(v.clone())
    mean.add(v)
    minY = Math.min(minY, v.y)
    maxY = Math.max(maxY, v.y)
  }
  mean.divideScalar(pts.length)
  // Covariance, then the eigenvector with the smallest eigenvalue: power iteration on
  // (trace·I − C), whose largest eigenvector is C's smallest.
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
  for (const p of pts) {
    const dx = p.x - mean.x, dy = p.y - mean.y, dz = p.z - mean.z
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz
  }
  const tr = xx + yy + zz
  let a = new THREE.Vector3(1, 0, 0)
  for (let k = 0; k < 40; k++) {
    const nx = (tr - xx) * a.x - xy * a.y - xz * a.z
    const ny = -xy * a.x + (tr - yy) * a.y - yz * a.z
    const nz = -xz * a.x - yz * a.y + (tr - zz) * a.z
    a = new THREE.Vector3(nx, ny, nz).normalize()
  }
  if (a.x < 0) a.negate() // consistent spin direction on both sides
  // Ring centre: the middle of its extent across the axle (the mean can sit off-centre
  // when the tread has more vertices on one side).
  const box = new THREE.Box3()
  for (const p of pts) box.expandByPoint(p)
  const centre = box.getCenter(new THREE.Vector3())
  return { centre, axle: a, minY, height: maxY - minY }
}

const meshMaterials = (o: THREE.Mesh) => (Array.isArray(o.material) ? o.material : [o.material]) as THREE.MeshStandardMaterial[]

/**
 * Loads a user-supplied car (public/drive/car.glb) and fits it to the drive: 4.5 m long,
 * centred, wheels on the ground, nose towards +z (found from the headlights), with each
 * wheel re-pivoted on its own centre so it can spin.
 */
export async function loadUserCar(): Promise<UserCar | null> {
  let gltf
  try {
    gltf = await gltfLoader.loadAsync(`${ASSET_ROOT}/car.glb`)
  } catch {
    return null // no car.glb (or not a glTF): keep the built-in car
  }
  const model = gltf.scene
  const holder = new THREE.Group()
  holder.add(model)
  const fit = () => {
    holder.updateMatrixWorld(true)
    return new THREE.Box3().setFromObject(holder)
  }

  // Length along z.
  let size = fit().getSize(new THREE.Vector3())
  if (size.x > size.z) model.rotation.y = Math.PI / 2

  // Nose towards +z: headlights should be in front of the middle.
  const lightCentre = (re: RegExp) => {
    const box = new THREE.Box3()
    holder.updateMatrixWorld(true)
    model.traverse((o) => {
      if (o instanceof THREE.Mesh && meshMaterials(o).some((m) => re.test(m.name))) box.expandByObject(o)
    })
    return box.isEmpty() ? null : box.getCenter(new THREE.Vector3())
  }
  const whole = fit().getCenter(new THREE.Vector3())
  const head = lightCentre(/headlight/i)
  if (head && head.z < whole.z) model.rotation.y += Math.PI

  // Scale to 4.5 m and sit it on the ground at the origin.
  size = fit().getSize(new THREE.Vector3())
  holder.scale.setScalar(4.5 / Math.max(0.01, size.z))
  const box = fit()
  const centre = box.getCenter(new THREE.Vector3())
  const group = new THREE.Group()
  group.add(holder)
  holder.position.set(-centre.x, -box.min.y, -centre.z)
  group.updateMatrixWorld(true)

  // Wheels: each node carrying a tyre mesh. Its centre and axle come from the tyre's own
  // vertices (the axle is the direction the ring is thinnest in), so a wheel modelled
  // slightly steered or toed-in still spins true instead of wobbling.
  const tyres: THREE.Mesh[] = []
  model.traverse((o) => {
    if (o instanceof THREE.Mesh && meshMaterials(o).some((m) => /tyre|tire/i.test(m.name))) tyres.push(o)
  })
  const wheels: WheelPivot[] = []
  const seen = new Set<THREE.Object3D>()
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert()
  for (const tyre of tyres) {
    const root = tyre.parent ?? tyre
    if (seen.has(root)) continue
    seen.add(root)
    const axis = tyreAxis(tyre, inv)
    if (!axis) continue
    const { centre, axle, minY, height } = axis
    if (minY > height * 0.25) continue // a spare tucked inside the body
    const pivot = new THREE.Group()
    pivot.position.copy(centre)
    group.add(pivot)
    pivot.updateMatrixWorld(true)
    pivot.attach(root) // keeps its world transform; it now turns about the wheel's own centre
    wheels.push({ pivot, axle })
  }

  const headlights: THREE.MeshStandardMaterial[] = []
  const taillights: THREE.MeshStandardMaterial[] = []
  group.updateMatrixWorld(true)
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    // Only the larger parts cast shadows (measured in car space, metres): hundreds of small
    // bits cost a lot for nothing.
    o.geometry.computeBoundingSphere()
    o.castShadow = (o.geometry.boundingSphere?.radius ?? 0) * o.matrixWorld.getMaxScaleOnAxis() > 0.25
    o.receiveShadow = false
    for (const m of meshMaterials(o)) {
      if (/headlight/i.test(m.name) && !headlights.includes(m)) {
        m.emissive = new THREE.Color("#fff1d6")
        headlights.push(m)
      } else if (/red_glass|tail/i.test(m.name) && !taillights.includes(m)) {
        m.emissive = new THREE.Color("#ff1a2c")
        taillights.push(m)
      }
    }
  })
  return { group, wheels, headlights, taillights }
}
