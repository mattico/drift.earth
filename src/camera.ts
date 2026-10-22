import { MathUtils, PerspectiveCamera, Vector3, type Matrix4 } from 'three';
import { CAMERA as C } from './config';

const _back = new Vector3();

/**
 * Top-down chase camera tilted slightly behind the car. Distance is tuned to
 * the resolution of Google's photorealistic tiles; it pulls back with speed.
 */
export class ChaseCamera {
  readonly camera: PerspectiveCamera;
  readonly target = new Vector3();
  yaw = 0;
  distance: number = C.distance;
  pitch: number = C.pitchPresets[0];
  zoom = 1;
  /** The car's top speed (m/s): the camera pulls back and tilts toward it. */
  topSpeed = 50;
  pitchPreset = 0;
  /** Free camera: orbit and tilt on top of the chase view, easing back once let go. */
  orbitYaw = 0;
  orbitPitch = 0;
  /** Let go of the stick and the free camera eases back behind the car; off, it stays where it was left. */
  recenter = true;
  private orbitIdle = Infinity;
  private shake = 0;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(C.fov, aspect, 1, 6000);
  }

  /** Steps through the pitch presets (`dir` +1 next, −1 previous), wrapping round or stopping at either end. */
  cyclePitch(dir = 1, wrap = true): void {
    const n = C.pitchPresets.length;
    this.pitchPreset = wrap ? (this.pitchPreset + dir + n) % n : MathUtils.clamp(this.pitchPreset + dir, 0, n - 1);
  }

  /**
   * Free camera: `x` orbits around the car and `y` tilts (stick up looks up,
   * toward the horizon), as rates, −1…1. Let go and it eases back behind the car.
   */
  look(x: number, y: number, dt: number): void {
    if (x || y) {
      this.orbitIdle = 0;
      this.orbitYaw = wrapAngle(this.orbitYaw - x * C.orbitRate * dt);
      this.orbitPitch += y * C.orbitTiltRate * dt;
    } else {
      this.orbitIdle += dt;
      if (this.recenter && this.orbitIdle > C.orbitHold) {
        const k = 1 - Math.exp(-dt / C.orbitReturnTau);
        this.orbitYaw -= this.orbitYaw * k;
        this.orbitPitch -= this.orbitPitch * k;
      }
    }
  }

  /**
   * Free camera from a mouse drag: orbits and tilts by the drag (fractions of
   * the screen height), moving the same way as the stick. Held still, it stays.
   */
  drag(x: number, y: number): void {
    this.orbitIdle = 0;
    this.orbitYaw = wrapAngle(this.orbitYaw - x * C.dragRate);
    this.orbitPitch += y * C.dragRate;
  }

  /** The direction the camera faces (yaw about +Y, like a heading), free camera included. */
  get viewYaw(): number {
    return this.yaw + this.orbitYaw;
  }

  zoomBy(factor: number): void {
    this.zoom = MathUtils.clamp(this.zoom * factor, C.minZoom, C.maxZoom);
  }

  addShake(amount: number): void {
    this.shake = Math.min(1.5, this.shake + amount);
  }

  /** Hard-sets the camera behind `pos` facing `heading` (at the preset pitch unless given). */
  snap(pos: Vector3, heading: number, distance = C.distance, pitch = C.pitchPresets[this.pitchPreset]): void {
    this.target.copy(pos);
    this.yaw = heading;
    this.distance = distance;
    this.pitch = pitch;
    this.orbitYaw = this.orbitPitch = 0;
    this.orbitIdle = Infinity;
    this.apply();
  }

  follow(dt: number, pos: Vector3, heading: number, vel: Vector3, drifting: boolean): void {
    const speed = Math.hypot(vel.x, vel.z);

    // Yaw follows a blend of heading and travel direction so drifts don't whip the view.
    const fx = -Math.sin(heading);
    const fz = -Math.cos(heading);
    const wVel = speed > 2 ? (drifting ? 0.6 : 0.4) : 0;
    const bx = fx * (1 - wVel) + (speed > 0 ? (vel.x / speed) * wVel : 0);
    const bz = fz * (1 - wVel) + (speed > 0 ? (vel.z / speed) * wVel : 0);
    const yawTarget = Math.atan2(-bx, -bz);
    this.yaw += wrapAngle(yawTarget - this.yaw) * (1 - Math.exp(-dt / C.yawTau));

    const speedT = Math.min(1, speed / this.topSpeed);
    const dTarget = Math.min(C.maxDistance, C.distance + C.distancePerSpeed * speed) * this.zoom;
    this.distance += (dTarget - this.distance) * (1 - Math.exp(-dt / C.distanceTau));
    const pTarget = Math.min(MathUtils.degToRad(85), C.pitchPresets[this.pitchPreset] + C.pitchSpeedBonus * speedT);
    this.pitch += (pTarget - this.pitch) * (1 - Math.exp(-dt / 0.5));

    // Look ahead of the car so more of the road ahead is on screen.
    const ahead = Math.min(C.lookAheadMax, speed * C.lookAheadTime);
    const tx = pos.x + (speed > 0.1 ? (vel.x / speed) * ahead : 0) + fx * C.forwardBias * this.distance;
    const tz = pos.z + (speed > 0.1 ? (vel.z / speed) * ahead : 0) + fz * C.forwardBias * this.distance;
    const k = 1 - Math.exp(-dt / C.targetTau);
    this.target.x += (tx - this.target.x) * k;
    this.target.z += (tz - this.target.z) * k;
    this.target.y += (pos.y - this.target.y) * (1 - Math.exp(-dt / 0.3));

    this.shake *= Math.exp(-dt / 0.25);
    this.apply();
  }

  private apply(): void {
    // Keep the free camera's tilt between near-horizontal and straight down.
    const pitch = MathUtils.clamp(this.pitch + this.orbitPitch, C.orbitMinPitch, MathUtils.degToRad(88));
    this.orbitPitch = pitch - this.pitch;
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const yaw = this.viewYaw;
    _back.set(Math.sin(yaw), 0, Math.cos(yaw));
    const cam = this.camera;
    cam.position.set(
      this.target.x + _back.x * cp * this.distance,
      this.target.y + sp * this.distance,
      this.target.z + _back.z * cp * this.distance,
    );
    if (this.shake > 0.01) {
      const s = this.shake * 0.6;
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      cam.position.z += (Math.random() - 0.5) * s;
    }
    cam.up.set(0, 1, 0);
    cam.lookAt(this.target);
    cam.far = Math.max(2000, this.distance * 6);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  rebase(m: Matrix4, yaw: number): void {
    this.target.applyMatrix4(m);
    this.yaw += yaw;
    this.apply();
  }
}

export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
