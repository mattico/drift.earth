// Read-only plots in the Tuning tab, alongside the torque curve's: the tires'
// grip against slip, the gearing (the rpm sawtooth, and thrust against drag)
// and the steering lock against speed. Each sits at the top of its group, is
// drawn from the working spec with the formulas the sim itself uses, and
// carries live markers for the car being driven while its group is open.

import { MathUtils } from 'three';
import type { CarSpec, ChassisSpec, DrivetrainSpec } from '../car/cars';
import { torqueAt } from '../car/drivetrain';
import { tireCurve, type CarPhysics } from '../car/physics';
import { MPH } from '../ui';
import './tuningPlots.css';

export interface TuningPlot {
  /** The tuning group it's shown in. */
  readonly group: string;
  readonly el: HTMLElement;
  /** Its curves are out of date: an edit landed while its group was closed. */
  stale: boolean;
  /** Redraws the curves from the spec. */
  draw(): void;
  /** Moves the live markers (each frame while its group is showing). */
  live(time: number, p: CarPhysics): void;
}

/** The plots, drawn from `spec()`: the working copy, which loading a preset replaces. */
export function tuningPlots(spec: () => CarSpec): TuningPlot[] {
  return [tirePlot(spec), gearingPlot(spec), steeringPlot(spec)];
}

const DEG = 180 / Math.PI;
const RPM_PER_RAD_S = 60 / (2 * Math.PI);
/** Plot headroom over the tallest line. */
const HEADROOM = 1.2;
/** Seconds of live slip the tire plot trails. */
const TRAIL_S = 1.5;
const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
const SVG = '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">';

// --- Building blocks ----------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, cls: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  e.setAttribute('class', cls);
  return e;
}

/** A wide tuning row: its label (help in the tooltip), then the plot and its key. */
function shell(label: string, help: string): { row: HTMLElement; plot: HTMLElement } {
  const row = el('div', 'tun-field tun-wide tpl-row');
  const l = el('label', 'tun-label', label);
  l.title = help;
  const ctl = el('div', 'tun-ctl tun-curve-wrap');
  const plot = el('div', 'tun-plot');
  ctl.append(plot);
  row.append(l, ctl);
  return { row, plot };
}

/** One graph box: a layer redrawn on edits, under one for live svg marks (dots go in the box itself). */
interface Graph {
  box: HTMLElement;
  curves: HTMLElement;
  marks: SVGSVGElement;
}

function graph(cls = ''): Graph {
  const box = el('div', `tun-graph tpl-graph ${cls}`.trim());
  const curves = el('div', 'tun-layer');
  const live = el('div', 'tun-layer');
  live.innerHTML = `${SVG}</svg>`;
  box.append(curves, live);
  return { box, curves, marks: live.firstChild as SVGSVGElement };
}

function dot(cls: string): HTMLElement {
  const d = el('div', `tun-live ${cls}`);
  d.hidden = true;
  return d;
}

/** A vertical live line (at the current speed or slip) in a graph's live layer. */
function liveLine(g: Graph): SVGLineElement {
  const l = svgEl('line', 'tun-rpm');
  l.setAttribute('y1', '0');
  l.setAttribute('y2', '100');
  l.setAttribute('visibility', 'hidden');
  g.marks.append(l);
  return l;
}

function moveLine(l: SVGLineElement, x: number): void {
  const s = x.toFixed(2);
  l.setAttribute('x1', s);
  l.setAttribute('x2', s);
  l.setAttribute('visibility', 'visible');
}

function place(d: HTMLElement, x: number, y: number): void {
  d.hidden = false;
  d.style.left = `${x}%`;
  d.style.top = `${y}%`;
}

/** A graph's scale: x and y run from 0 to these, in the units plotted. */
interface Scale {
  x: number;
  y: number;
}

// Percentages of the box, as in the torque plot (its svg's viewBox is 0–100
// both ways), clamped so live markers stay inside it.
const px = (s: Scale, x: number) => MathUtils.clamp(x / s.x, 0, 1) * 100;
const py = (s: Scale, y: number) => 98 - MathUtils.clamp(y / s.y, 0, 1) * 96;
const xy = (s: Scale, x: number, y: number) => `${px(s, x).toFixed(2)},${py(s, y).toFixed(2)}`;

