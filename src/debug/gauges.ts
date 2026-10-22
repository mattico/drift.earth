import { PHYSICS } from '../config';
import type { Assist, CarInput, CarPhysics } from '../car/physics';
import './gauges.css';

const DT = PHYSICS.dt;
const G = 9.81;
const DEG = 180 / Math.PI;
/** History kept, in physics steps: the friction trails, the g-g scatter, the steering strip. */
const TIRE_STEPS = Math.round(1 / DT);
const GG_STEPS = Math.round(10 / DT);
const STEER_STEPS = Math.round(2 / DT);
/** Lamps hold their peak this long (s), so a single-step blip still shows. */
const HOLD = 0.15;
/** Stability control's yaw correction (rad/s²) that lights its lamp fully. */
const STAB_FULL = 4;

/** The cluster's size in CSS px at scale 1 (it shrinks to fit small windows). */
const W = 376;
const H = 352;
const PAD = 8;
/** Space the HUD keeps above and below the gauges (key hints, tach), per layout (see gauges.css). */
const TOP = 100;
const BOTTOM = 236;
const TOP_TOUCH = 200;
const BOTTOM_TOUCH = 220;

// Green gripping and orange sliding, cyan the road wheels: as the overlay's tire arrows.
const GRIP = '#40ff60';
const SLIDE = '#ffa020';
const WHEEL = '#40e0ff';
const CMD = '#ffd23f';
const THROTTLE = '#4ade80';
const BRAKE = '#ff5a5a';
const HAND = '#ffd23f';
const ABS = '#ff6b4a';
const TC = '#ffd23f';
const ESC = '#b48cff';
const BOOST = '#5aa9ff';
const LIMIT = '#ff3b30';
const TEXT = '#eef2f7';
const MUTED = '#9aa6b5';
const FAINT = 'rgba(255, 255, 255, 0.14)';
const BG = 'rgba(255, 255, 255, 0.05)';
const FONT = '600 9px Inter, system-ui, sans-serif';
const TITLE = '800 9px Inter, system-ui, sans-serif';
const GEAR = '900 24px Inter, system-ui, sans-serif';
/** Line dashes, made once (setLineDash takes an array). */
const DASH = [2, 3];
const SOLID: number[] = [];

/** Lamp slots for peak-hold. */
const L_ABS = 0;
const L_TC = 1;
const L_ESC = 2;
const L_LIMIT = 3;

/** The aid lamps, which are also switches: where each sits (x, width), at AID_Y. */
const AIDS: Array<[Assist, number, number]> = [
  ['abs', PAD, 62],
  ['tc', PAD + 66, 62],
  ['esc', PAD + 132, 62],
];
const AID_Y = PAD + 244;
const AID_H = 20;

/** Fixed-length history, `channels` floats per sample; the oldest is overwritten. */
class Ring {
  readonly data: Float32Array;
  count = 0;
  private head = 0;

  constructor(
    readonly size: number,
    readonly channels: number,
  ) {
    this.data = new Float32Array(size * channels);
  }

  /** Offset of a fresh sample to write. */
  push(): number {
    const o = this.head * this.channels;
    this.head = (this.head + 1) % this.size;
    this.count = Math.min(this.count + 1, this.size);
    return o;
  }

  /** Offset of the sample `ago` steps back (0: the newest; `ago` < count). */
  at(ago: number): number {
    return ((this.head - 1 - ago + this.size) % this.size) * this.channels;
  }
}

/**
 * Live gauges over the game view (the View tab's Gauges toggle), after racing
 * games' telemetry apps: per-axle friction circles, a g-g diagram, steering and
 * pedal inputs against what the car made of them, driver-aid lamps and the
 * drivetrain. One Canvas 2D, redrawn every frame from rings filled each step.
 */
export class Gauges {
  readonly root = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  /** Touch and narrow layouts, where the tach sits at the top right. */
  private readonly touch = matchMedia('(pointer: coarse), (max-width: 640px)');
  private scale = 0;
  private dpr = 0;
  private winW = 0;
  private winH = 0;

