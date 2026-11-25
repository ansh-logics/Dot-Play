/**
 * Static obstacles on the ground plane (palm and tree trunks, concrete barriers).
 *
 * Why circles on the ground plane:
 * Vertical props hit by a car can be modelled as 2D circles (x, z, radius) because the
 * car operates near the ground plane and collisions occur at bumper height. Approximating
 * obstacles as 2D ground circles avoids expensive 3D mesh queries and triangle intersections,
 * enabling cheap, robust collision detection and impulse responses.
 *
 * Why owners:
 * Obstacles are spawned and culled along with road chunks as the player drives. Grouping
 * circles by an owner key (typically the chunk index or entity ID) allows road streaming
 * systems to register or discard entire batches of obstacles in a single operation.
 *
 * Why a 16 m spatial hash rebuilt on set/remove:
 * Road chunks load or unload rarely (once every few seconds), while collision queries occur
 * every physics substep (60–120 Hz). Rebuilding a contiguous flat Float32Array and spatial
 * hash map during chunk transitions makes query() completely zero-allocation, cache-friendly,
 * and restricted to a tight 2×2 or 3×3 grid of 16 m cells around the vehicle.
 */

/** Cell size in metres for spatial partitioning. Matches local chunk prop density. */
const CELL_SIZE = 16

/** Offset added to grid coordinates to ensure cell indices remain non-negative over ±524 km. */
const CELL_OFFSET = 32768

/** Coordinate stride (2^16) used to pack (cx, cz) into a unique numeric key. */
const CELL_STRIDE = 65536

export class ColliderSet {
  private owners = new Map<number, Float32Array>()
  private flat = new Float32Array(0)
  private cells = new Map<number, number[]>()

  /** Registers (or replaces) an owner's circles: a Float32Array of x, z, r triples (copied). */
  set(owner: number, circles: Float32Array): void {
    this.owners.set(owner, new Float32Array(circles))
    this.rebuild()
  }

  /**
   * Removes an owner's circles (e.g. when a road chunk is despawned) and updates
   * the spatial acceleration structures.
   */
  remove(owner: number): void {
    if (this.owners.delete(owner)) {
      this.rebuild()
    }
  }

  /**
   * Writes every circle whose centre is within `range` of (x, z) into `out` as x, z, r
   * triples and returns how many circles were written (stops when `out` is full).
   * No allocation: uses a spatial hash with 16 m cells, rebuilt on set/remove.
   */
  query(x: number, z: number, range: number, out: Float32Array): number {
    if (range < 0) return 0
    const maxCircles = Math.floor(out.length / 3)
    if (maxCircles === 0) return 0

    const rangeSq = range * range
    const minCx = Math.floor((x - range) / CELL_SIZE)
    const maxCx = Math.floor((x + range) / CELL_SIZE)
    const minCz = Math.floor((z - range) / CELL_SIZE)
    const maxCz = Math.floor((z + range) / CELL_SIZE)

    let written = 0
    const flat = this.flat

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const key = (cx + CELL_OFFSET) * CELL_STRIDE + (cz + CELL_OFFSET)
        const indices = this.cells.get(key)
        if (!indices) continue

        for (let i = 0; i < indices.length; i++) {
          const base = indices[i] * 3
          const circleX = flat[base]
          const circleZ = flat[base + 1]
          const dx = circleX - x
          const dz = circleZ - z

          if (dx * dx + dz * dz <= rangeSq) {
            const outBase = written * 3
            out[outBase] = circleX
            out[outBase + 1] = circleZ
            out[outBase + 2] = flat[base + 2]
            written++
            if (written >= maxCircles) {
              return written
            }
          }
        }
      }
    }

    return written
  }

  /** Total number of active collider circles across all registered owners. */
  get size(): number {
    return Math.floor(this.flat.length / 3)
  }

  /**
   * Rebuilds the flat contiguous circle buffer and spatial hash table.
   * Done whenever chunks stream in or out; keeping query() fast and zero-allocation
   * is worth the occasional re-index cost during streaming events.
   */
  private rebuild(): void {
    let totalFloats = 0
    for (const arr of this.owners.values()) {
      totalFloats += arr.length
    }

    const circleCount = Math.floor(totalFloats / 3)
    const flat = new Float32Array(circleCount * 3)

    let offset = 0
    for (const arr of this.owners.values()) {
      const count = Math.floor(arr.length / 3) * 3
      if (count > 0) {
        flat.set(arr.subarray(0, count), offset)
        offset += count
      }
    }

    this.flat = flat
    this.cells = new Map<number, number[]>()

    for (let i = 0; i < circleCount; i++) {
      const base = i * 3
      const x = flat[base]
      const z = flat[base + 1]
      const cx = Math.floor(x / CELL_SIZE)
      const cz = Math.floor(z / CELL_SIZE)
      const key = (cx + CELL_OFFSET) * CELL_STRIDE + (cz + CELL_OFFSET)

      const bucket = this.cells.get(key)
      if (bucket) {
        bucket.push(i)
      } else {
        this.cells.set(key, [i])
      }
    }
  }
}
