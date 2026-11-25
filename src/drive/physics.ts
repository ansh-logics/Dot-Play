/**
 * Car physics for the drive: a dynamic bicycle model on four sprung corners, so the car
 * turns and moves like a car (it grips, understeers, slides on grass, rolls downhill,
 * dips under braking) and can leave the road, while staying cheap and hard to break.
 *
 * Deliberately not a simulator: two axles instead of four tyres for the horizontal forces,
 * a three-degree body (heave, pitch, roll) on springs for the vertical, and the springs'
 * forces are the axle loads, so a car with its wheels in the air has no grip.
 *
 * Frames: yaw 0 faces +z and increasing yaw turns LEFT (the road's heading convention);
 * forward = (sin yaw, cos yaw), right = (-cos yaw, sin yaw), the ocean side of the road.
 * Internally lateral velocity and yaw rate are right-positive (`vr`, `rr`), which is the
 * standard bicycle model mirrored; the equations are unchanged by the mirror.
 *
 * Body angles follow the engine's `group.rotation.set(pitch, yaw, roll, "YXZ")`:
 * positive pitch = nose down, positive roll = left side up (right side down).
 */
import * as THREE from "three"
import { LANE, ROAD_HALF, Road, STEP } from "./road"
import { newLocation, type RoadLocation, type Surface, type TerrainQuery } from "./terrainQuery"
import type { ColliderSet } from "./collisions"

export interface DriveControls {
  /** 0..1 */
  throttle: number
  /** 0..1; held at a standstill it reverses. */
  brake: number
  /** -1..1, + = turn right (towards the ocean side). */
  steer: number
  boost: boolean
  handbrake: boolean
}

export interface CarSpec {
  mass: number
  wheelbase: number
  track: number
  cgHeight: number
  wheelRadius: number
  /** Steering lock at walking pace, radians. */
  maxSteer: number
  /** Watts at the wheels. */
  enginePower: number
  /** m/s; boost raises it. */
  maxSpeed: number
}

const DEFAULTS: CarSpec = {
  mass: 1300,
  wheelbase: 2.65,
  track: 1.62,
  cgHeight: 0.48,
  wheelRadius: 0.34,
  maxSteer: (32 * Math.PI) / 180,
  enginePower: 185_000,
  maxSpeed: 44,
}

const G = 9.81
const SUB = 1 / 120
const MAX_DT = 0.1

/** Steering lock at speed: narrows to this, so the car is calm on the motorway. */
const MIN_STEER = (6 * Math.PI) / 180
/** Speed scale (m/s) over which the lock narrows. */
const STEER_FADE = 7
/** Steering rates, rad/s: turning in, and returning (faster, like a self-centring wheel). */
const STEER_RATE = 1.9
const RETURN_RATE = 3.2

/** Suspension: travel from full droop to bump stop, and the static compression at rest. */
export const TRAVEL = 0.12
export const REST_COMPRESSION = 0.06
/** Body inertias (kg·m²): yaw, pitch, roll. A low, short coupe. */
const I_YAW = 1850
const I_PITCH = 1700
const I_ROLL = 480
/** Damping ratio of each corner. Soft-ish sports car: settles in a bounce and a half. */
const ZETA = 0.42

/** Tyre curve: shape factor and stiffness (per radian of slip). Rear a touch stiffer = stable. */
const TYRE_C = 1.4
const TYRE_B_FRONT = 9.5
const TYRE_B_REAR = 11

/** Below this speed the model blends to kinematic steering (no jitter, no spin at rest). */
const KIN_LO = 2.5
const KIN_HI = 6
const REVERSE_MAX = 7
const REVERSE_FORCE = 4200

const AERO = 0.42 // ½ρ·Cd·A, N per (m/s)²
const ENGINE_BRAKE = 380 // N when coasting

const GRIP: Record<Surface, number> = { road: 1, shoulder: 0.85, grass: 0.6, sand: 0.45, water: 0.3 }
const ROLLING: Record<Surface, number> = { road: 0.012, shoulder: 0.022, grass: 0.05, sand: 0.09, water: 0.2 }
/** Off-road bump amplitude, metres. Asphalt is smooth. */
const BUMPS: Record<Surface, number> = { road: 0, shoulder: 0.008, grass: 0.03, sand: 0.02, water: 0 }

