import { MathUtils, PerspectiveCamera, Vector3, type Matrix4 } from 'three';
import { CAMERA as C, PHYSICS } from './config';

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
  pitchPreset = 0;
  private shake = 0;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(C.fov, aspect, 1, 6000);
  }

  cyclePitch(): void {
    this.pitchPreset = (this.pitchPreset + 1) % C.pitchPresets.length;
  }

  zoomBy(factor: number): void {
    this.zoom = MathUtils.clamp(this.zoom * factor, C.minZoom, C.maxZoom);
  }

  addShake(amount: number): void {
    this.shake = Math.min(1.5, this.shake + amount);
  }

  /** Hard-sets the camera behind `pos` facing `heading`. */
  snap(pos: Vector3, heading: number, distance = C.distance): void {
    this.target.copy(pos);
    this.yaw = heading;
    this.distance = distance;
    this.pitch = C.pitchPresets[this.pitchPreset];
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

    const speedT = Math.min(1, speed / PHYSICS.topSpeed);
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
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    _back.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
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
