/**
 * Grass field manager: maintains a continuous circular carpet of grass around the car
 * wherever it drives off-road or along the highway.
 *
 * Instead of generating grass per road chunk (which leaves off-road terrain bare and stops
 * ~75 m from the asphalt), this field uses a single InstancedMesh (one draw call) populated
 * from a rolling grid of world cells. Each cell's clump transforms are seeded deterministically
 * by its grid coordinates, ensuring the exact same blades appear whenever returning to an area.
 * Cells stream in smoothly (at most 2 cells filled per frame) to prevent frame stutters, and
 * distant cells beyond the radius are recycled.
 */
import * as THREE from "three"
import { rng } from "./road"
import { TerrainQuery } from "./terrainQuery"

export interface GrassFieldOptions {
  geometry: THREE.BufferGeometry
  material: THREE.Material
  query: TerrainQuery
  cell: number
  radius: number
  perCell: number
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

export class GrassField {
  private readonly geometry: THREE.BufferGeometry
  private readonly material: THREE.Material
  private readonly query: TerrainQuery
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

  /** Car position when the needed-cell grid was last evaluated. */
  private lastEvalX = Infinity
  private lastEvalZ = Infinity
  /** Camera position when the needed-cell grid was last evaluated. */
  private lastEvalCamX = Infinity
  private lastEvalCamZ = Infinity

  /** Cell keys queued during the current evaluation pass to prevent duplicate queueing. */
  private queuedKeys = new Set<string>()

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

    // Extra margin of +3 cells on each side ensures circular coverage without edge clipping
    // regardless of offset. Doubled because car and camera coverage circles can be disjoint.
    const newMaxCells = 2 * (Math.ceil((2 * radius) / this.cell) + 3) ** 2
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
    this.lastEvalX = Infinity
    this.lastEvalZ = Infinity
    this.lastEvalCamX = Infinity
    this.lastEvalCamZ = Infinity
    this.queuedKeys.clear()
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
    const seed = (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) >>> 0
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

  /** Call every frame with the car position and the camera position. Grass covers a circle of `radius` around the car and of 0.75 × radius around the camera. */
  update(x: number, z: number, camX = x, camZ = z): void {
    if (this.disposed) return

    // Throttle evaluation: only re-evaluate grid coverage when car or camera moved > cell/4 or unfinished work exists
    const moveThreshold = this.cell * 0.25
    const moveThresholdSq = moveThreshold * moveThreshold
    const dx = x - this.lastEvalX
    const dz = z - this.lastEvalZ
    const dCamX = camX - this.lastEvalCamX
    const dCamZ = camZ - this.lastEvalCamZ
    const moved =
      dx * dx + dz * dz > moveThresholdSq ||
      dCamX * dCamX + dCamZ * dCamZ > moveThresholdSq

    if (!moved && this.pendingQueue.length === 0) {
      return
    }

    if (moved) {
      this.lastEvalX = x
      this.lastEvalZ = z
      this.lastEvalCamX = camX
      this.lastEvalCamZ = camZ

      const camRadius = 0.75 * this.radius
      const dCamCarX = camX - x
      const dCamCarZ = camZ - z
      const samePoint = dCamCarX * dCamCarX + dCamCarZ * dCamCarZ <= this.cell * this.cell

      // Free cells beyond (radius + cell) from car AND beyond (0.75 * radius + cell) from camera
      const carFreeDist = this.radius + this.cell
      const carFreeDistSq = carFreeDist * carFreeDist
      const camFreeDist = camRadius + this.cell
      const camFreeDistSq = camFreeDist * camFreeDist

      for (const [key, slot] of this.cellsMap) {
        const cellCenterX = (this.slotCx[slot] + 0.5) * this.cell
        const cellCenterZ = (this.slotCz[slot] + 0.5) * this.cell
        const dCarX = cellCenterX - x
        const dCarZ = cellCenterZ - z
        const distCarSq = dCarX * dCarX + dCarZ * dCarZ

        if (distCarSq > carFreeDistSq) {
          const dCamX = cellCenterX - camX
          const dCamZ = cellCenterZ - camZ
          const distCamSq = dCamX * dCamX + dCamZ * dCamZ
          if (distCamSq > camFreeDistSq) {
            this.freeCell(key, slot)
          }
        }
      }

      this.pendingQueue.length = 0
      this.queuedKeys.clear()
      let poolIdx = 0

      // Collect all cells whose center lies within the active radius of the car
      const minCx = Math.floor((x - this.radius) / this.cell)
      const maxCx = Math.floor((x + this.radius) / this.cell)
      const minCz = Math.floor((z - this.radius) / this.cell)
      const maxCz = Math.floor((z + this.radius) / this.cell)
      const radiusSq = this.radius * this.radius

      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const cellCenterX = (cx + 0.5) * this.cell
          const cellCenterZ = (cz + 0.5) * this.cell
          const dCarX = cellCenterX - x
          const dCarZ = cellCenterZ - z
          const distCarSq = dCarX * dCarX + dCarZ * dCarZ
          if (distCarSq <= radiusSq) {
            const key = `${cx},${cz}`
            if (!this.cellsMap.has(key)) {
              this.queuedKeys.add(key)
              const distSq = samePoint
                ? distCarSq
                : Math.min(distCarSq, (cellCenterX - camX) ** 2 + (cellCenterZ - camZ) ** 2)

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
        }
      }

      // Collect all cells within 0.75 * radius of the camera (skip if camera is at the car)
      if (!samePoint) {
        const minCamCx = Math.floor((camX - camRadius) / this.cell)
        const maxCamCx = Math.floor((camX + camRadius) / this.cell)
        const minCamCz = Math.floor((camZ - camRadius) / this.cell)
        const maxCamCz = Math.floor((camZ + camRadius) / this.cell)
        const camRadiusSq = camRadius * camRadius

        for (let cz = minCamCz; cz <= maxCamCz; cz++) {
          for (let cx = minCamCx; cx <= maxCamCx; cx++) {
            const cellCenterX = (cx + 0.5) * this.cell
            const cellCenterZ = (cz + 0.5) * this.cell
            const dCamX = cellCenterX - camX
            const dCamZ = cellCenterZ - camZ
            const distCamSq = dCamX * dCamX + dCamZ * dCamZ
            if (distCamSq <= camRadiusSq) {
              const key = `${cx},${cz}`
              if (!this.cellsMap.has(key) && !this.queuedKeys.has(key)) {
                this.queuedKeys.add(key)
                const dCarX = cellCenterX - x
                const dCarZ = cellCenterZ - z
                const distCarSq = dCarX * dCarX + dCarZ * dCarZ
                const distSq = Math.min(distCarSq, distCamSq)

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
          }
        }
      }

      this.queuedKeys.clear()

      // Sort descending so pop() takes the nearest cell in O(1) time
      this.pendingQueue.sort((a, b) => b.distSq - a.distSq)
    }

    // Process up to 2 pending cells per frame to maintain 60 fps without frame spikes
    let filled = 0
    while (this.pendingQueue.length > 0 && filled < 2 && this.freeSlots.length > 0) {
      const next = this.pendingQueue.pop()!
      const key = `${next.cx},${next.cz}`
      if (!this.cellsMap.has(key)) {
        const slot = this.freeSlots.pop()!
        this.fillCell(next.cx, next.cz, slot, key)
        filled++
      }
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
    this.queuedKeys.clear()
    this._inUseCount = 0
    this.slotCounts = new Int32Array(0)
    this.slotCx = new Int32Array(0)
    this.slotCz = new Int32Array(0)
  }
}