const poly = (s: Scale, p: ReadonlyArray<readonly [number, number]>, cls: string) => `<polyline points="${p.map(([x, y]) => xy(s, x, y)).join(' ')}" class="${cls}"/>`;
/** The area under a line, down to 0. */
const area = (s: Scale, p: ReadonlyArray<readonly [number, number]>, cls: string) =>
  `<polygon points="${xy(s, p[0][0], 0)} ${p.map(([x, y]) => xy(s, x, y)).join(' ')} ${xy(s, p[p.length - 1][0], 0)}" class="${cls}"/>`;
const hline = (s: Scale, y: number, cls: string) => `<line x1="0" x2="100" y1="${py(s, y).toFixed(2)}" y2="${py(s, y).toFixed(2)}" class="${cls}"/>`;
const vline = (s: Scale, x: number, cls: string) => `<line x1="${px(s, x).toFixed(2)}" x2="${px(s, x).toFixed(2)}" y1="0" y2="100" class="${cls}"/>`;
const band = (s: Scale, y0: number, y1: number, cls: string) => `<rect x="0" width="100" y="${py(s, y1).toFixed(2)}" height="${Math.max(0.3, py(s, y0) - py(s, y1)).toFixed(2)}" class="${cls}"/>`;
/** A small text label at a point (above and right of it; `tpl-l` puts it left, `tpl-b` below). */
const tag = (s: Scale, x: number, y: number, text: string, cls = '') =>
  `<span class="tpl-tag ${cls}" style="left:${px(s, x).toFixed(2)}%;top:${py(s, y).toFixed(2)}%">${text}</span>`;

/** Faint grid lines every `step` up the y axis, labelled at the left edge (or the right, clear of the curves). */
function yGrid(s: Scale, step: number, label: (v: number) => string, right = false): { svg: string; tags: string } {
  let svg = '';
  let tags = '';
  // None in the top strip, where its label would be cut off.
  for (let v = step; v < s.y * 0.9; v += step) {
    svg += hline(s, v, 'tpl-grid');
    tags += tag(s, right ? s.x : 0, v, label(v), right ? 'tpl-l' : '');
  }
  return { svg, tags };
}

function xGrid(s: Scale, step: number): string {
  let svg = '';
  for (let v = step; v < s.x * 0.999; v += step) svg += vline(s, v, 'tpl-grid');
  return svg;
}

const draw = (g: Graph, svg: string, tags: string) => (g.curves.innerHTML = `${SVG}${svg}</svg>${tags}`);

/** A live marker's last few seconds as a polyline: a fixed ring of samples, so only the points text is new each frame. */
class Trail {
  readonly line: SVGPolylineElement;
  private readonly t = new Float64Array(256);
  private readonly x = new Float32Array(256);
  private readonly y = new Float32Array(256);
  private head = 0;
  private n = 0;

  constructor(cls: string) {
    this.line = svgEl('polyline', `tun-trail ${cls}`);
  }

  /** Adds a point (plot percentages) and redraws. */
  push(time: number, x: number, y: number): void {
    const N = this.t.length;
    const last = this.t[(this.head + N - 1) % N];
    // A jump back (a replay) or a long gap (the group was closed): start afresh.
    if (this.n && (time < last || time - last > 1)) this.n = 0;
    this.t[this.head] = time;
    this.x[this.head] = x;
    this.y[this.head] = y;
    this.head = (this.head + 1) % N;
    this.n = Math.min(this.n + 1, N);
    while (this.n > 1 && time - this.t[(this.head + N - this.n) % N] > TRAIL_S) this.n--;
    let pts = '';
    for (let i = this.n; i > 0; i--) {
      const j = (this.head + N - i) % N;
      pts += `${this.x[j].toFixed(1)},${this.y[j].toFixed(1)} `;
    }
    this.line.setAttribute('points', pts);
  }

  clear(): void {
    if (!this.n) return;
    this.n = 0;
    this.line.setAttribute('points', '');
  }
}

const fixed = (v: number, d: number) => String(+v.toFixed(d));

// --- Tires -----------------------------------------------------------------------------

/**
 * Grip against slip, front and rear, from the model's own curve as axleTire
 * scales it: pure cornering is normalised slip s = tan α / tan(peakSlipAngle),
 * giving μ·tireCurve(s) × load, and pure drive or braking s = slip ratio ÷
 * peakSlipRatio. Both share one μ scale.
 */
