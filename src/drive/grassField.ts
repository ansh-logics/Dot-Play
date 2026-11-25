/**
 * Grass field manager: maintains a continuous carpet of grass following the camera's
 * view direction (capsule) wherever the car drives off-road or along the highway.
 *
 * Instead of generating grass per road chunk (which leaves off-road terrain bare and stops
 * ~75 m from the asphalt), this field uses a single InstancedMesh (one draw call) populated
 * from a rolling grid of world cells. Each cell's clump transforms are seeded deterministically
 * by its grid coordinates, ensuring the exact same blades appear whenever returning to an area.
 * Tufts fade at the edge so streaming is invisible, cells stream in smoothly with a time budget
 * per frame to prevent frame stutters, and distant cells beyond the radius are recycled.
 */
import * as THREE from "three"
import { rng } from "./road"
import { TerrainQuery } from "./terrainQuery"
import type { GrassFade } from "./vegetation"

export interface GrassFieldOptions {
  geometry: THREE.BufferGeometry
  material: THREE.Material
  query: TerrainQuery
  cell: number
  radius: number
  perCell: number
  /** Multiplies every tuft's size (the far field uses bigger, sparser tufts). Default 1. */
  scale?: number
  /** Mixed into each cell's seed so two fields never place identical tufts. Default 0. */
  salt?: number
  /** Shader uniforms this field keeps pointed at its reach (see grassFade()). */
  fade?: GrassFade
}

interface PendingCell {
  cx: number
  cz: number
  distSq: number
}

/** Sunk 5 cm into the ground so card roots remain securely anchored on uneven slopes. */
const GROUND_SINK = 0.05

/** Maximum slope height difference over 0.8 m; prevents grass sticking out horizontally on cliffs. */
const MAX_SLOPE_DIFF = 0.55

/** Zero-scale matrix used to hide inactive or leftover instance slots without drawing overhead. */
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0)
const UP = new THREE.Vector3(0, 1, 0)
const WHITE = new THREE.Color(1, 1, 1)

/** Grass clump color palette: base green, vibrant lush emerald, and warm sun-baked golden yellow. */
const COLOR_BASE = new THREE.Color("#669a33")
const COLOR_LUSH = new THREE.Color("#4a8a2b")
const COLOR_DRY = new THREE.Color("#a99a55")

// Module-scoped scratch objects reused across frames to ensure zero per-frame garbage allocation.
const scratchPos = new THREE.Vector3()
const scratchScale = new THREE.Vector3()
const scratchQuat = new THREE.Quaternion()
const scratchMat = new THREE.Matrix4()
const scratchColor = new THREE.Color()

/** Squared distance from (px, pz) to the segment a→b. */
function segDistSq(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const abx = bx - ax, abz = bz - az
  const l = abx * abx + abz * abz
  const t = l > 0 ? Math.min(1, Math.max(0, ((px - ax) * abx + (pz - az) * abz) / l)) : 0
  const dx = px - (ax + abx * t), dz = pz - (az + abz * t)
  return dx * dx + dz * dz
}

/** Time per frame spent filling new cells, ms (at least one cell always fills). */
const FILL_BUDGET_MS = 2

/** How far past the car (× radius) coverage reaches, and its cap along the view (× radius). */
const AHEAD = 0.8
const MAX_REACH = 2.5

export class GrassField {
  private readonly geometry: THREE.BufferGeometry
  private readonly material: THREE.Material
  private readonly query: TerrainQuery
  private readonly scale: number
  private readonly salt: number
  private readonly fade: GrassFade | undefined
  private cell: number
  private radius: number
  private perCell: number
  private maxCells = 0
  private capacity = 0
  private _mesh!: THREE.InstancedMesh
  private disposed = false

  /** Map of active grid cell keys ("cx,cz") to their allocated instance slot index. */
  private cellsMap = new Map<string, number>()
  /** Stack of free slot indices available for recycling. */
  private freeSlots: number[] = []
  /** Clumps placed per slot (<= perCell). */
  private slotCounts = new Int32Array(0)
  /** Cell cx and cz per slot for fast distance checks without string allocation or parsing. */
  private slotCx = new Int32Array(0)
  private slotCz = new Int32Array(0)

  /** Total active instances currently drawn (excluding hidden zero-scale instances). */
  private _inUseCount = 0