/** Lowest contact height in the sea: the car wades instead of sinking to the sea floor. */
const WADE = -0.35
/** Water: velocity drag (1/s) and the push back towards the road (m/s²). */
const WATER_DRAG = 1.6
const WATER_PUSH = 3.5

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Linear at small slip, peaks around 0.15–0.2 rad, then falls off a little (so it can slide). */
function tyre(alpha: number, fMax: number, b: number) {
  return fMax * Math.sin(TYRE_C * Math.atan(b * clamp(alpha, -1.4, 1.4)))
}

// ---- Bump noise (own copy; road.ts keeps its noise private) -----------------------------

function hash2(ix: number, iz: number) {
  let h = Math.imul(ix, 1597334677) + Math.imul(iz, 3812015801) + 0x27d4eb2d
  h = Math.imul(h ^ (h >>> 15), 2246822519)
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296
}

function vnoise(x: number, z: number) {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = x - ix, fz = z - iz
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1)
  return (a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz) * 2 - 1
}

/** Smooth ruts and tussocks: a 1.6 m and a 0.6 m wave, so springs see rolls, not spikes. */
const roughness = (x: number, z: number) => vnoise(x * 0.62, z * 0.62) * 0.7 + vnoise(x * 1.7 + 31, z * 1.7 - 17) * 0.3

export class CarPhysics {
  readonly spec: CarSpec

  /** Body origin at ground contact (what the engine puts the car group at). */
  readonly position = new THREE.Vector3()
  yaw = 0
  pitch = 0
  roll = 0
  /** Forward speed, m/s (negative when reversing). */
  speed = 0
  /** Sideways speed, m/s, + = sliding right. Useful for tyre squeal and smoke. */
  lateralSpeed = 0
  /** Yaw rate, rad/s, + = turning left (same sense as yaw). */
  yawRate = 0
  /** Front wheel angle, radians, + = right. */
  steerAngle = 0
  /** Obstacles to collide with (set by the engine). */
  colliders: ColliderSet | null = null
  /** Speed (m/s) of the last impact into an obstacle, decaying over ~0.5 s (camera shake). */
  impact = 0
  private hits = new Float32Array(96)
  /** Accumulated wheel rotation for rotation.x, wrapped to ±2π·64 to keep precision. */
  wheelSpin = 0
  /** Wheel travel relative to rest, metres, + = pushed up into the arch. FL, FR, RL, RR. */
  readonly wheelCompression: [number, number, number, number] = [0, 0, 0, 0]
  /** Brake (or handbrake) pressed while moving, or decelerating hard: brake lights. */
  braking = false
  /** Under the car's centre. */
  surface: Surface = "road"
  /** Latest locate() of the car centre; .s drives chunks, minimap and odometer. */
  readonly location: RoadLocation = newLocation()
  /** 0..1: how much of the car's weight the ground carries (0 = airborne). */
  grounded = 1
  /** Rolling backwards (reverse lights). */
  reversing = false
  /** Peak tyre slip this step, 0..1+ (≥ 1 = past the grip peak): for squeal. */
  slip = 0

  // Horizontal state.
  private x = 0
  private z = 0
  private vr = 0
  private rr = 0
  // Body (vertical) state.
  private bodyY = 0
  private bodyVy = 0
  private pitchVel = 0
  private rollVel = 0
  /** Filtered accelerations (m/s²) for weight transfer and brake lights. */
  private ax = 0
  private ay = 0
  private standstill = 0
  // The last step's pedals, for the brake lights.
  private lastBrake = 0
  private lastHand = false
  private lastThrottle = 0

  // Derived constants.
  private readonly a: number // CG to front axle
  private readonly b: number // CG to rear axle
  private readonly k: number // corner spring rate
  private readonly c: number // corner damping