function tirePlot(spec: () => CarSpec): TuningPlot {
  const { row, plot } = shell(
    'Grip vs slip',
    'Cornering grip (force ÷ load, in μ) against slip angle, and drive / braking grip against slip ratio, front and rear, from the tire model.\n' +
      'Dashed: the peak slip. Dots: each axle’s actual cornering force ÷ load at its slip angle now; below the curve is grip spent driving or braking (combined slip).',
  );
  const lat = graph();
  const lon = graph('tpl-narrow');
  const pair = el('div', 'tpl-pair');
  pair.append(lat.box, lon.box);
  const key = el('div', 'tun-plot-key');
  const liveKey = el('span', 'tun-live-key');
  liveKey.title = 'Slip angle and cornering force ÷ load now, front and rear';
  plot.append(pair, key);
  const trailF = new Trail('tpl-f');
  const trailR = new Trail('tpl-r');
  lat.marks.append(trailF.line, trailR.line);
  const dotF = dot('tpl-f');
  const dotR = dot('tpl-r');
  lat.box.append(dotR, dotF);
  let sLat: Scale = { x: 40, y: 2 };

  const p: TuningPlot = {
    group: 'Tires',
    el: row,
    stale: true,
    draw() {
      p.stale = false;
      const c = spec().chassis;
      const tanPeak = Math.tan(c.peakSlipAngle);
      const peakDeg = c.peakSlipAngle * DEG;
      const mu = Math.max(c.muFront, c.muRear, c.muRearSide) * HEADROOM;
      // Well past the slide (it settles by 3× peak slip), and out to drift angles.
      sLat = { x: Math.min(90, Math.max(40, Math.ceil((Math.atan(3.5 * tanPeak) * DEG) / 10) * 10)), y: mu };
      const sLon: Scale = { x: Math.max(0.3, Math.ceil(c.peakSlipRatio * 35) / 10), y: mu };
      const N = 120;
      const latF: Array<[number, number]> = [];
      const latR: Array<[number, number]> = [];
      const lonF: Array<[number, number]> = [];
      const lonR: Array<[number, number]> = [];
      for (let i = 0; i <= N; i++) {
        const a = (sLat.x * i) / N;
        const s = Math.tan(a / DEG) / tanPeak;
        latF.push([a, c.muFront * tireCurve(s, c.slideFront)]);
        latR.push([a, c.muRearSide * tireCurve(s, c.slideRear)]);
        const r = (sLon.x * i) / N;
        const sr = r / c.peakSlipRatio;
        lonF.push([r, c.muFront * tireCurve(sr, c.slideFront)]);
        lonR.push([r, c.muRear * tireCurve(sr, c.slideRear)]);
      }
      const grid = yGrid(sLat, 0.5, (v) => v.toFixed(1));
      draw(
        lat,
        grid.svg + xGrid(sLat, 10) + vline(sLat, peakDeg, 'tun-redline') + poly(sLat, latR, 'tpl-r') + poly(sLat, latF, 'tpl-f'),
        grid.tags + tag(sLat, peakDeg, mu, `${fixed(peakDeg, 1)}°`, 'tpl-b') + tag(sLat, sLat.x, 0, `${sLat.x}° slip angle`, 'tpl-l'),
      );
      draw(
        lon,
        yGrid(sLon, 0.5, () => '').svg + xGrid(sLon, 0.1) + vline(sLon, c.peakSlipRatio, 'tun-redline') + poly(sLon, lonR, 'tpl-r') + poly(sLon, lonF, 'tpl-f'),
        tag(sLon, c.peakSlipRatio, mu, `${fixed(c.peakSlipRatio * 100, 1)}%`, 'tpl-b') + tag(sLon, sLon.x, 0, `${fixed(sLon.x * 100, 0)}% slip`, 'tpl-l'),
      );
      key.innerHTML =
        `<span class="tpl-f-key">front μ ${fixed(c.muFront, 2)}</span>` +
        `<span class="tpl-r-key">rear μ ${fixed(c.muRearSide, 2)} side, ${fixed(c.muRear, 2)} drive</span>`;
      key.append(liveKey);
    },
    live(time, phys) {
      if (p.stale) p.draw();
      const t = phys.tire;
      // Standing still the slip angles are noise, and in the air there's no force.
      if (phys.speed < 1 || phys.airborne) {
        dotF.hidden = dotR.hidden = true;
        trailF.clear();
        trailR.clear();
        liveKey.textContent = '';
        return;
      }
      // The front force is on the body (x forward, y left): its cornering part
      // is across the road wheels, so turn it back by the steer angle.
      const sd = Math.sin(phys.steer);
      const cd = Math.cos(phys.steer);
      const gripF = Math.abs(-t.forceF[0] * sd + t.forceF[1] * cd) / Math.max(t.loadF, 1);
      const gripR = Math.abs(t.forceR[1]) / Math.max(t.loadR, 1);
      const aF = Math.abs(t.slipF) * DEG;
      const aR = Math.abs(t.slipR) * DEG;
      const xF = px(sLat, aF);
      const yF = py(sLat, gripF);
      const xR = px(sLat, aR);
      const yR = py(sLat, gripR);
      place(dotF, xF, yF);
      place(dotR, xR, yR);
      trailF.push(time, xF, yF);
      trailR.push(time, xR, yR);
      liveKey.textContent = `now F ${aF.toFixed(1)}° ${gripF.toFixed(2)} · R ${aR.toFixed(1)}° ${gripR.toFixed(2)}`;
    },
  };
  return p;
}

