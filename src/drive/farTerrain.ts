import * as THREE from "three"
import { buildFarTerrain, type FarRequest, type FarResult } from "./farTerrain.worker"

/**
 * World-space far terrain: one grid mesh centred near the car, fine in the middle and
 * coarse towards a ~4 km horizon, so the land reaches the sky without the folds that
 * road-relative strips get on bends. Built off the main thread in a worker; the mesh only
 * changes when the car has moved far enough to re-centre it.
 */

/** Re-centre once the car is this far from the current centre (m). */
const RECENTRE = 300
/** Centres snap to this grid so re-centres are stable. */
const SNAP = 128
const EXTENT = 4000
/** Road samples sent to the builder: only those this close to the centre. */
const ROAD_RADIUS = 4500

export interface FarRoad {
  xs: number[]
  ys: number[]
  zs: number[]
  hs: number[]
}

export interface FarTerrainOptions {
  material: THREE.Material
  n: number
  trees: number
  impostorGeometry?: THREE.BufferGeometry
  impostorMaterial?: THREE.Material
}

export class FarTerrain {
  /** Positioned at the current centre; holds `mesh` and `forest`. Add this to the scene. */
  readonly object = new THREE.Group()
  readonly mesh: THREE.Mesh
  private forestMesh: THREE.InstancedMesh | null = null
  private applied = false
  private worker: Worker | null = null
  private busy = false
  private dirty = true
  private disposed = false
  private nextId = 1
  private reqX = NaN
  private reqZ = NaN
  private n: number
  private trees: number
  private geoN = -1
  private readonly opts: FarTerrainOptions
  // Scratch for instance matrices.
  private readonly m4 = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly p = new THREE.Vector3()
  private readonly s = new THREE.Vector3()
  private readonly up = new THREE.Vector3(0, 1, 0)