  // Per-corner scratch: lon (+ = front), lat left (+ = left), loads, compressions.
  private readonly lon: number[]
  private readonly latL: number[]
  private readonly comp = [0, 0, 0, 0]
  private readonly prevComp = [0, 0, 0, 0]
  private readonly load = [0, 0, 0, 0]
  private readonly ground = [0, 0, 0, 0]
  private readonly wheelSurf: Surface[] = ["road", "road", "road", "road"]
  private readonly wheelLoc = [newLocation(), newLocation(), newLocation(), newLocation()]
  private fresh = true

  // Last finite state, for recovery.
  private safeX = 0
  private safeZ = 0
  private safeYaw = 0

  readonly query: TerrainQuery

  constructor(query: TerrainQuery, spec?: Partial<CarSpec>) {
    this.query = query
    this.spec = { ...DEFAULTS, ...spec }
    const s = this.spec
    this.a = s.wheelbase / 2
    this.b = s.wheelbase / 2
    const cornerMass = s.mass / 4
    this.k = (cornerMass * G) / REST_COMPRESSION
    this.c = 2 * ZETA * Math.sqrt(this.k * cornerMass)
    const ht = s.track / 2
    this.lon = [this.a, this.a, -this.b, -this.b]
    this.latL = [ht, -ht, ht, -ht]
  }

  /** Places the car at rest at (x, z) facing `yaw`, optionally already rolling at `speed`. */
  reset(x: number, z: number, yaw: number, speed = 0) {
    this.x = x
    this.z = z
    this.yaw = yaw
    this.speed = speed
    this.vr = 0
    this.rr = 0
    this.pitch = this.roll = this.pitchVel = this.rollVel = 0
    this.ax = this.ay = 0
    this.steerAngle = 0
    this.query.resetHint()
    this.query.locate(x, z, this.location)
    this.bodyY = this.query.heightAtLocation(this.location, x, z)
    this.bodyVy = 0
    this.fresh = true
    this.safeX = x
    this.safeZ = z
    this.safeYaw = yaw
    this.publish()
  }

  /** Steering lock at a speed, radians: wide when parking, narrow at motorway speed. */
  maxSteerAt(speed: number) {
    const s = this.spec
    const v = Math.max(0, Math.abs(speed) - 3)
    return MIN_STEER + (s.maxSteer - MIN_STEER) * Math.exp(-v / STEER_FADE)
  }

  /** Throttle that roughly holds `v` on flat asphalt (feed-forward for cruise control). */
  holdThrottle(v: number) {
    const s = this.spec
    const resist = AERO * v * v + ROLLING.road * s.mass * G
    const fade = 1 - Math.pow(clamp(v / s.maxSpeed, 0, 1), 4)
    const drive = (s.enginePower / Math.max(4, v)) * Math.max(0.05, fade)
    return clamp(resist / drive, 0, 1)
  }

  /** Advances by dt (clamped) in equal fixed-ish sub-steps no longer than 1/120 s. */
  step(dt: number, controls: DriveControls) {
    if (!(dt > 0)) return
    this.lastBrake = controls.brake
    this.lastHand = controls.handbrake
    this.lastThrottle = controls.throttle
    dt = Math.min(dt, MAX_DT)
    const n = Math.ceil(dt / SUB - 1e-6)
    const h = dt / n
    for (let i = 0; i < n; i++) this.sub(h, controls)
    this.impact *= Math.exp(-dt * 6)
    this.publish()
  }

  private sub(h: number, ctl: DriveControls) {
    const s = this.spec
    const m = s.mass
    const throttle = clamp(ctl.throttle || 0, 0, 1)
    const brakeIn = clamp(ctl.brake || 0, 0, 1)
    const steerIn = clamp(ctl.steer || 0, -1, 1)

    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw)
    const fx = sinY, fz = cosY // forward
    const rx = -cosY, rz = sinY // right
    let vx = this.speed