// --- Gearing ---------------------------------------------------------------------------

/** Engine rpm per m/s of road speed in `gear` (1 = 1st), as Drivetrain.wheelRpm. */
const rpmPerMs = (D: DrivetrainSpec, gear: number) => (D.gears[gear - 1] * D.finalDrive * RPM_PER_RAD_S) / D.wheelRadius;

/** Engine rpm at full throttle in `gear` at road speed `v`: the clutch slips (holding launch rpm) below its lock-up rpm. */
function fullRpm(D: DrivetrainSpec, gear: number, v: number): number {
  const wheel = v * rpmPerMs(D, gear);
  return wheel < (gear === 1 ? D.clutchRpm : D.idleRpm) ? Math.max(wheel, D.launchRpm) : wheel;
}

/**
 * Drive force (N) at the contact patches at full throttle, held: the turbo at
 * the boost it builds by then at this rpm (all of it from fullRpm up), and
 * nothing at the limiter, which cuts the fuel.
 */
function thrust(D: DrivetrainSpec, gear: number, v: number): number {
  const rpm = fullRpm(D, gear, v);
  if (rpm >= D.limiter) return 0;
  const T = D.turbo;
  const boost = T ? 1 - T.share * (1 - MathUtils.smoothstep(rpm, T.onsetRpm, T.fullRpm)) : 1;
  return (torqueAt(D, rpm) * boost * D.gears[gear - 1] * D.finalDrive * D.efficiency) / D.wheelRadius;
}

/** Rolling resistance and drag at `v` (N), as integrateChassis applies them. */
const resistance = (c: ChassisSpec, v: number) => c.mass * (c.rollingDecel + c.dragK * v * v);

/** Each gear's highest steady speed at full throttle (m/s): where thrust stops beating resistance, or its limiter. */
function gearTops(D: DrivetrainSpec, c: ChassisSpec): Array<{ v: number; limiter: boolean }> {
  return D.gears.map((_, i) => {
    const g = i + 1;
    const vLim = D.limiter / rpmPerMs(D, g);
    const net = (v: number) => thrust(D, g, v) - resistance(c, v);
    if (net(vLim * (1 - 1e-6)) >= 0) return { v: vLim, limiter: true };
    // The highest crossing: scan down from the limiter, then bisect.
    const N = 400;
    for (let j = N - 1; j >= 0; j--) {
      let lo = (vLim * j) / N;
      if (net(lo) < 0) continue;
      let hi = lo + vLim / N;
      for (let k = 0; k < 30; k++) {
        const m = (lo + hi) / 2;
        if (net(m) >= 0) lo = m;
        else hi = m;
      }
      return { v: lo, limiter: false };
    }
    return { v: 0, limiter: false };
  });
}

/**
 * Where the auto box shifts up out of `gear` at full throttle (m/s): at the
 * full-throttle upshift rpm, but not before the next gear would land above
 * the downshift rpm + 300 (autoShift). Infinity if that's past the limiter.
 */