  /** Per step: front x, y, sliding, rear x, y, sliding; forces in units of each ellipse's larger semi-axis. */
  private readonly tires = new Ring(TIRE_STEPS, 6);
  /** Per step: lateral, longitudinal acceleration (g). */
  private readonly gg = new Ring(GG_STEPS, 2);
  /** Per step: the angle the input asks for, the driver's part (rate-limited) and the road wheels' (rad). */
  private readonly steer = new Ring(STEER_STEPS, 3);
  private readonly lamp = new Float32Array(4);
  private readonly lampT = new Float32Array(4);
  /** The last step's input (copied: the caller may reuse its object). */
  private readonly inp: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

  /** Clickable areas over the aid lamps (the canvas itself lets the mouse through to the game). */
  private readonly aidButtons: Array<[Assist, HTMLButtonElement, number, number]> = [];
  /** Whether each switch's tooltip says on (null before the first draw). */
  private readonly aidShown: Array<boolean | null> = AIDS.map(() => null);

  /** `onToggle` switches an aid when its lamp is clicked. */
  constructor(onToggle: (aid: Assist) => void) {
    this.root.className = 'dbg-gauges';
    this.root.hidden = true;
    this.root.append(this.canvas);
    for (const [aid, x, w] of AIDS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dbg-gauge-switch';
      b.addEventListener('click', () => {
        onToggle(aid);
        // Keep keyboard focus off the button so Space/arrows keep driving.
        b.blur();
      });
      this.aidButtons.push([aid, b, x, w]);
      this.root.append(b);
    }
    this.ctx = this.canvas.getContext('2d')!;
    document.body.append(this.root);
  }

  /** Every physics step, with the input the car drove on. */
  onStep(p: CarPhysics, inp: CarInput): void {
    const c = p.car.chassis;
    const t = p.tire;
    const d = this.tires.data;
    const o = this.tires.push();
    // The front in the road wheels' frame, so its ellipse is the tire's own.
    // Each ring is the axle's grip on the ground under it: μ × surface grip × load.
    const [gF, gR] = p.axleSurface;
    const kF = 1 / (c.muFront * gF.grip * Math.max(t.loadF, 1));
    const cs = Math.cos(p.steer);
    const sn = Math.sin(p.steer);
    d[o] = (t.forceF[0] * cs + t.forceF[1] * sn) * kF;
    d[o + 1] = (-t.forceF[0] * sn + t.forceF[1] * cs) * kF;
    d[o + 2] = t.slideF > 0 ? 1 : 0;
    const kR = 1 / (Math.max(c.muRear, c.muRearSide) * gR.grip * Math.max(t.loadR, 1));
    d[o + 3] = t.forceR[0] * kR;
    d[o + 4] = t.forceR[1] * kR;
    d[o + 5] = t.slideR > 0 ? 1 : 0;

    const g = this.gg.push();
    this.gg.data[g] = p.accelLat / G;
    this.gg.data[g + 1] = p.accelLong / G;

    const s = this.steer.push();
    this.steer.data[s] = Math.max(-1, Math.min(1, inp.steer)) * p.steerLock;
    this.steer.data[s + 1] = p.steerCmd;
    this.steer.data[s + 2] = p.steer;

    const a = p.aids;
    this.hold(L_ABS, a.abs);
    this.hold(L_TC, a.tc);
    this.hold(L_ESC, Math.abs(a.stability));
    this.hold(L_LIMIT, p.drivetrain.limiting ? 1 : 0);
    this.inp.throttle = inp.throttle;
    this.inp.brake = inp.brake;
    this.inp.steer = inp.steer;
    this.inp.handbrake = inp.handbrake;
  }

  /** Every rendered frame; `show` is whether the gauges are on. */
  frame(_dt: number, p: CarPhysics, show: boolean): void {
    this.root.hidden = !show;
    if (!show) return;
    this.layout();
    const ctx = this.ctx;
    const k = this.canvas.width / W;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = 'middle';
    this.drawFriction(p);
    this.drawGG();
    this.drawSteering(p);
    this.drawPedals(p);
    this.drawAids(p);
    this.drawDrivetrain(p);
  }

  dispose(): void {
    this.root.remove();
  }

  // --- Sections ---------------------------------------------------------------