    // ---- Steering: speed-sensitive lock, rate-limited, self-centring ----------------
    // Steering assist: never steer much past the angle the tyres can still grip at this
    // speed (ideal angle for ~0.95 g of cornering plus the tyre's peak slip). Beyond that
    // the front tyres only scrub, which felt like slamming the brakes in sharp turns.
    const v2 = Math.max(vx * vx, 1)
    const assist = Math.atan((s.wheelbase * 9.3) / v2) + 0.11
    const lock = vx > 7 ? Math.min(this.maxSteerAt(vx), assist) : this.maxSteerAt(vx)
    const target = steerIn * lock
    const returning = Math.abs(target) < Math.abs(this.steerAngle) && Math.sign(target) !== -Math.sign(this.steerAngle)
    const rate = (returning ? RETURN_RATE : STEER_RATE) * h
    this.steerAngle += clamp(target - this.steerAngle, -rate, rate)
    this.steerAngle = clamp(this.steerAngle, -lock - 0.02, lock + 0.02)
    const delta = this.steerAngle

    // ---- Ground under each wheel and the centre ---------------------------------------
    const q = this.query
    q.locate(this.x, this.z, this.location)
    const centreGround = q.heightAtLocation(this.location, this.x, this.z)
    this.surface = q.surfaceOf(this.location, centreGround)
    for (let i = 0; i < 4; i++) {
      const wx = this.x + fx * this.lon[i] - rx * this.latL[i]
      const wz = this.z + fz * this.lon[i] - rz * this.latL[i]
      const loc = q.locate(wx, wz, this.wheelLoc[i])
      let g = q.heightAtLocation(loc, wx, wz)
      const surf = q.surfaceOf(loc, g)
      this.wheelSurf[i] = surf
      const amp = BUMPS[surf]
      if (amp > 0) g += amp * roughness(wx, wz)
      this.ground[i] = Math.max(WADE, g)
    }

    // ---- Suspension: four spring-dampers carry the body --------------------------------
    const sp = Math.sin(this.pitch), sr = Math.sin(this.roll)
    let sumF = 0, tPitch = 0, tRoll = 0
    for (let i = 0; i < 4; i++) {
      const cornerY = this.bodyY - this.lon[i] * sp + this.latL[i] * sr
      const comp = this.ground[i] - cornerY + REST_COMPRESSION
      const compVel = this.fresh ? 0 : (comp - this.prevComp[i]) / h
      this.prevComp[i] = comp
      this.comp[i] = comp
      let f = 0
      if (comp > 0) {
        f = this.k * comp + this.c * compVel
        // Bump stop: much stiffer past the travel, so the body never sinks into the ground.
        if (comp > TRAVEL) f += 8 * this.k * (comp - TRAVEL) + 2 * this.c * Math.max(0, compVel)
        f = clamp(f, 0, 12 * m * G)
      }
      this.load[i] = f
      sumF += f
      tPitch -= f * this.lon[i]
      tRoll += f * this.latL[i]
    }
    this.fresh = false
    this.grounded = clamp(sumF / (m * G), 0, 1.5)
    // Weight transfer: braking dips the nose, accelerating squats, corners roll outwards.
    tPitch -= m * this.ax * s.cgHeight
    tRoll -= m * this.ay * s.cgHeight
    this.bodyVy += (sumF / m - G) * h
    this.bodyY += this.bodyVy * h
    this.pitchVel += (tPitch / I_PITCH) * h
    this.rollVel += (tRoll / I_ROLL) * h
    this.pitch += this.pitchVel * h
    this.roll += this.rollVel * h

    // ---- Tyre loads and grip ------------------------------------------------------------
    const fzF = this.load[0] + this.load[1]
    const fzR = this.load[2] + this.load[3]
    const muF = (GRIP[this.wheelSurf[0]] + GRIP[this.wheelSurf[1]]) / 2
    const muR = (GRIP[this.wheelSurf[2]] + GRIP[this.wheelSurf[3]]) / 2
    let crr = 0
    for (let i = 0; i < 4; i++) crr += ROLLING[this.wheelSurf[i]] / 4
    const inWater = this.surface === "water"