function upshiftAt(D: DrivetrainSpec, gear: number): number {
  if (gear >= D.gears.length) return Infinity;
  const v = Math.max(D.autoUpRpm[1] / rpmPerMs(D, gear), (D.autoDownRpm[1] + 300) / rpmPerMs(D, gear + 1));
  return v * rpmPerMs(D, gear) < D.limiter ? v : Infinity;
}

/**
 * The gearing, against road speed (mph) on a shared axis. Above, engine rpm
 * per gear with the auto box's full-throttle sawtooth, its shift bands and the
 * redline and limiter. Below, full-throttle thrust per gear against rolling
 * resistance and drag, which meet at the real top speed.
 */
function gearingPlot(spec: () => CarSpec): TuningPlot {
  const { row, plot } = shell(
    'Gearing',
    'Above: engine rpm against road speed in each gear. Bold: the auto box’s path at full throttle, each upshift dropping the revs to the figure below it. ' +
      'Shaded: its upshift (amber) and downshift (grey) rpm, light to full throttle; dashed the redline, solid the limiter.\n' +
      'Below: drive force at full throttle in each gear (on full boost once the turbo can make it) against rolling resistance and drag (dashed). ' +
      'The real top speed (green) is the fastest they balance in any gear, or the limiter; dips in the shaded envelope are gaps between gears.',
  );
  const saw = graph();
  const thr = graph();
  const sawKey = el('div', 'tun-plot-key');
  const key = el('div', 'tun-plot-key');
  const liveKey = el('span', 'tun-live-key');
  liveKey.title = 'Gear, road speed, engine rpm and drive force now';
  plot.append(saw.box, sawKey, thr.box, key);
  const lineS = liveLine(saw);
  const lineT = liveLine(thr);
  const dotS = dot('');
  const dotT = dot('');
  saw.box.append(dotS);
  thr.box.append(dotT);
  let sSaw: Scale = { x: 100, y: 8000 };
  let sThr: Scale = { x: 100, y: 10000 };
  let gearLines: Element[][] = [];
  let shown = 0;

  const p: TuningPlot = {
    group: 'Gearbox',
    el: row,
    stale: true,
    draw() {
      p.stale = false;
      const { chassis: c, drivetrain: D } = spec();
      const n = D.gears.length;
      const tops = gearTops(D, c);
      let top = 0;
      tops.forEach((t, i) => t.v > tops[top].v && (top = i));
      const vTop = tops[top].v;
      // To a bit past the top speed (or the top gear's limiter, if that's sooner), in mph.
      const vLimTop = D.limiter / rpmPerMs(D, n);
      const xMax = Math.max(Math.ceil(Math.min(vLimTop * MPH, vTop * MPH * 1.25) / 10) * 10, Math.ceil(vTop * MPH) + 5);
      const vMax = xMax / MPH;
      sSaw = { x: xMax, y: D.limiter * 1.08 };

      // Engine rpm: every gear idle (or launch) to limiter, then the path the box takes.
      let svg = band(sSaw, D.autoUpRpm[0], D.autoUpRpm[1], 'tpl-band-up') + band(sSaw, D.autoDownRpm[0], D.autoDownRpm[1], 'tpl-band-down');
      const rGrid = yGrid(sSaw, 2000, (v) => `${v / 1000}k`);
      svg += rGrid.svg + xGrid(sSaw, 20) + hline(sSaw, D.redline, 'tun-redline') + hline(sSaw, D.limiter, 'tpl-limiter');
      let tags = rGrid.tags;
      for (let g = 1; g <= n; g++) {
        const k = rpmPerMs(D, g);
        const vLim = D.limiter / k;
        const pts: Array<[number, number]> = g === 1 && D.launchRpm > D.clutchRpm
          ? [[0, D.launchRpm], [(D.clutchRpm / k) * MPH, D.launchRpm], [(D.clutchRpm / k) * MPH, D.clutchRpm]]
          : [[(D.idleRpm / k) * MPH, D.idleRpm]];
        pts.push([vLim * MPH, D.limiter]);
        svg += poly(sSaw, pts, 'tpl-gear');
        if (vLim < vMax) tags += tag(sSaw, vLim * MPH, D.limiter, String(g), 'tpl-l');
      }
      const k1 = rpmPerMs(D, 1);
      const path: Array<[number, number]> = D.launchRpm > D.clutchRpm ? [[0, D.launchRpm], [(D.clutchRpm / k1) * MPH, D.launchRpm], [(D.clutchRpm / k1) * MPH, D.clutchRpm]] : [[0, D.idleRpm]];
      // Where the box ends up at full throttle: it can stay in a gear that never reaches the upshift rpm.
      let held = { gear: 1, v: 0 };
      for (let g = 1; g <= n; g++) {
        const k = rpmPerMs(D, g);
        const up = upshiftAt(D, g);
        const stop = Math.min(up, tops[g - 1].v, vMax);
        path.push([stop * MPH, stop * k]);
        held = { gear: g, v: Math.min(up, tops[g - 1].v) };
        // Held: on the limiter, at this gear's top speed, or off the plot.
        if (stop < up) break;
        const drop = up * rpmPerMs(D, g + 1);
        path.push([up * MPH, drop]);
        tags += tag(sSaw, up * MPH, drop, `${fixed(drop / 1000, 1)}k`, 'tpl-b');
      }
      svg += poly(sSaw, path, 'tpl-saw');
      draw(saw, svg, tags);
      sawKey.innerHTML =
        `<span class="tpl-r-key">up ${D.autoUpRpm[0]}–${D.autoUpRpm[1]}</span><span>down ${D.autoDownRpm[0]}–${D.autoDownRpm[1]}</span>` +
        `<span>redline ${D.redline} · limiter ${D.limiter} rpm</span>`;

      // Thrust per gear, its envelope, and what it has to beat.
      const N = 160;
      const curves: Array<Array<[number, number]>> = [];
      let peak = 1;
      for (let g = 1; g <= n; g++) {
        const vEnd = Math.min(vMax, (D.limiter / rpmPerMs(D, g)) * (1 - 1e-6));
        const pts: Array<[number, number]> = [];
        for (let i = 0; i <= N; i++) {
          const v = (vEnd * i) / N;
          const f = thrust(D, g, v);
          peak = Math.max(peak, f);
          pts.push([v * MPH, f]);
        }
        // The clutch locking up in 1st drops the engine from launch rpm: draw the step square.
        if (g === 1) {
          const vc = D.clutchRpm / rpmPerMs(D, 1);
          if (vc < vEnd) {
            pts.push([vc * MPH, thrust(D, 1, vc * (1 - 1e-6))], [vc * MPH, thrust(D, 1, vc)]);
            pts.sort((a, b) => a[0] - b[0]);
          }
        }
        curves.push(pts);
      }
      sThr = { x: xMax, y: peak * HEADROOM };
      const env: Array<[number, number]> = [];
      const drag: Array<[number, number]> = [];
      for (let i = 0; i <= N * 2; i++) {
        const v = (vMax * i) / (N * 2);
        let f = 0;
        for (let g = 1; g <= n; g++) f = Math.max(f, thrust(D, g, v));
        env.push([v * MPH, f]);
        drag.push([v * MPH, resistance(c, v)]);
      }
      const fGrid = yGrid(sThr, niceStep(sThr.y / 3), (v) => `${fixed(v / 1000, 1)} kN`, true);
      svg = fGrid.svg + xGrid(sThr, 20) + area(sThr, env, 'tpl-env');
      svg += curves.map((pts) => poly(sThr, pts, 'tpl-gear')).join('');
      svg += poly(sThr, drag, 'tpl-drag') + vline(sThr, c.topSpeed * MPH, 'tun-redline') + vline(sThr, vTop * MPH, 'tpl-top');
      tags = fGrid.tags + tag(sThr, vTop * MPH, sThr.y, `${Math.round(vTop * MPH)} mph`, 'tpl-b tpl-top-tag') + tag(sThr, 0, 0, `0–${xMax} mph`);
      draw(thr, svg, tags);
      const field = Math.round(c.topSpeed * MPH);
      key.innerHTML =
        `<span class="tpl-top-key" title="Fastest speed thrust beats rolling resistance and drag, in any gear">top ${Math.round(vTop * MPH)} mph in ${ORDINALS[top] ?? top + 1}${tops[top].limiter ? ' (limiter)' : ''}</span>` +
        (held.v < vTop - 0.5 ? `<span title="At full throttle the auto box never reaches the upshift rpm in this gear">auto holds ${ORDINALS[held.gear - 1] ?? held.gear}: ${Math.round(held.v * MPH)} mph</span>` : '') +
        `<span title="The chassis Top speed field (only the camera uses it), dashed">field ${field} mph</span>`;
      key.append(liveKey);
      gearLines = [saw, thr].map((g) => [...g.curves.querySelectorAll('.tpl-gear')]);
      shown = 0;
    },
    live(_time, phys) {
      if (p.stale) p.draw();
      const dt = phys.drivetrain;
      const mph = phys.speed * MPH;
      const gear = dt.gear;
      if (gear !== shown) {
        for (const lines of gearLines) lines.forEach((l, i) => l.classList.toggle('tpl-on', i + 1 === gear));
        shown = gear;
      }
      moveLine(lineS, px(sSaw, mph));
      moveLine(lineT, px(sThr, mph));
      place(dotS, px(sSaw, mph), py(sSaw, dt.rpm));
      place(dotT, px(sThr, mph), py(sThr, dt.force));
      const name = gear < 0 ? 'R' : ORDINALS[gear - 1] ?? String(gear);
      liveKey.textContent = `now ${name} · ${Math.round(mph)} mph · ${Math.round(dt.rpm)} rpm · ${(dt.force / 1000).toFixed(1)} kN`;
    },
  };
  return p;
}