  private lastEvalAX = Infinity
  private lastEvalAZ = Infinity
  private lastEvalBX = Infinity
  private lastEvalBZ = Infinity

  /** Current reach segment (camera → past the car), world x/z. */
  private ax = 0
  private az = 0
  private bx = 0
  private bz = 0

  /** Pending needed cells sorted nearest-first for progressive filling. */
  private pendingQueue: PendingCell[] = []
  /** Pre-allocated object pool for pending cells to prevent heap churn. */
  private pendingPool: PendingCell[] = []

  /**
   * The InstancedMesh holding the field. If setDensity changes capacity, a new mesh is created
   * and the caller must re-add it to the scene.
   */
  get mesh(): THREE.InstancedMesh {
    return this._mesh
  }

  constructor(opts: GrassFieldOptions) {
    this.geometry = opts.geometry
    this.material = opts.material
    this.query = opts.query
    this.cell = opts.cell
    this.radius = opts.radius
    this.perCell = opts.perCell
    this.scale = opts.scale ?? 1
    this.salt = opts.salt ?? 0
    this.fade = opts.fade

    this.allocate(opts.perCell, opts.radius, true)
  }

  /**
   * Allocates or rebuilds the InstancedMesh and slot pools.
   * If capacity is unchanged during a quality tier update, the existing mesh is retained
   * to avoid requiring the caller to rebuild scene graphs.
   */
  private allocate(perCell: number, radius: number, isInitial: boolean): void {
    this.perCell = perCell
    this.radius = radius

    // The reach is a capsule: radius around a segment up to MAX_REACH × radius long.
    const newMaxCells = (Math.ceil(((2 + MAX_REACH) * radius) / this.cell) + 3) * (Math.ceil((2 * radius) / this.cell) + 3)
    const newCapacity = newMaxCells * perCell

    if (isInitial || newCapacity !== this.capacity) {
      if (!isInitial) {
        this._mesh.dispose()
      }
      this.maxCells = newMaxCells
      this.capacity = newCapacity
      this._mesh = this.createMesh(newCapacity)
    } else {
      // Re-initialize all instances to zero scale when retaining the existing mesh
      for (let i = 0; i < this.capacity; i++) {
        this._mesh.setMatrixAt(i, ZERO_MATRIX)
      }
      this._mesh.count = this.capacity
      this._mesh.instanceMatrix.needsUpdate = true
    }

    this.cellsMap.clear()
    this.freeSlots = []
    for (let i = this.maxCells - 1; i >= 0; i--) {
      this.freeSlots.push(i)
    }
    this.slotCounts = new Int32Array(this.maxCells)
    this.slotCx = new Int32Array(this.maxCells)
    this.slotCz = new Int32Array(this.maxCells)
    this._inUseCount = 0

    this.pendingQueue.length = 0
    this.lastEvalAX = Infinity
    this.lastEvalAZ = Infinity
    this.lastEvalBX = Infinity
    this.lastEvalBZ = Infinity
  }

  /**
   * Creates and configures the InstancedMesh for rendering.
   * Frustum culling is disabled because the dynamic field moves with the car.
   * Shadows: receives shadows from sun and street lamps, but does not cast them to protect fill rate.
   */
  private createMesh(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity)
    mesh.frustumCulled = false
    mesh.castShadow = false
    mesh.receiveShadow = true

    if (this.material.userData.windDepth) {
      mesh.customDepthMaterial = this.material.userData.windDepth
    }

    // Allocate instanceColor buffer attribute so setColorAt is available for per-instance tinting
    mesh.setColorAt(0, WHITE)

    // Hide all instances initially by scaling them to 0; drawing them costs virtually nothing visible
    for (let i = 0; i < capacity; i++) {
      mesh.setMatrixAt(i, ZERO_MATRIX)
    }
    mesh.count = capacity
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true