    // ---- Longitudinal forces --------------------------------------------------------------
    const power = s.enginePower * (ctl.boost ? 1.5 : 1) * (inWater ? 0.3 : 1)
    const vmax = s.maxSpeed * (ctl.boost ? 62 / 44 : 1)
    if (Math.abs(vx) < 0.3 && throttle < 0.05) this.standstill += h
    else if (brakeIn < 0.05) this.standstill = 0
    // Holding brake at a standstill reverses, like most driving games.
    const reversing = brakeIn > 0.5 && throttle < 0.05 && (vx < -0.2 || this.standstill > 0.25)
    let fDrive = 0
    if (throttle > 0 && vx > -0.5) {
      const fade = 1 - Math.pow(clamp(vx / vmax, 0, 1), 4)
      fDrive = throttle * (power / Math.max(4, Math.abs(vx))) * fade
      // Traction limit. Forgiving (as if part of the drive reached the front), so the car
      // can climb a grassy bank instead of spinning its wheels at the bottom.
      fDrive = Math.min(fDrive, 0.8 * (muR * fzR + muF * fzF))
    } else if (reversing) {
      fDrive = -brakeIn * REVERSE_FORCE * (vx > -REVERSE_MAX ? 1 : 0)
      fDrive = Math.max(fDrive, -muR * fzR)
    }
    // Throttle while still rolling backwards brakes first (drive only engages above -0.5 m/s),
    // otherwise only rolling resistance would stop a car reversing at speed.
    const footBrake = reversing ? 0 : Math.max(brakeIn, vx < -0.5 ? throttle : 0)
    // 60/40 split of ~0.95 g, each axle capped by its own grip (front gains load under braking).
    const brakeTotal = footBrake * 0.95 * ((muF + muR) / 2) * (fzF + fzR)
    const brakeF = Math.min(brakeTotal * 0.6, muF * fzF)
    const brakeR = Math.min(brakeTotal * 0.4, muR * fzR) + (ctl.handbrake ? 0.75 * muR * fzR : 0)
    const coast = throttle < 0.05 && !reversing && Math.abs(vx) > 1 ? ENGINE_BRAKE : 0
    // Retarding forces oppose motion but never reverse it (no jitter at rest).
    const retard = brakeF + Math.min(brakeR, muR * fzR) + crr * m * G * this.grounded + coast

    // Gravity along the ground, from the wheels' contact heights.
    const slopeF = (this.ground[0] + this.ground[1] - this.ground[2] - this.ground[3]) / (2 * s.wheelbase)
    const slopeR = (this.ground[1] + this.ground[3] - this.ground[0] - this.ground[2]) / (2 * s.track)
    const gLoad = clamp(this.grounded, 0, 1)
    const gFwd = (-G * slopeF) / Math.sqrt(1 + slopeF * slopeF) * gLoad
    const gRight = (-G * slopeR) / Math.sqrt(1 + slopeR * slopeR) * gLoad

    // ---- Lateral: dynamic bicycle model, blended to kinematic at walking pace ----------
    const k = vx > 0 ? smooth(KIN_LO, KIN_HI, vx) : 0
    const cosD = Math.cos(delta), sinD = Math.sin(delta)
    let fyF = 0, fyR = 0
    let dvr = 0, drr = 0
    if (k > 0) {
      const vxs = Math.max(vx, 1)
      const alphaF = delta - Math.atan2(this.vr + this.a * this.rr, vxs)
      const alphaR = -Math.atan2(this.vr - this.b * this.rr, vxs)
      // Friction circle: braking at the front and drive/handbrake at the rear eat lateral grip.
      const capF = muF * fzF
      // Drive is shared 40/60 front/rear here (a forgiving, AWD-like feel) and capped by a
      // light traction control, so flooring it mid-corner pushes wide instead of spinning.
      const fxF = Math.min(brakeF + fDrive * 0.4, capF * 0.7) // ABS-ish: some steering survives a stamp
      const maxF = Math.sqrt(Math.max(capF * capF - fxF * fxF, capF * capF * 0.25))
      const capR = muR * fzR * (ctl.handbrake ? 0.45 : 1)
      const fxR = Math.min(fDrive * 0.6 + brakeR, capR * (ctl.handbrake ? 1 : 0.75))
      const maxR = Math.sqrt(Math.max(0, capR * capR - fxR * fxR))
      fyF = tyre(alphaF, maxF, TYRE_B_FRONT)
      fyR = tyre(alphaR, maxR, TYRE_B_REAR)
      dvr = (fyF * cosD + fyR) / m - vx * this.rr + gRight
      drr = (this.a * fyF * cosD - this.b * fyR) / I_YAW
      this.slip = Math.max(Math.abs(alphaF), Math.abs(alphaR)) / 0.18
    } else {
      this.slip = 0
    }