function niceStep(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m < 2 ? 1 : m < 5 ? 2 : 5) * p;
}

// --- Steering --------------------------------------------------------------------------

/** The lock full input asks for against ground speed (step(): steerMax / (1 + v / falloff)), under the wheel lock. */
function steeringPlot(spec: () => CarSpec): TuningPlot {
  const { row, plot } = shell(
    'Lock vs speed',
    'The road-wheel angle full steering input asks for against speed: Max steer / (1 + speed / Speed falloff). Dashed: the wheel lock, which countersteer from self-alignment can reach.\n' +
      'Ring: the road wheels now (self-alignment included); dot: the driver’s part of it.',
  );
  const g = graph('tpl-short');
  const key = el('div', 'tun-plot-key');
  const liveKey = el('span', 'tun-live-key');
  liveKey.title = 'Speed, road-wheel angle and the driver’s part of it now, and the lock full input would ask for';
  plot.append(g.box, key);
  const line = liveLine(g);
  const wheel = dot('tpl-ring');
  const cmd = dot('tpl-r');
  g.box.append(wheel, cmd);
  let s: Scale = { x: 100, y: 60 };

  const p: TuningPlot = {
    group: 'Steering',
    el: row,
    stale: true,
    draw() {
      p.stale = false;
      const c = spec().chassis;
      const xMax = Math.ceil(Math.max(60, c.topSpeed * MPH * 1.2) / 10) * 10;
      s = { x: xMax, y: Math.max(c.wheelLock, c.steerMax) * DEG * HEADROOM };
      const lock = (mph: number) => (c.steerMax / (1 + mph / MPH / c.steerSpeedFalloff)) * DEG;
      const pts: Array<[number, number]> = [];
      for (let i = 0; i <= 100; i++) pts.push([(xMax * i) / 100, lock((xMax * i) / 100)]);
      const grid = yGrid(s, 10, (v) => `${v}°`);
      const at = 60;
      draw(
        g,
        grid.svg + xGrid(s, 20) + hline(s, c.wheelLock * DEG, 'tun-redline') + poly(s, pts, 'tpl-f'),
        grid.tags + tag(s, xMax, c.wheelLock * DEG, `lock ${fixed(c.wheelLock * DEG, 1)}°`, 'tpl-l') + tag(s, xMax, 0, `${xMax} mph`, 'tpl-l'),
      );
      key.innerHTML = `<span class="tpl-f-key">full input ${fixed(c.steerMax * DEG, 1)}° at rest, ${fixed(lock(at), 1)}° at ${at} mph</span>`;
      key.append(liveKey);
    },
    live(_time, phys) {
      if (p.stale) p.draw();
      const mph = phys.speed * MPH;
      const x = px(s, mph);
      moveLine(line, x);
      place(wheel, x, py(s, Math.abs(phys.steer) * DEG));
      place(cmd, x, py(s, Math.abs(phys.steerCmd) * DEG));
      liveKey.textContent = `now ${Math.round(mph)} mph · wheels ${(Math.abs(phys.steer) * DEG).toFixed(1)}° · input ${(Math.abs(phys.steerCmd) * DEG).toFixed(1)}° of ${(phys.steerLock * DEG).toFixed(1)}°`;
    },
  };
  return p;
}