    return mesh
  }

  /**
   * Generates grass clumps for a cell using deterministic PRNG seeded by cell coordinates.
   * Clumps are tested against surface type and ground slope, and leftover instances are hidden.
   */
  private fillCell(cx: number, cz: number, slot: number, key: string): void {
    // 32-bit integer hash ensures exact same grass positions whenever returning to this cell
    const seed = ((Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) ^ this.salt) >>> 0
    const r = rng(seed)

    const minX = cx * this.cell
    const minZ = cz * this.cell
    const maxTries = this.perCell * 2
    let placed = 0

    for (let attempt = 0; attempt < maxTries && placed < this.perCell; attempt++) {
      const px = minX + r() * this.cell
      const pz = minZ + r() * this.cell

      const surface = this.query.surfaceAt(px, pz)
      // Never place grass on the road asphalt or submerged in water
      if (surface === "road" || surface === "water") continue
      // Thin out grass on gravel shoulders and sandy beaches
      if (surface === "shoulder" && r() >= 0.6) continue
      if (surface === "sand" && r() >= 0.25) continue

      const y = this.query.heightAt(px, pz)
      // Discard placements on cliff edges or steep embankments where clumps would poke out horizontally
      if (Math.abs(this.query.heightAt(px + 0.8, pz) - y) > MAX_SLOPE_DIFF) continue
      if (Math.abs(this.query.heightAt(px, pz + 0.8) - y) > MAX_SLOPE_DIFF) continue

      // Scale variation: smaller tufts on sand (dune grass), full-sized inland
      let s = 0.65 + r() * 0.7
      if (surface === "sand") s *= 0.75
      s *= this.scale

      // Sink slightly into ground so blade bases do not hover above local terrain concavities
      scratchPos.set(px, y - GROUND_SINK, pz)
      scratchQuat.setFromAxisAngle(UP, r() * Math.PI * 2)
      scratchScale.set(s, s * (0.8 + r() * 0.5), s)
      scratchMat.compose(scratchPos, scratchQuat, scratchScale)

      const instanceIdx = slot * this.perCell + placed
      this._mesh.setMatrixAt(instanceIdx, scratchMat)

      // Color variation: blend base green towards lush emerald or dry summer gold
      const isDry = surface === "sand" ? r() < 0.8 : r() < 0.25
      const targetColor = isDry ? COLOR_DRY : COLOR_LUSH
      scratchColor.copy(COLOR_BASE).lerp(targetColor, r() * 0.7)
      this._mesh.setColorAt(instanceIdx, scratchColor)

      placed++
    }

    // Hide any unfilled instances in this slot
    for (let i = placed; i < this.perCell; i++) {
      this._mesh.setMatrixAt(slot * this.perCell + i, ZERO_MATRIX)
    }

    // Mark only the modified slot range for GPU upload
    this._mesh.instanceMatrix.addUpdateRange(slot * this.perCell * 16, this.perCell * 16)
    this._mesh.instanceMatrix.needsUpdate = true
    if (this._mesh.instanceColor) {
      this._mesh.instanceColor.addUpdateRange(slot * this.perCell * 3, this.perCell * 3)
      this._mesh.instanceColor.needsUpdate = true
    }

    this.cellsMap.set(key, slot)
    this.slotCounts[slot] = placed
    this.slotCx[slot] = cx
    this.slotCz[slot] = cz
    this._inUseCount += placed
  }

  /**
   * Frees a cell that has moved outside the active radius, recycling its slot index.
   */
  private freeCell(key: string, slot: number): void {
    for (let i = 0; i < this.perCell; i++) {
      this._mesh.setMatrixAt(slot * this.perCell + i, ZERO_MATRIX)
    }

    this._mesh.instanceMatrix.addUpdateRange(slot * this.perCell * 16, this.perCell * 16)
    this._mesh.instanceMatrix.needsUpdate = true
    if (this._mesh.instanceColor) {
      this._mesh.instanceColor.addUpdateRange(slot * this.perCell * 3, this.perCell * 3)
      this._mesh.instanceColor.needsUpdate = true
    }

    this._inUseCount -= this.slotCounts[slot]
    this.slotCounts[slot] = 0
    this.cellsMap.delete(key)
    this.freeSlots.push(slot)
  }

  /**
   * Call every frame with the car, the camera and the camera's view direction (x/z, any
   * length). Grass covers every cell within `radius` of a segment from the camera along its
   * view to a little past the car, so it follows what the camera sees, including the
   * ground behind the car when a fly-by looks back at it.
   */
  update(x: number, z: number, camX = x, camZ = z, dirX = 0, dirZ = 0): void {
    if (this.disposed) return

    let fx = dirX, fz = dirZ
    if (fx * fx + fz * fz < 1e-6) {
      fx = x - camX
      fz = z - camZ
    }
    const fl = Math.hypot(fx, fz)
    if (fl > 1e-6) {
      fx /= fl
      fz /= fl
    } else {
      fx = 0
      fz = 0
    }
    const reach = Math.min(MAX_REACH * this.radius, Math.hypot(x - camX, z - camZ) + AHEAD * this.radius)
    this.ax = camX
    this.az = camZ
    this.bx = camX + fx * reach
    this.bz = camZ + fz * reach
    if (this.fade) {
      this.fade.uGrassA.value.set(this.ax, this.az)
      this.fade.uGrassB.value.set(this.bx, this.bz)
      this.fade.uGrassR.value = this.radius
    }

    // Re-evaluate coverage only when either end of the segment moved more than cell/4.
    const th = (this.cell * 0.25) ** 2
    const moved =
      (this.ax - this.lastEvalAX) ** 2 + (this.az - this.lastEvalAZ) ** 2 > th ||
      (this.bx - this.lastEvalBX) ** 2 + (this.bz - this.lastEvalBZ) ** 2 > th
    if (!moved && this.pendingQueue.length === 0) return

    if (moved) {
      this.lastEvalAX = this.ax
      this.lastEvalAZ = this.az
      this.lastEvalBX = this.bx
      this.lastEvalBZ = this.bz
      const { ax, az, bx, bz } = this

      // Free cells that left the reach (their tufts had already shrunk to nothing).
      const freeSq = (this.radius + this.cell) ** 2
      for (const [key, slot] of this.cellsMap) {
        const ccx = (this.slotCx[slot] + 0.5) * this.cell
        const ccz = (this.slotCz[slot] + 0.5) * this.cell
        if (segDistSq(ccx, ccz, ax, az, bx, bz) > freeSq) this.freeCell(key, slot)
      }

      // Queue every missing cell whose centre is within the reach, nearest the camera first.
      this.pendingQueue.length = 0
      let poolIdx = 0
      const r = this.radius
      const minCx = Math.floor((Math.min(ax, bx) - r) / this.cell)
      const maxCx = Math.floor((Math.max(ax, bx) + r) / this.cell)
      const minCz = Math.floor((Math.min(az, bz) - r) / this.cell)
      const maxCz = Math.floor((Math.max(az, bz) + r) / this.cell)
      const rSq = r * r
      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const ccx = (cx + 0.5) * this.cell
          const ccz = (cz + 0.5) * this.cell
          if (segDistSq(ccx, ccz, ax, az, bx, bz) > rSq) continue
          if (this.cellsMap.has(`${cx},${cz}`)) continue
          const distSq = (ccx - ax) ** 2 + (ccz - az) ** 2
          let item = this.pendingPool[poolIdx]
          if (!item) {
            item = { cx, cz, distSq }
            this.pendingPool[poolIdx] = item
          } else {
            item.cx = cx
            item.cz = cz
            item.distSq = distSq
          }
          this.pendingQueue.push(item)
          poolIdx++
        }
      }
      // Sort descending so pop() takes the nearest cell.
      this.pendingQueue.sort((a, b) => b.distSq - a.distSq)
    }

    // Fill nearest-first within a small time budget, so a jump in the camera never stutters.
    const t0 = performance.now()
    while (this.pendingQueue.length > 0 && this.freeSlots.length > 0) {
      const next = this.pendingQueue.pop()!
      const key = `${next.cx},${next.cz}`
      if (this.cellsMap.has(key)) continue
      this.fillCell(next.cx, next.cz, this.freeSlots.pop()!, key)
      if (performance.now() - t0 > FILL_BUDGET_MS) break
    }
  }

  /** Change density/radius (quality tier): reallocates and refills. */
  setDensity(perCell: number, radius: number): void {
    if (this.disposed) return
    this.allocate(perCell, radius, false)
  }

  /** Cells currently filled, and instances in use (for the stats overlay). */
  get cells(): number {
    return this.cellsMap.size
  }

  get count(): number {
    return this._inUseCount
  }

  /** Disposes the InstancedMesh only (geometry/material are shared, owned by the caller). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this._mesh.dispose()
    this.cellsMap.clear()
    this.freeSlots.length = 0
    this.pendingQueue.length = 0
    this.pendingPool.length = 0
    this._inUseCount = 0
    this.slotCounts = new Int32Array(0)
    this.slotCx = new Int32Array(0)
    this.slotCz = new Int32Array(0)
  }
}