    // Forward: drive, gravity, drag, plus the steered front tyre's rearward component.
    // The steered tyre's rearward pull, softened: an arcade-friendly 35% (full value made every sharp turn feel like braking).
    let dvx = (fDrive - fyF * sinD * 0.35 - AERO * vx * Math.abs(vx)) / m + gFwd + k * this.vr * this.rr * 0.5
    vx += dvx * h
    const stop = (retard / m) * h
    vx = Math.abs(vx) <= stop ? 0 : vx - Math.sign(vx) * stop
    if (reversing) vx = Math.max(vx, -REVERSE_MAX)

    // Lateral and yaw: integrate the dynamic model, then blend to kinematic at low speed.
    let vr = this.vr + dvr * h
    let rr = this.rr + drr * h
    if (k < 1) {
      const rrK = (vx * Math.tan(delta)) / s.wheelbase
      const vrK = rrK * this.b
      // Without tyres doing it, a side slope or a slide still needs to bleed off.
      vr = vrK + (vr - vrK) * k
      rr = rrK + (rr - rrK) * k
    }
    // Off the ground nothing turns the car; keep what it had, slowly.
    if (this.grounded < 0.05) rr *= 1 - 0.5 * h

    // ---- Water: heavy drag and a push back towards the road --------------------------
    if (inWater) {
      const d = Math.exp(-WATER_DRAG * h)
      vx *= d
      vr *= d
      const side = this.location.off > 0 ? -1 : 1
      const px = this.location.rx * side * WATER_PUSH, pz = this.location.rz * side * WATER_PUSH
      vx += (px * fx + pz * fz) * h
      vr += (px * rx + pz * rz) * h
    }

    // ---- Clamp and integrate ------------------------------------------------------------
    vx = clamp(vx, -REVERSE_MAX - 2, vmax + 15)
    vr = clamp(vr, -25, 25)
    rr = clamp(rr, -4, 4)
    dvx = (vx - this.speed) / h
    this.speed = vx
    this.vr = vr
    this.rr = rr
    this.x += (fx * vx + rx * vr) * h
    this.z += (fz * vx + rz * vr) * h
    this.yaw -= rr * h
    if (this.colliders) this.collide(fx, fz, rx, rz)

    // Accelerations for weight transfer, filtered (~60 ms) so the body eases into it.
    const f = 1 - Math.exp(-h / 0.06)
    this.ax += (clamp(dvx, -15, 15) - this.ax) * f
    this.ay += (clamp(vx * rr + dvr, -15, 15) - this.ay) * f

    this.wheelSpin += (vx / s.wheelRadius) * h
    if (Math.abs(this.wheelSpin) > Math.PI * 128) this.wheelSpin %= Math.PI * 2