  constructor(opts: FarTerrainOptions) {
    this.opts = opts
    this.n = Math.max(2, Math.round(opts.n))
    this.trees = Math.max(0, Math.round(opts.trees))
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), opts.material)
    this.mesh.frustumCulled = false
    this.mesh.receiveShadow = true
    this.mesh.castShadow = false
    this.mesh.visible = false
    this.mesh.name = "far-terrain"
    this.object.name = "far-terrain-root"
    this.object.add(this.mesh)
    this.makeForest()
    try {
      this.worker = new Worker(new URL("./farTerrain.worker.ts", import.meta.url), { type: "module" })
      this.worker.onmessage = (e: MessageEvent<FarResult>) => {
        this.busy = false
        if (!this.disposed) this.apply(e.data)
      }
      // Any worker failure: drop to building on the main thread from the next update.
      this.worker.onerror = this.worker.onmessageerror = () => this.dropWorker()
    } catch {
      this.worker = null
    }
  }

  /** Impostor forest, or null when no impostor geometry/material was given. Replaced if setDetail grows the tree count. */
  get forest(): THREE.InstancedMesh | null {
    return this.forestMesh
  }

  /** True once the first result is on screen. */
  get ready(): boolean {
    return this.applied
  }

  /**
   * Call every frame. Cheap unless the car has left the re-centre radius (or detail
   * changed), in which case it starts a build; only one is ever in flight.
   * `covered` (optional) = road sample index range the near strips currently cover; outside
   * it the ring makes a shallow valley instead of sinking. Defaults to the whole road.
   */
  update(carX: number, carZ: number, road: FarRoad, covered?: { from: number; to: number }): void {
    if (this.busy || this.disposed) return
    const moved = !(Math.hypot(carX - this.reqX, carZ - this.reqZ) <= RECENTRE) // NaN → first run
    if (!moved && !this.dirty) return
    const cx = Math.round(carX / SNAP) * SNAP
    const cz = Math.round(carZ / SNAP) * SNAP
    this.dirty = false
    this.reqX = cx
    this.reqZ = cz
    const req = this.request(cx, cz, road, covered)
    if (this.worker) {
      this.busy = true
      const r = req.road
      this.worker.postMessage(req, [r.xs.buffer, r.ys.buffer, r.zs.buffer, r.hs.buffer])
    } else {
      this.apply(buildFarTerrain(req))
    }
  }

  /** Rebuild at the next update (the near strips it hides under have changed). */
  invalidate(): void {
    this.dirty = true
  }

  setDetail(n: number, trees: number): void {
    n = Math.max(2, Math.round(n))
    trees = Math.max(0, Math.round(trees))
    if (n === this.n && trees === this.trees) return
    this.n = n
    if (trees !== this.trees) {
      this.trees = trees
      if (this.forestMesh && trees > this.forestMesh.instanceMatrix.count) this.makeForest()
    }
    this.dirty = true
  }

  dispose(): void {
    this.disposed = true
    this.worker?.terminate()
    this.worker = null
    this.mesh.geometry.dispose()
    this.forestMesh?.dispose()
    this.object.removeFromParent()
  }

  private dropWorker() {
    this.worker?.terminate()
    this.worker = null
    if (this.busy) {
      this.busy = false
      this.dirty = true
    }
  }

  /** Slices the road samples near the centre into centre-relative typed arrays. */
  private request(cx: number, cz: number, road: FarRoad, covered?: { from: number; to: number }): FarRequest {
    const r2 = ROAD_RADIUS * ROAD_RADIUS
    let lo = -1, hi = -1
    for (let i = 0; i < road.xs.length; i++) {
      const dx = road.xs[i] - cx, dz = road.zs[i] - cz
      if (dx * dx + dz * dz <= r2) {
        if (lo < 0) lo = i
        hi = i
      }
    }
    const count = lo < 0 ? 0 : hi - lo + 1
    const xs = new Float32Array(count), ys = new Float32Array(count)
    const zs = new Float32Array(count), hs = new Float32Array(count)
    for (let k = 0; k < count; k++) {
      const i = lo + k
      xs[k] = road.xs[i] - cx
      ys[k] = road.ys[i]
      zs[k] = road.zs[i] - cz
      hs[k] = road.hs[i]
    }
    return {
      id: this.nextId++,
      centerX: cx,
      centerZ: cz,
      n: this.n,
      extent: EXTENT,
      trees: this.forestMesh ? Math.min(this.trees, this.forestMesh.instanceMatrix.count) : 0,
      road: { xs, ys, zs, hs },
      coveredFrom: covered ? covered.from - lo : 0,
      coveredTo: covered ? covered.to - lo : count - 1,
    }
  }

  /** (Re)builds the grid geometry and its index for n steps per side. */
  private ensureGeometry(n: number) {
    if (this.geoN === n) return
    const side = n + 1
    const verts = side * side
    const geo = new THREE.BufferGeometry()
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts * 3), 3))
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(verts * 3), 3))
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(verts * 3), 3))
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(verts * 2), 2))
    const idx = verts > 65535 ? new Uint32Array(n * n * 6) : new Uint16Array(n * n * 6)
    let k = 0
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * side + i, b = a + 1, c = a + side, d = c + 1
        // (a, c, b) and (b, c, d): counter-clockwise seen from above, so faces point +y.
        // The b–c diagonal matches the tree height interpolation in the worker.
        idx[k++] = a; idx[k++] = c; idx[k++] = b
        idx[k++] = b; idx[k++] = c; idx[k++] = d
      }
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1))
    this.mesh.geometry.dispose()
    this.mesh.geometry = geo
    this.geoN = n
  }

  private apply(res: FarResult) {
    this.ensureGeometry(res.n)
    const geo = this.mesh.geometry
    const put = (name: string, data: Float32Array) => {
      const attr = geo.getAttribute(name) as THREE.BufferAttribute
      ;(attr.array as Float32Array).set(data)
      attr.needsUpdate = true
    }
    put("position", res.positions)
    put("normal", res.normals)
    put("color", res.colors)
    put("uv", res.uvs)
    geo.computeBoundingSphere()
    this.object.position.set(res.centerX, 0, res.centerZ)
    this.mesh.visible = true

    const f = this.forestMesh
    if (f) {
      const count = Math.min(res.trees.length / 4, f.instanceMatrix.count)
      const t = res.trees
      for (let k = 0; k < count; k++) {
        const x = t[k * 4], y = t[k * 4 + 1], z = t[k * 4 + 2], sc = t[k * 4 + 3]
        // Yaw from world position (x, z are centre-relative): stable for a tree that lands in
        // the same world spot after a re-centre, so it doesn't visibly spin.
        const wx = x + res.centerX, wz = z + res.centerZ
        this.q.setFromAxisAngle(this.up, ((wx * 0.137 + wz * 0.071) % 1) * Math.PI * 2)
        // Real tree sizes: 9-16 m tall, half as wide (the atlas cells are 1:2).
        const h = 12 * sc
        this.m4.compose(this.p.set(x, y, z), this.q, this.s.set(h * 0.5, h, h * 0.5))
        f.setMatrixAt(k, this.m4)
      }
      f.count = count
      f.instanceMatrix.needsUpdate = true
      f.computeBoundingSphere()
      f.visible = count > 0
    }
    this.applied = true
  }

  /** Creates (or replaces) the impostor InstancedMesh with capacity for `this.trees`. */
  private makeForest() {
    const { impostorGeometry: g, impostorMaterial: m } = this.opts
    if (!g || !m) return
    const old = this.forestMesh
    if (old) {
      old.removeFromParent()
      old.dispose()
    }
    const f = new THREE.InstancedMesh(g, m, Math.max(1, this.trees))
    f.count = 0
    f.visible = false
    f.castShadow = false
    f.receiveShadow = false
    f.name = "far-forest"
    this.forestMesh = f
    this.object.add(f)
  }
}