  /** Front and rear friction circles: the grip limit, the force now and its last second. */
  private drawFriction(p: CarPhysics): void {
    const c = p.car.chassis;
    const t = p.tire;
    const fwd = p.car.drive === 'fwd';
    const r = Math.max(c.muRear, c.muRearSide);
    this.circle(PAD + 52, PAD, 0, 1, 1, fwd ? 'FRONT · drive' : 'FRONT · steer', t.loadF);
    this.circle(PAD + 162, PAD, 3, c.muRear / r, c.muRearSide / r, fwd ? 'REAR' : 'REAR · drive', t.loadR);
  }

  /**
   * One axle's friction ellipse (forward up, left to the left) with semi-axes
   * `mx` (longitudinal) and `my` (lateral) as shares of its radius, the force
   * trail from the tire ring at channel `ch`, and the share of grip in use.
   */
  private circle(cx: number, top: number, ch: number, mx: number, my: number, title: string, load: number): void {
    const ctx = this.ctx;
    const R = 42;
    const cy = top + 16 + R;
    this.title(title, cx - 52, top + 6);

    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - R - 4, cy);
    ctx.lineTo(cx + R + 4, cy);
    ctx.moveTo(cx, cy - R - 4);
    ctx.lineTo(cx, cy + R + 4);
    ctx.stroke();
    ctx.setLineDash(DASH);
    ctx.beginPath();
    ctx.ellipse(cx, cy, my * R * 0.5, mx * R * 0.5, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash(SOLID);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, my * R, mx * R, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Trail, oldest first, fading out over the ring.
    const ring = this.tires;
    const d = ring.data;
    const lim = R * 1.3;
    ctx.lineWidth = 1.5;
    for (let ago = ring.count - 1; ago > 0; ago--) {
      const a = ring.at(ago) + ch;
      const b = ring.at(ago - 1) + ch;
      ctx.globalAlpha = 0.6 * (1 - ago / ring.size);
      ctx.strokeStyle = d[b + 2] ? SLIDE : GRIP;
      ctx.beginPath();
      ctx.moveTo(cx - clamp(d[a + 1] * R, lim), cy - clamp(d[a] * R, lim));
      ctx.lineTo(cx - clamp(d[b + 1] * R, lim), cy - clamp(d[b] * R, lim));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    let used = 0;
    if (ring.count) {
      const o = ring.at(0) + ch;
      const x = cx - clamp(d[o + 1] * R, lim);
      const y = cy - clamp(d[o] * R, lim);
      const col = d[o + 2] ? SLIDE : GRIP;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      used = Math.hypot(d[o] / mx, d[o + 1] / my);
    }
    ctx.font = FONT;
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.fillText(`${(load / 1000).toFixed(1)} kN`, cx - 52, top + 128);
    ctx.textAlign = 'right';
    ctx.fillStyle = used > 0.98 ? SLIDE : TEXT;
    ctx.fillText(`${Math.round(used * 100)}%`, cx + 52, top + 128);
  }

  /** Lateral against longitudinal acceleration over the last 10 s, rings at 0.5, 1 and 1.5 g. */
  private drawGG(): void {
    const ctx = this.ctx;
    const x0 = PAD + 220;
    const cx = x0 + 70;
    const cy = PAD + 14 + 54;
    const k = 34; // px per g
    this.title('G-G · 10 s', x0, PAD + 6);
    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 58, cy);
    ctx.lineTo(cx + 58, cy);
    ctx.moveTo(cx, cy - 58);
    ctx.lineTo(cx, cy + 58);
    ctx.stroke();
    for (let ring = 0.5; ring <= 1.5; ring += 0.5) {
      ctx.strokeStyle = ring === 1 ? 'rgba(255, 255, 255, 0.4)' : FAINT;
      ctx.beginPath();
      ctx.arc(cx, cy, ring * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.font = FONT;
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.fillText('1g', cx + k * 0.72 + 2, cy - k * 0.72);

    const ring = this.gg;
    const d = ring.data;
    const lim = 1.7 * k;
    ctx.fillStyle = TEXT;
    for (let ago = ring.count - 1; ago >= 0; ago--) {
      const o = ring.at(ago);
      ctx.globalAlpha = 0.06 + 0.5 * (1 - ago / ring.size);
      ctx.fillRect(cx - clamp(d[o] * k, lim) - 1, cy - clamp(d[o + 1] * k, lim) - 1, 2, 2);
    }
    ctx.globalAlpha = 1;
    if (!ring.count) return;
    const o = ring.at(0);
    const lat = d[o];
    const lon = d[o + 1];
    const x = cx - clamp(lat * k, lim);
    const y = cy - clamp(lon * k, lim);
    ctx.strokeStyle = CMD;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = CMD;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.hypot(lat, lon).toFixed(2)} g`, x0 + 140, PAD + 6);
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'left';
    ctx.fillText(`lat ${signed(lat, 2)}`, x0, PAD + 128);
    ctx.textAlign = 'right';
    ctx.fillText(`long ${signed(lon, 2)}`, x0 + 140, PAD + 128);
  }

  /**
   * Steering: the angle bar (hard lock the frame, the speed-scaled lock the
   * light band) and a 2 s strip of what the input asked for, the driver's
   * rate-limited part and the road wheels with self-alignment.
   */
  private drawSteering(p: CarPhysics): void {
    const ctx = this.ctx;
    const c = p.car.chassis;
    const x0 = PAD;
    const top = PAD + 138;
    const w = 248;
    const cx = x0 + w / 2;
    const k = w / 2 / c.wheelLock;
    this.title('STEER', x0, top + 6);
    ctx.font = FONT;
    ctx.textAlign = 'right';
    ctx.fillStyle = MUTED;
    ctx.fillText(`lock ${(p.steerLock * DEG).toFixed(0)}° / ${(c.wheelLock * DEG).toFixed(0)}°`, x0 + w, top + 6);

    // Angle bar.
    const by = top + 14;
    const bh = 12;
    ctx.fillStyle = BG;
    ctx.fillRect(x0, by, w, bh);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(cx - p.steerLock * k, by, 2 * p.steerLock * k, bh);
    ctx.fillStyle = WHEEL;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(Math.min(cx, cx - p.steer * k), by + 3, Math.abs(p.steer * k), bh - 6);
    ctx.globalAlpha = 1;
    ctx.fillStyle = FAINT;
    ctx.fillRect(cx - 0.5, by, 1, bh);
    ctx.fillStyle = CMD;
    ctx.fillRect(cx - p.steerCmd * k - 1, by, 2, bh);
    const tx = cx - Math.max(-1, Math.min(1, this.inp.steer)) * p.steerLock * k;
    ctx.fillStyle = TEXT;
    ctx.beginPath();
    ctx.moveTo(tx - 4, by - 4);
    ctx.lineTo(tx + 4, by - 4);
    ctx.lineTo(tx, by + 2);
    ctx.fill();

    // Strip: now at the right, left turns up.
    const sy = top + 32;
    const sh = 52;
    const mid = sy + sh / 2;
    const ks = sh / 2 / c.wheelLock;
    ctx.fillStyle = BG;
    ctx.fillRect(x0, sy, w, sh);
    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, mid);
    ctx.lineTo(x0 + w, mid);
    ctx.stroke();
    ctx.setLineDash(DASH);
    ctx.beginPath();
    ctx.moveTo(x0, mid - p.steerLock * ks);
    ctx.lineTo(x0 + w, mid - p.steerLock * ks);
    ctx.moveTo(x0, mid + p.steerLock * ks);
    ctx.lineTo(x0 + w, mid + p.steerLock * ks);
    ctx.stroke();
    ctx.setLineDash(SOLID);
    this.trace(this.steer, 0, x0, w, mid, ks, 'rgba(255, 255, 255, 0.6)');
    this.trace(this.steer, 1, x0, w, mid, ks, CMD);
    this.trace(this.steer, 2, x0, w, mid, ks, WHEEL);

    const ly = top + 94;
    ctx.textAlign = 'left';
    ctx.fillStyle = TEXT;
    ctx.fillText(`▼ in ${signed(this.inp.steer, 2)}`, x0, ly);
    ctx.fillStyle = CMD;
    ctx.fillText(`cmd ${signed(p.steerCmd * DEG, 1)}°`, x0 + 72, ly);
    ctx.fillStyle = WHEEL;
    ctx.fillText(`wheel ${signed(p.steer * DEG, 1)}°`, x0 + 144, ly);
  }

  /** One channel of a ring as a line over the strip at `x0`, `w` wide, newest at the right. */
  private trace(ring: Ring, ch: number, x0: number, w: number, mid: number, k: number, colour: string): void {
    const ctx = this.ctx;
    const d = ring.data;
    const step = w / (ring.size - 1);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let ago = 0; ago < ring.count; ago++) {
      const x = x0 + w - ago * step;
      const y = mid - d[ring.at(ago) + ch] * k;
      if (ago) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }

  /** Pedals: each raw input (pale) beside what the car took from it (solid). */
  private drawPedals(p: CarPhysics): void {
    const x0 = PAD + 258;
    const top = PAD + 138;
    this.title('PEDALS', x0, top + 6);
    const inp = this.inp;
    const y = top + 14;
    const h = 72;
    this.pedal(x0, y, h, inp.throttle, p.throttleF, THROTTLE, 'THR');
    // The foot brake after a key's easing, less what ABS held back.
    this.pedal(x0 + 35, y, h, inp.brake, p.brakeF * (1 - p.aids.abs), BRAKE, 'BRK');
    this.pedal(x0 + 70, y, h, inp.handbrake ? 1 : 0, p.handbrakeF, HAND, 'HB');
  }

  private pedal(x: number, y: number, h: number, raw: number, got: number, colour: string, label: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = BG;
    ctx.fillRect(x, y, 10, h);
    ctx.fillRect(x + 12, y, 10, h);
    ctx.fillStyle = colour;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x, y + h * (1 - raw), 10, h * raw);
    ctx.globalAlpha = 1;
    ctx.fillRect(x + 12, y + h * (1 - got), 10, h * got);
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.fillStyle = MUTED;
    ctx.fillText(label, x + 11, y + h + 8);
  }

  /** Driver-aid lamps (held briefly), stability control's re-arm countdown and the drift light. */
  private drawAids(p: CarPhysics): void {
    const ctx = this.ctx;
    const y = AID_Y;
    const h = AID_H;
    const l = this.lamp;
    const on = p.assists;
    for (let i = 0; i < this.aidButtons.length; i++) {
      const [aid, b] = this.aidButtons[i];
      if (this.aidShown[i] === on[aid]) continue;
      this.aidShown[i] = on[aid];
      b.title = `${aid.toUpperCase()} is ${on[aid] ? 'on' : 'off'}: click to switch it ${on[aid] ? 'off' : 'on'}`;
    }
    const [abs, tc, esc] = AIDS;
    if (on.abs) this.light(abs[1], y, abs[2], h, l[L_ABS], ABS, 'ABS', l[L_ABS] > 0 ? `${Math.round(l[L_ABS] * 100)}%` : '');
    else this.lightOff(abs[1], y, abs[2], h, 'ABS');
    if (on.tc) this.light(tc[1], y, tc[2], h, l[L_TC], TC, 'TC', l[L_TC] > 0 ? `${Math.round(l[L_TC] * 100)}%` : '');
    else this.lightOff(tc[1], y, tc[2], h, 'TC');
    const yaw = l[L_ESC];
    if (on.esc) this.light(esc[1], y, esc[2], h, Math.min(1, yaw / STAB_FULL), ESC, 'ESC', yaw > 0 ? yaw.toFixed(1) : '');
    else this.lightOff(esc[1], y, esc[2], h, 'ESC');
    this.light(PAD + 198, y, 50, h, p.drifting ? 1 : 0, SLIDE, 'DRIFT', '');

    // Stability control stays off this long after a deliberate slide.
    const x = PAD + 254;
    const w = 106;
    const off = p.car.chassis.stabilityOff;
    const share = off > 0 ? Math.min(1, p.aids.rearm / off) : 0;
    ctx.fillStyle = BG;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = ESC;
    ctx.globalAlpha = 0.45;
    ctx.fillRect(x, y, w * share, h);
    ctx.globalAlpha = 1;
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.fillStyle = share > 0 ? TEXT : MUTED;
    ctx.fillText(!on.esc ? 'ESC switched off' : share > 0 ? `ESC re-arm ${p.aids.rearm.toFixed(2)} s` : 'ESC armed', x + w / 2, y + h / 2);
  }

  /** A switched-off aid's lamp: dark, outlined in red, struck through. */
  private lightOff(x: number, y: number, w: number, h: number, label: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = BG;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = LIMIT;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.font = TITLE;
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 5, y + h / 2);
    ctx.font = FONT;
    ctx.textAlign = 'right';
    ctx.fillStyle = LIMIT;
    ctx.fillText('OFF', x + w - 5, y + h / 2);
  }

  private light(x: number, y: number, w: number, h: number, on: number, colour: string, label: string, value: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = BG;
    ctx.fillRect(x, y, w, h);
    if (on > 0) {
      ctx.fillStyle = colour;
      ctx.globalAlpha = 0.25 + 0.75 * on;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
    }
    ctx.font = TITLE;
    ctx.fillStyle = on > 0.4 ? '#0b0e13' : on > 0 ? TEXT : MUTED;
    if (value) {
      ctx.textAlign = 'left';
      ctx.fillText(label, x + 5, y + h / 2);
      ctx.font = FONT;
      ctx.textAlign = 'right';
      ctx.fillText(value, x + w - 5, y + h / 2);
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(label, x + w / 2, y + h / 2);
    }
  }

  /**
   * Gear and box mode; engine rpm against the rpm the driven wheels would turn
   * it at in this gear (the gap is the clutch slipping, or declutched); boost,
   * the limiter, drive force and wheelspin.
   */
  private drawDrivetrain(p: CarPhysics): void {
    const ctx = this.ctx;
    const train = p.drivetrain;
    const D = train.spec;
    const top = PAD + 272;
    this.title('DRIVETRAIN', PAD, top + 6);

    // Gear.
    ctx.font = GEAR;
    ctx.textAlign = 'center';
    ctx.fillStyle = train.shifting ? MUTED : TEXT;
    ctx.fillText(train.gear < 0 ? 'R' : String(train.gear), PAD + 18, top + 30);
    ctx.font = TITLE;
    ctx.fillStyle = train.mode === 'manual' ? CMD : MUTED;
    ctx.fillText(train.mode === 'manual' ? 'MAN' : 'AUTO', PAD + 18, top + 52);

    // Engine rpm against the wheels'.
    const x0 = PAD + 44;
    const w = 360 - 44;
    const by = top + 16;
    const bh = 14;
    const k = w / D.limiter;
    const engine = Math.min(train.rpm, D.limiter);
    const wheelRpm = train.wheelRpm(p.wheelSpeed);
    const wheels = Math.min(wheelRpm, D.limiter);
    ctx.fillStyle = BG;
    ctx.fillRect(x0, by, w, bh);
    ctx.fillStyle = 'rgba(255, 90, 90, 0.3)';
    ctx.fillRect(x0 + D.redline * k, by, (D.limiter - D.redline) * k, bh);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.fillRect(x0, by + 3, engine * k, bh - 6);
    // With the clutch locked the engine turns at the wheels' rpm, and any gap
    // is only the tach's smoothing: the gap is slip only while it is open.
    const slipping = !train.engaged;
    const gap = train.rpm - wheelRpm;
    if (slipping) {
      ctx.fillStyle = SLIDE;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(x0 + Math.min(engine, wheels) * k, by + 3, Math.abs(engine - wheels) * k, bh - 6);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = WHEEL;
    ctx.fillRect(x0 + wheels * k - 1, by - 2, 2, bh + 4);
    ctx.font = FONT;
    ctx.textAlign = 'right';
    ctx.fillStyle = MUTED;
    ctx.fillText(`redline ${D.redline}`, x0 + w, top + 6);

    const ty = top + 38;
    ctx.textAlign = 'left';
    ctx.fillStyle = TEXT;
    ctx.fillText(`engine ${Math.round(train.rpm)}`, x0, ty);
    ctx.fillStyle = WHEEL;
    ctx.fillText(`wheels ${Math.round(wheelRpm)}`, x0 + 70, ty);
    ctx.textAlign = 'right';
    ctx.fillStyle = slipping ? SLIDE : MUTED;
    // Open: off the throttle pulling away, in the air, or a rear-drive car on the handbrake (see CarPhysics.step).
    const open = train.throttle === 0 || p.airborne || (p.car.drive === 'rwd' && p.handbrakeF > 0.3);
    const clutch = !slipping ? 'clutch locked' : train.shifting ? 'shifting' : open ? 'clutch open' : 'clutch slip';
    ctx.fillText(slipping ? `${clutch} ${signed(gap, 0)} rpm` : clutch, x0 + w, ty);

    // Boost, limiter, drive force, wheelspin.
    const ry = top + 48;
    const rh = 14;
    let x = x0;
    if (D.turbo) {
      ctx.fillStyle = BG;
      ctx.fillRect(x, ry, 76, rh);
      ctx.fillStyle = BOOST;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(x, ry, 76 * train.boost, rh);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
      ctx.fillStyle = TEXT;
      ctx.fillText(`boost ${Math.round(train.boost * 100)}%`, x + 4, ry + rh / 2);
      x += 80;
    }
    this.light(x, ry, 34, rh, this.lamp[L_LIMIT], LIMIT, 'LIM', '');
    x += 40;
    ctx.font = FONT;
    ctx.textAlign = 'left';
    ctx.fillStyle = TEXT;
    ctx.fillText(`drive ${(train.force / 1000).toFixed(1)} kN`, x, ry + rh / 2);
    ctx.fillStyle = p.wheelSpin > 0.5 ? SLIDE : MUTED;
    ctx.textAlign = 'right';
    ctx.fillText(`spin ${p.wheelSpin.toFixed(1)} m/s`, x0 + w, ry + rh / 2);
  }

  // --- Helpers ----------------------------------------------------------------

  private title(text: string, x: number, y: number): void {
    const ctx = this.ctx;
    ctx.font = TITLE;
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.fillText(text, x, y);
  }

  /** Peak-hold: lamp `i` shows the highest value of the last HOLD seconds. */
  private hold(i: number, v: number): void {
    if (v >= this.lamp[i]) {
      this.lamp[i] = v;
      this.lampT[i] = HOLD;
    } else if ((this.lampT[i] -= DT) <= 0) this.lamp[i] = v;
  }

  /** Sizes the canvas for the window and pixel ratio: scaled down to fit between the HUD's corners. */
  private layout(): void {
    const dpr = devicePixelRatio || 1;
    if (dpr === this.dpr && innerWidth === this.winW && innerHeight === this.winH) return;
    this.dpr = dpr;
    this.winW = innerWidth;
    this.winH = innerHeight;
    const touch = this.touch.matches;
    const room = innerHeight - (touch ? TOP_TOUCH + BOTTOM_TOUCH : TOP + BOTTOM);
    // Up to a quarter larger on big screens, but no wider than 30% of the window
    // (or, on a narrow one, the window less its gutters).
    const wide = Math.max(innerWidth * 0.3, Math.min(W, innerWidth - 32));
    this.scale = Math.max(0.5, Math.min(1.25, room / H, wide / W));
    const cw = Math.round(W * this.scale);
    const chh = Math.round(H * this.scale);
    this.canvas.style.width = `${cw}px`;
    this.canvas.style.height = `${chh}px`;
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(chh * dpr);
    const s = this.scale;
    for (const [, b, x, w] of this.aidButtons) {
      b.style.left = `${x * s}px`;
      b.style.top = `${AID_Y * s}px`;
      b.style.width = `${w * s}px`;
      b.style.height = `${AID_H * s}px`;
    }
  }
}

function clamp(v: number, lim: number): number {
  return v < -lim ? -lim : v > lim ? lim : v;
}

/** `v` to `digits` places with an explicit sign. */
function signed(v: number, digits: number): string {
  const s = v.toFixed(digits);
  return v >= 0 ? `+${s}` : s;
}