    this.recover(centreGround)
  }

  /**
   * The car body as three overlapping circles (nose, middle, tail) against obstacle circles:
   * push out of anything it overlaps, kill the speed going into it with a little bounce,
   * keep most of the speed along it (so it scrapes along a barrier), and twist the car a
   * little when the hit is off-centre.
   */
  private collide(fx: number, fz: number, rx: number, rz: number) {
    const set = this.colliders!
    const n = set.query(this.x, this.z, 6, this.hits)
    if (n === 0) return
    const CAR_R = 0.95
    for (let c = 0; c < 3; c++) {
      const o = (c - 1) * 1.45 // tail, middle, nose
      for (let i = 0; i < n; i++) {
        const ox = this.hits[i * 3], oz = this.hits[i * 3 + 1], or = this.hits[i * 3 + 2]
        const cx = this.x + fx * o, cz = this.z + fz * o
        let nx = cx - ox, nz = cz - oz
        const d = Math.hypot(nx, nz)
        const pen = CAR_R + or - d
        if (pen <= 0 || d < 1e-4) continue
        nx /= d
        nz /= d
        this.x += nx * pen
        this.z += nz * pen
        // World velocity from body velocity.
        let vwx = fx * this.speed + rx * this.vr
        let vwz = fz * this.speed + rz * this.vr
        const vn = vwx * nx + vwz * nz
        if (vn < 0) {
          vwx -= 1.2 * vn * nx
          vwz -= 1.2 * vn * nz
          // Friction along the obstacle.
          const tn = vwx * nx + vwz * nz
          vwx = nx * tn + (vwx - nx * tn) * 0.85
          vwz = nz * tn + (vwz - nz * tn) * 0.85
          this.speed = vwx * fx + vwz * fz
          this.vr = vwx * rx + vwz * rz
          this.impact = Math.max(this.impact, -vn)
          // Off-centre hits twist the car (nose hits turn it away from the obstacle).
          const side = nx * rx + nz * rz
          this.rr = clamp(this.rr - o * side * -vn * 0.06, -3, 3)
        }
      }
    }
  }

  /** Never NaN, never flipped, never under the ground: ease back to something sane. */
  private recover(centreGround: number) {
    const ok =
      Number.isFinite(this.x) && Number.isFinite(this.z) && Number.isFinite(this.yaw) &&
      Number.isFinite(this.speed) && Number.isFinite(this.vr) && Number.isFinite(this.rr) &&
      Number.isFinite(this.bodyY) && Number.isFinite(this.bodyVy) &&
      Number.isFinite(this.pitch) && Number.isFinite(this.roll) &&
      Number.isFinite(this.pitchVel) && Number.isFinite(this.rollVel)
    if (!ok) {
      this.reset(this.safeX, this.safeZ, this.safeYaw)
      return
    }
    // A sports car on springs never needs more than this; past it, damp it back.
    const LIM = 0.45
    if (Math.abs(this.pitch) > LIM) {
      this.pitch = Math.sign(this.pitch) * LIM
      this.pitchVel *= -0.2
    }
    if (Math.abs(this.roll) > LIM) {
      this.roll = Math.sign(this.roll) * LIM
      this.rollVel *= -0.2
    }
    this.pitchVel = clamp(this.pitchVel, -6, 6)
    this.rollVel = clamp(this.rollVel, -6, 6)
    const ground = Math.max(WADE, centreGround)
    if (this.bodyY < ground - 0.3) {
      this.bodyY = ground - 0.3
      if (this.bodyVy < 0) this.bodyVy = 0
    }
    this.bodyVy = clamp(this.bodyVy, -40, 15)
    // Keep the yaw near zero so float precision never drifts on long drives.
    if (this.yaw > Math.PI * 64 || this.yaw < -Math.PI * 64) this.yaw %= Math.PI * 2
    this.safeX = this.x
    this.safeZ = this.z
    this.safeYaw = this.yaw
  }

  /** Copies internal state into the public read-only fields. */
  private publish() {
    this.position.set(this.x, this.bodyY, this.z)
    this.lateralSpeed = this.vr
    this.yawRate = -this.rr
    // Compressions are FL, FR, RL, RR; internal corners are ordered the same.
    for (let i = 0; i < 4; i++) {
      this.wheelCompression[i] = clamp(this.comp[i], -0.02, TRAVEL + 0.03) - REST_COMPRESSION
    }
    this.braking =
      (this.speed > 0.5 && (this.lastBrake > 0.05 || this.lastHand)) ||
      (this.speed < -0.5 && this.lastThrottle > 0.05) ||
      this.ax < -3.2
    this.reversing = this.speed < -0.2
  }
}

// ---- Autopilot ---------------------------------------------------------------------------

export interface AutopilotOptions {
  /** Lateral target, metres, + = ocean side. The engine drives in the right lane, LANE. */
  lane: number
  /** Cruise speed, m/s. */
  cruise: number
  /** Frame time, for smoothing pedals; defaults to 1/60. */
  dt?: number
  /** Relaxed cornering: lateral acceleration it plans bends for, m/s². */
  latAccel?: number
}

/** Comfortable braking it plans with, m/s². */
const AP_DECEL = 2.4
const AP_SCRATCH = { x: 0, y: 0, z: 0, heading: 0 }

/**
 * Drives like a calm human: pure pursuit to a point ahead in the lane, slows before bends
 * (so the brake lights come on by themselves) and powers out of them.
 */
export function autopilot(car: CarPhysics, road: Road, opts: AutopilotOptions, out: DriveControls): DriveControls {
  const dt = opts.dt ?? 1 / 60
  const lane = Number.isFinite(opts.lane) ? opts.lane : LANE
  const latMax = opts.latAccel ?? 3.5
  const v = car.speed
  const loc = car.location
  const offRoad = Math.abs(loc.off) > ROAD_HALF + 1

  // ---- Steering: pure pursuit ---------------------------------------------------------
  // Off the road: aim nearer and blend the target lane in, so it eases back on.
  const look = (offRoad ? 14 : 8) + 0.9 * Math.max(0, v)
  const p = road.sample(loc.s + look, AP_SCRATCH)
  const prx = -Math.cos(p.heading), prz = Math.sin(p.heading)
  const tx = p.x + prx * lane - car.position.x
  const tz = p.z + prz * lane - car.position.z
  const sinY = Math.sin(car.yaw), cosY = Math.cos(car.yaw)
  const fwd = tx * sinY + tz * cosY
  const right = -tx * cosY + tz * sinY
  const d2 = Math.max(1, fwd * fwd + right * right)
  // Curvature of the arc through the target (+ = curving right).
  const kappa = (2 * right) / d2
  let steerAngle = Math.atan(car.spec.wheelbase * kappa)
  // Damping: steer against the yaw rate that the arc doesn't ask for (no weaving).
  const wantRate = -kappa * Math.max(0, v) // left-positive like yawRate
  steerAngle += 0.06 * (car.yawRate - wantRate)
  // A little direct lane-keeping: pure pursuit alone runs wide through long bends at speed.
  if (!offRoad) steerAngle += clamp((lane - loc.off) * 0.004, -0.02, 0.02)
  // Pure pursuit asks for almost nothing when the target is far away or behind (a car left
  // facing the hills); steer by the bearing to it instead, which always turns it round.
  const bearing = Math.atan2(right, fwd)
  const lost = offRoad ? 1 : smooth(0.35, 0.9, Math.abs(bearing))
  steerAngle += (bearing - steerAngle) * lost
  const lock = car.maxSteerAt(v)
  let steer = clamp(steerAngle / lock, -1, 1)
  if (offRoad) steer = clamp(steer, -0.7, 0.7)
  out.steer = steer

  // ---- Speed: cruise, capped by the bends ahead -----------------------------------------
  let target = offRoad ? Math.min(opts.cruise, 12) : opts.cruise
  if (Math.abs(bearing) > 1.2) target = Math.min(target, 7) // turning round: gently
  const horizon = (v * v) / (2 * AP_DECEL) + 30
  const i0 = Math.max(1, Math.floor(loc.s / STEP))
  const iEnd = i0 + Math.ceil(horizon / STEP)
  road.ensure((iEnd + 3) * STEP)
  const hs = road.hs
  for (let i = i0; i <= iEnd; i += 2) {
    const kap = Math.abs(hs[i + 1] - hs[i - 1]) / (2 * STEP)
    if (kap < 1e-5) continue
    const vBend = Math.sqrt(latMax / kap)
    const dist = Math.max(0, i * STEP - loc.s - 6)
    const allowed = Math.sqrt(vBend * vBend + 2 * AP_DECEL * dist)
    if (allowed < target) target = allowed
  }

  const err = target - v
  let throttle = 0, brake = 0
  if (err > -0.6) throttle = clamp(car.holdThrottle(Math.max(target, 0)) + err * 0.25, 0, 1)
  // Small overspeed: coast. Real overspeed: brake in proportion.
  if (err < -0.8 && v > 1) brake = clamp((-err - 0.8) * 0.12, 0, 0.6)
  const a = 1 - Math.exp(-dt * 4)
  out.throttle += (throttle - (out.throttle || 0)) * a
  out.brake += (brake - (out.brake || 0)) * a
  if (!Number.isFinite(out.throttle)) out.throttle = 0
  if (!Number.isFinite(out.brake)) out.brake = 0
  if (brake === 0 && out.brake < 0.02) out.brake = 0
  out.boost = false
  out.handbrake = false
  return out
}
