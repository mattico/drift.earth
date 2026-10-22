// The debug panel's Tuning tab: every chassis and drivetrain number of the car
// being driven, editable live, with presets that can be saved, duplicated,
// exported and imported (car/presets.ts holds their schema and storage).
//
// The form is generated from the spec objects at runtime, so fields added to
// cars.ts show up without touching this file. META only makes them nicer:
// labels, units, groups, slider ranges and display scaling.

import { CARS, DEFAULT_CAR, type CarId, type CarSpec } from '../car/cars';
import { powerHp } from '../car/drivetrain';
import {
  bundle,
  checkNumber,
  cleanValue,
  crossCheck,
  fieldLimit,
  freshId,
  getAt,
  isOptional,
  isStock,
  parsePresets,
  PRESET_VERSION,
  PresetStore,
  presetSpec,
  sameValue,
  SECTIONS,
  serialize,
  setAt,
  stockPreset,
  template,
  type CarPreset,
  type FieldLimit,
} from '../car/presets';
import { MPH } from '../ui';

export interface TuningHandlers {
  /**
   * The car's numbers changed. `path` is the field edited in place on `spec`
   * (e.g. ['chassis', 'mass']), or null when `spec` is a new object (a preset
   * loaded, reset or reverted) that the physics must switch to.
   */
  apply(spec: CarSpec, path: readonly string[] | null): void;
  notice(text: string): void;
  /** Records a trace event. */
  event(kind: string, data: Record<string, unknown>): void;
}

/** How a field is shown. Slider range and step are in display units (stored value × scale). */
interface Meta {
  label: string;
  group?: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  scale?: number;
  /** Labels for the values of a fixed-length list (the auto box's light / full throttle shift points). */
  parts?: string[];
  help?: string;
}

const GROUPS = ['Chassis', 'Tyres', 'Steering', 'Brakes', 'Stability', 'Engine', 'Gearbox', 'Turbo'];
const DEG = 180 / Math.PI;
const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

const META: Record<string, Meta> = {
  'chassis.mass': { label: 'Mass', group: 'Chassis', unit: 'kg', min: 600, max: 3000, step: 10 },
  'chassis.yawInertia': { label: 'Yaw inertia', group: 'Chassis', unit: 'kg·m²', min: 800, max: 5000, step: 10, help: 'Resistance to rotating: higher turns in, and spins, more lazily' },
  'chassis.cgToFront': { label: 'CG to front axle', group: 'Chassis', unit: 'm', min: 0.6, max: 2.2, step: 0.01, help: 'Sets the weight split: the rear axle is wheelbase − this' },
  'chassis.cgHeight': { label: 'CG height', group: 'Chassis', unit: 'm', min: 0.2, max: 1, step: 0.01, help: 'How much load braking and power move between the axles' },
  'chassis.wheelbase': { label: 'Wheelbase', group: 'Chassis', unit: 'm', min: 2, max: 3.4, step: 0.01 },
  'chassis.halfWidth': { label: 'Half width', group: 'Chassis', unit: 'm', min: 0.7, max: 1.2, step: 0.005, help: 'Collision outline' },
  'chassis.halfLength': { label: 'Half length', group: 'Chassis', unit: 'm', min: 1.6, max: 3, step: 0.005, help: 'Collision outline' },
  'chassis.cornerX': { label: 'Probe half-track', group: 'Chassis', unit: 'm', min: 0.5, max: 1.1, step: 0.01, help: 'Ground probes across (≈ contact patches)' },
  'chassis.cornerZ': { label: 'Probe half-base', group: 'Chassis', unit: 'm', min: 0.8, max: 1.9, step: 0.01, help: 'Ground probes along (≈ contact patches)' },
  'chassis.dragK': { label: 'Drag', group: 'Chassis', unit: '/m', min: 0, max: 0.004, step: 0.00001, help: 'Deceleration = this × speed²' },
  'chassis.rollingDecel': { label: 'Rolling resistance', group: 'Chassis', unit: 'm/s²', min: 0, max: 2, step: 0.01, help: 'Constant deceleration from the tyres rolling' },
  'chassis.topSpeed': { label: 'Top speed (camera)', group: 'Chassis', unit: 'mph', scale: MPH, min: 40, max: 250, step: 1, help: 'Roughly where drag balances power; only scales the camera pull-back' },
  'chassis.topSpeedReverse': { label: 'Reverse top speed', group: 'Chassis', unit: 'mph', scale: MPH, min: 5, max: 60, step: 1, help: 'Backing up on the brake tops out here' },
  'chassis.reverseAccel': { label: 'Reverse accel', group: 'Chassis', unit: 'm/s²', min: 1, max: 15, step: 0.1, help: 'How hard the brake backs the car up from a stop' },

  'chassis.muFront': { label: 'Front grip μ', group: 'Tyres', min: 0.5, max: 2.5, step: 0.01, help: 'Every way: a front-drive car drives and brakes on it too' },
  'chassis.muRear': { label: 'Rear grip μ (drive)', group: 'Tyres', min: 0.5, max: 2.5, step: 0.01, help: 'Rear drive (rear-drive cars) and braking' },
  'chassis.muRearSide': { label: 'Rear grip μ (side)', group: 'Tyres', min: 0.5, max: 2.5, step: 0.01, help: 'Rear cornering' },
  'chassis.peakSlipAngle': { label: 'Peak slip angle', group: 'Tyres', unit: '°', scale: DEG, min: 2, max: 20, step: 0.1, help: 'Sideways slip where cornering grip peaks; past it the tyre slides' },
  'chassis.peakSlipRatio': { label: 'Peak slip ratio', group: 'Tyres', min: 0.03, max: 0.4, step: 0.005, help: 'Wheelspin or lock (share of road speed) where drive and braking grip peak' },
  'chassis.slideFront': { label: 'Front sliding grip', group: 'Tyres', unit: '× peak', min: 0.3, max: 1, step: 0.01, help: 'Grip left sliding well past the peak (by 3× peak slip)' },
  'chassis.slideRear': { label: 'Rear sliding grip', group: 'Tyres', unit: '× peak', min: 0.3, max: 1, step: 0.01, help: 'Grip left sliding well past the peak (by 3× peak slip)' },

  'chassis.steerMax': { label: 'Max steer', group: 'Steering', unit: '°', scale: DEG, min: 10, max: 60, step: 0.5, help: 'Road-wheel angle at rest; it falls off with speed' },
  'chassis.steerSpeedFalloff': { label: 'Speed falloff', group: 'Steering', unit: 'm/s', min: 3, max: 60, step: 0.5, help: 'max = steerMax / (1 + speed / this)' },
  'chassis.steerRate': { label: 'Steer rate', group: 'Steering', unit: '°/s', scale: DEG, min: 50, max: 1000, step: 5, help: 'How fast the wheels turn towards the input (slower at speed)' },
  'chassis.steerReturn': { label: 'Return rate', group: 'Steering', unit: '°/s', scale: DEG, min: 50, max: 1000, step: 5, help: 'How fast the wheels come back towards centre (slower at speed)' },
  'chassis.steerAlign': { label: 'Self-alignment', group: 'Steering', min: 0, max: 1, step: 0.01, help: '0 none, 1 the front tyres fully trail the direction of travel' },
  'chassis.wheelLock': { label: 'Wheel lock', group: 'Steering', unit: '°', scale: DEG, min: 20, max: 80, step: 0.5, help: 'Road-wheel limit, countersteer included' },

  'chassis.brakeDecel': { label: 'Brake decel', group: 'Brakes', unit: 'm/s²', min: 4, max: 30, step: 0.5, help: 'What the foot brake asks for; tyre grip may give less' },
  'chassis.brakeFront': { label: 'Front brake share', group: 'Brakes', unit: '%', scale: 100, min: 0, max: 100, step: 1, help: 'Share of the foot brake on the front axle' },
  'chassis.absLimit': { label: 'ABS limit', group: 'Brakes', unit: '× grip', min: 0.3, max: 1.2, step: 0.01, help: 'Caps foot-brake force at this share of each axle’s grip' },
  'chassis.handbrakeForce': { label: 'Handbrake', group: 'Brakes', unit: '× weight', min: 0, max: 2, step: 0.01, help: 'Rear brake force at full pull' },

  'chassis.stability': { label: 'Stability gain', group: 'Stability', unit: '/s²', min: 0, max: 400, step: 1, help: 'Yaw acceleration per rad of rear slip past its limit' },
  'chassis.stabilityOff': { label: 'Re-arm delay', group: 'Stability', unit: 's', min: 0, max: 5, step: 0.05, help: 'After a handbrake, wheelspin or drift' },
  'chassis.tractionControl': { label: 'Traction control', group: 'Stability', min: 0, max: 1, step: 0.05, help: '0 none … 1: limits drive to what the driven tyres can take while the wheel is near centre' },
  'chassis.stabilitySlip': { label: 'Allowed rear slip', group: 'Stability', unit: '°', scale: DEG, min: 0, max: 45, step: 0.5, help: 'Rear slip it lets the car reach first (default: peak slip angle)' },

  'drivetrain.torque': { label: 'Torque curve', group: 'Engine', help: 'rpm → N·m (at full boost, for a turbo engine)' },
  'drivetrain.idleRpm': { label: 'Idle', group: 'Engine', unit: 'rpm', min: 500, max: 1500, step: 10 },
  'drivetrain.redline': { label: 'Redline', group: 'Engine', unit: 'rpm', min: 3000, max: 12000, step: 50, help: 'Top of the usable rev range, below the limiter; engine braking is rated here' },
  'drivetrain.limiter': { label: 'Limiter', group: 'Engine', unit: 'rpm', min: 3000, max: 12500, step: 50, help: 'Fuel cut: the engine can’t rev past this' },
  'drivetrain.limiterCut': { label: 'Limiter cut', group: 'Engine', unit: 's', min: 0, max: 0.3, step: 0.005, help: 'How long the fuel is cut each time the limiter is hit' },
  'drivetrain.engineBrakeTorque': { label: 'Engine braking', group: 'Engine', unit: 'N·m', min: 0, max: 300, step: 1, help: 'At redline, scaling with rpm' },
  'drivetrain.engineInertia': { label: 'Engine inertia', group: 'Engine', unit: 'kg·m²', min: 0.05, max: 1, step: 0.005, help: 'How quickly the engine revs up and down, felt at the wheels through the gearing' },
  'drivetrain.clutchRpm': { label: 'Clutch slips below', group: 'Engine', unit: 'rpm', min: 500, max: 5000, step: 50, help: 'Wheel rpm (through the gearing)' },
  'drivetrain.launchRpm': { label: 'Launch rpm', group: 'Engine', unit: 'rpm', min: 1500, max: 8000, step: 50, help: 'Held at full throttle while the clutch slips' },
  'drivetrain.efficiency': { label: 'Driveline efficiency', group: 'Engine', unit: '%', scale: 100, min: 50, max: 100, step: 0.5, help: 'Share of the engine’s torque that reaches the wheels' },

  'drivetrain.gears': { label: 'Gear ratios', group: 'Gearbox', help: 'From 1st up, each multiplied by the final drive' },
  'drivetrain.reverse': { label: 'Reverse', group: 'Gearbox', min: 1, max: 6, step: 0.01, help: 'Reverse gear ratio, multiplied by the final drive' },
  'drivetrain.finalDrive': { label: 'Final drive', group: 'Gearbox', min: 2, max: 6, step: 0.01, help: 'Multiplies every gear: higher pulls harder, with less speed per gear' },
  'drivetrain.wheelRadius': { label: 'Wheel radius', group: 'Gearbox', unit: 'm', min: 0.25, max: 0.45, step: 0.001, help: 'With the gearing, sets road speed per rpm' },
  'drivetrain.wheelInertia': { label: 'Wheel inertia', group: 'Gearbox', unit: 'kg·m²', min: 0.5, max: 6, step: 0.05, help: 'Both driven wheels and axles' },
  'drivetrain.shiftTime': { label: 'Shift time', group: 'Gearbox', unit: 's', min: 0.03, max: 0.6, step: 0.01, help: 'The clutch is out for this long on each shift' },
  'drivetrain.autoUpRpm': { label: 'Auto upshift', group: 'Gearbox', unit: 'rpm', min: 1000, max: 12000, step: 50, parts: ['light', 'full'], help: 'Engine rpm the auto box shifts up at, from light to full throttle' },
  'drivetrain.autoDownRpm': { label: 'Auto downshift', group: 'Gearbox', unit: 'rpm', min: 500, max: 9000, step: 50, parts: ['light', 'full'], help: 'Engine rpm the auto box shifts down at, from light to full throttle' },
  'drivetrain.autoHold': { label: 'Auto hold', group: 'Gearbox', unit: 's', min: 0, max: 3, step: 0.05, help: 'Minimum time between automatic shifts' },

  'drivetrain.turbo': { label: 'Turbo', group: 'Turbo' },
  'drivetrain.turbo.onsetRpm': { label: 'Boost onset', group: 'Turbo', unit: 'rpm', min: 500, max: 6000, step: 50, help: 'Full throttle starts building boost here…' },
  'drivetrain.turbo.fullRpm': { label: 'Full boost', group: 'Turbo', unit: 'rpm', min: 1000, max: 8000, step: 50, help: '…and has all of it by here' },
  'drivetrain.turbo.spool': { label: 'Spool time', group: 'Turbo', unit: 's', min: 0.02, max: 2, step: 0.01, help: 'Time constant at full-boost rpm' },
  'drivetrain.turbo.vent': { label: 'Blow-off vent', group: 'Turbo', unit: 's', min: 0.01, max: 1, step: 0.01, help: 'Time constant the blow-off valve dumps boost with on lift-off or a shift' },
  'drivetrain.turbo.share': { label: 'Boost share', group: 'Turbo', unit: '%', scale: 100, min: 0, max: 90, step: 1, help: 'Share of the torque curve boost makes' },
};
const META_ORDER = Object.keys(META);

const humanize = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])(?=[a-z])/g, (_, c: string) => ` ${c.toLowerCase()}`);

function niceStep(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m < 2 ? 1 : m < 5 ? 2 : 5) * p;
}

/** Display metadata for a field, filled in generically for keys META doesn't know. */
function metaFor(path: readonly string[], stock: unknown): Required<Pick<Meta, 'label' | 'group' | 'scale' | 'step'>> & Meta {
  const key = path.join('.');
  const m = META[key] ?? { label: humanize(path[path.length - 1]) };
  const parent = path.length > 2 ? META[path.slice(0, -1).join('.')] : undefined;
  const group = m.group ?? parent?.group ?? (path.length > 2 ? humanize(path[path.length - 2]) : path[0] === 'chassis' ? 'Chassis' : 'Engine');
  const scale = m.scale ?? 1;
  let { min, max, step } = m;
  if (min === undefined || max === undefined) {
    const s = (Array.isArray(stock) ? (stock.flat()[0] as number) : (stock as number)) * scale;
    const lim = fieldLimit(path, stock);
    min = s > 0 ? (lim.min > 0 || lim.above ? s / 4 : 0) : s * 3;
    max = s > 0 ? s * 3 : s < 0 ? 0 : 1;
  }
  step ??= niceStep((max - min) / 200);
  return { ...m, group, scale, min, max, step };
}

const digitsFor = (step: number) => Math.max(0, Math.min(6, Math.ceil(-Math.log10(step) - 1e-9)));
const show = (v: number, digits: number) => String(+v.toFixed(digits));
/**
 * A box's number: the exact stored `v` while the box still shows it as it was
 * shown (so editing one cell of a list doesn't round the others), else its text.
 */
const boxValue = (box: HTMLInputElement, v: number | undefined, scale: number, digits: number) =>
  v !== undefined && box.value === show(v * scale, digits) ? v : box.value === '' ? NaN : +box.value / scale;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function numberBox(title = ''): HTMLInputElement {
  const n = el('input', 'tun-num');
  n.type = 'number';
  // "any": the browser mustn't flag values between slider steps.
  n.step = 'any';
  if (title) n.title = title;
  return n;
}

interface Row {
  path: string[];
  el: HTMLElement;
  /** Shows the spec's current value (skipping a box being typed in, unless `force`). */
  sync(force?: boolean): void;
}

const UI_STORAGE = 'drift.earth:tuning';

/** Live tuning of the car being driven, and its presets. Plain DOM inside the debug panel's Tuning tab. */
export class TuningEditor {
  readonly store = new PresetStore();
  base: CarId = DEFAULT_CAR;
  /** The active preset as last saved. */
  preset: CarPreset;
  /** Working copy the car drives on (never a stock CARS object): edits land here. */
  spec: CarSpec;
  private stock: CarPreset;
  private rows: Row[] = [];
  /** Groups the player has open (remembered per browser). */
  private openGroups = new Set<string>(['Chassis', 'Tyres']);
  private nameMode: 'saveAs' | 'rename' = 'saveAs';
  /** Moves the torque plot's live rpm marker (set by the curve row). */
  private liveCurve: ((time: number, rpm: number, torque: number) => void) | null = null;

  private readonly select = el('select', 'tun-select');
  private readonly carName = el('span', 'tun-car');
  private readonly dirtyEl = el('span', 'tun-dirty', '● unsaved');
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly nameRow = el('div', 'dbg-row tun-name');
  private readonly nameInput = el('input', 'tun-text');
  private readonly pasteRow = el('div', 'tun-paste');
  private readonly pasteText = el('textarea', 'tun-textarea');
  private readonly msgEl = el('div', 'tun-msg');
  private readonly warnEl = el('div', 'tun-msg tun-warn');
  private readonly form = el('div', 'tun-form');
  private readonly fileInput = el('input');

  constructor(
    private readonly host: HTMLElement,
    private readonly h: TuningHandlers,
  ) {
    this.preset = this.store.activeFor(this.base);
    this.stock = stockPreset(this.base);
    this.spec = presetSpec(this.preset);
    this.loadUi();
    this.build();
  }

  // --- API (also `__drift.debug.tuning`) ------------------------------------------

  /**
   * Makes `base`'s active preset current and returns the working copy to drive
   * on: a fresh one, or `working` (unsaved edits carried over a hot update).
   */
  load(base: CarId, working?: CarSpec): CarSpec {
    this.base = base;
    this.preset = this.store.activeFor(base);
    this.stock = stockPreset(base);
    this.spec = working ?? presetSpec(this.preset);
    this.clearMsg();
    this.render();
    this.h.event('preset', { ...this.describe(), why: 'car' });
    return this.spec;
  }

  /** Each frame the tab is showing: the engine's rpm and the torque on tap there (N·m), for the torque plot. */
  live(time: number, rpm: number, torque: number): void {
    this.liveCurve?.(time, rpm, torque);
  }

  get dirty(): boolean {
    return SECTIONS.some((s) => !sameValue(this.spec[s], this.preset[s]));
  }

  /** For traces: which preset the car is on. */
  describe(): { id: string; name: string; base: CarId; unsaved: boolean } {
    return { id: this.preset.id, name: this.preset.name, base: this.base, unsaved: this.dirty };
  }

  /** The car's presets (stock first). */
  presets(): CarPreset[] {
    return this.store.list(this.base);
  }

  /**
   * Sets one field, in stored (SI) units, e.g. `set('chassis.mass', 1500)`;
   * `undefined` removes an optional one (the turbo). Returns the problem, or null.
   */
  set(path: string, value: unknown): string | null {
    const err = this.edit(path.split('.'), value, true);
    // The form still shows the old value, and its next edit would put it back.
    if (err === null) this.syncRows();
    return err;
  }

  /** Switches to another of this car's presets, discarding unsaved edits. */
  choose(id: string): boolean {
    const p = this.store.get(id);
    if (!p || p.base !== this.base) return false;
    this.preset = p;
    this.store.setActive(this.base, id);
    this.replaceSpec(presetSpec(p), 'select');
    return true;
  }

  /** Overwrites the active preset with the current values (not the stock one). */
  save(): boolean {
    if (isStock(this.preset)) return this.fail('Stock is read-only: use Save as to keep these values');
    if (!this.savable()) return false;
    this.preset = { ...this.preset, ...this.values(), updated: new Date().toISOString() };
    this.store.put(this.preset);
    this.afterPresetChange(`Saved “${this.preset.name}”`);
    return true;
  }

  /** Saves the current values as a new preset (a duplicate, with any edits) and makes it active. */
  saveAs(name: string): boolean {
    const nm = name.trim().slice(0, 60);
    if (!nm) return this.fail('Give the preset a name');
    if (!this.savable()) return false;
    const p: CarPreset = { version: PRESET_VERSION, id: freshId(), name: this.store.uniqueName(this.base, nm), base: this.base, ...this.values(), updated: new Date().toISOString() };
    this.store.put(p);
    this.store.setActive(this.base, p.id);
    this.preset = p;
    this.afterPresetChange(`Saved “${p.name}”`);
    return true;
  }

  rename(name: string): boolean {
    const nm = name.trim().slice(0, 60);
    if (isStock(this.preset)) return this.fail('The stock preset can’t be renamed');
    if (!nm) return this.fail('Give the preset a name');
    // Only the name: unsaved edits stay unsaved.
    const stored = this.store.get(this.preset.id) ?? this.preset;
    this.preset = { ...stored, name: this.store.uniqueName(this.base, nm, stored.id) };
    this.store.put(this.preset);
    this.afterPresetChange(`Renamed to “${this.preset.name}”`);
    return true;
  }

  /** Deletes the active user preset; the car goes back to stock. */
  remove(): boolean {
    if (isStock(this.preset)) return this.fail('The stock preset can’t be deleted');
    const name = this.preset.name;
    this.store.remove(this.preset.id);
    this.choose(this.stock.id);
    this.note(`Deleted “${name}”`);
    return true;
  }

  /** Discards unsaved edits: back to the active preset as last saved. */
  reset(): void {
    this.replaceSpec(presetSpec(this.preset), 'reset');
  }

  /** Puts the stock values in, as unsaved edits to the active preset. */
  revertToStock(): void {
    this.replaceSpec(presetSpec(this.stock), 'stock');
  }

  /** The current values (unsaved edits included) as a preset file, or every saved preset with `all`. */
  exportJson(all = false): string {
    if (all) return JSON.stringify(bundle(this.store.all()), null, 2);
    return JSON.stringify(serialize({ ...this.preset, ...this.values(), updated: new Date().toISOString() }), null, 2);
  }

  /**
   * Imports a preset file or pasted JSON (one preset, an export-all bundle or a
   * list). Each valid preset is added; with just one, it becomes its car's active
   * preset (and is driven now if it's for this car). Problems go to the message line.
   */
  importJson(text: string): { imported: string[]; errors: string[] } {
    const { presets, errors } = parsePresets(text);
    // One at a time, so each is checked against the ones already added (a
    // bundle can repeat an id or a name).
    const added: CarPreset[] = [];
    for (const p of presets) {
      const q = this.store.adopt(p);
      this.store.put(q);
      added.push(q);
    }
    const names = added.map((p) => `“${p.name}”${p.base === this.base ? '' : ` (${CARS[p.base].name})`}`);
    let tail = '';
    if (added.length === 1) {
      const p = added[0];
      if (p.base !== this.base) {
        this.store.setActive(p.base, p.id);
        tail = `; it’s used when you drive the ${CARS[p.base].name.toLowerCase()}`;
      } else if (this.dirty && !confirm(`Discard unsaved changes to “${this.preset.name}” and drive “${p.name}”?`)) {
        // Kept, just not driven.
        this.refreshPresets();
        tail = '; pick it from the list to drive it';
      } else {
        this.store.setActive(p.base, p.id);
        this.preset = p;
        this.replaceSpec(presetSpec(p), 'import');
      }
    } else this.refreshPresets();
    if (errors.length) {
      this.fail(`${added.length ? `Imported ${names.join(', ')}. ` : 'Nothing imported. '}${errors.join(' · ')}`);
    } else {
      this.clearMsg();
      this.note(`Imported ${names.join(', ')}${tail}`);
    }
    this.h.event('preset-import', { imported: added.map((p) => p.id), errors });
    return { imported: added.map((p) => p.id), errors };
  }

  // --- Internals ------------------------------------------------------------------

  private values(): Pick<CarPreset, 'chassis' | 'drivetrain'> {
    return { chassis: structuredClone(this.spec.chassis), drivetrain: structuredClone(this.spec.drivetrain) };
  }

  /** The numbers pass the cross-field rules, so a saved or exported preset will load again. */
  private savable(action = 'save'): boolean {
    const errs = crossCheck(this.spec);
    return errs.length ? this.fail(`Can’t ${action}: ${errs.join('; ')}`) : true;
  }

  private replaceSpec(spec: CarSpec, why: string): void {
    this.spec = spec;
    this.clearMsg();
    this.render();
    this.h.apply(spec, null);
    this.h.event('preset', { ...this.describe(), why });
  }

  private afterPresetChange(text: string): void {
    this.clearMsg();
    this.refreshPresets();
    this.refreshMarks();
    this.note(text);
    this.h.event('preset', { ...this.describe(), why: 'save' });
  }

  /**
   * Validates and applies one field. Live slider drags pass `commit` false: the
   * car follows, but only the release is recorded in the trace.
   */
  private edit(path: string[], value: unknown, commit: boolean): string | null {
    const tmpl = getAt(template(this.base), path);
    if (tmpl === undefined) return this.problem(`${path.join('.')} isn’t a tuning field`);
    // e.g. a turbo setting on a car with no turbo fitted.
    const parent = getAt(this.spec, path.slice(0, -1));
    if (typeof parent !== 'object' || parent === null) return this.problem(`${path.slice(0, -1).join('.')} isn’t fitted`);
    let clean: unknown;
    if (value === undefined) {
      if (!isOptional(path)) return this.problem(`${path.join('.')} is required`);
    } else {
      const errs: string[] = [];
      clean = cleanValue(value, path, tmpl, getAt(this.stock, path), errs);
      if (errs.length) return this.problem(errs.join('; '));
    }
    const old = getAt(this.spec, path);
    // Fitted or removed, or a gear or curve point added or dropped: the form needs new rows.
    const shape = (old === undefined) !== (clean === undefined) || (Array.isArray(old) && Array.isArray(clean) && old.length !== clean.length);
    setAt(this.spec, path, clean);
    this.h.apply(this.spec, path);
    if (commit) this.h.event('tune', { path: path.join('.'), value: clean ?? null });
    if (shape) this.render();
    else this.refreshMarks();
    return null;
  }

  private problem(text: string): string {
    this.fail(text);
    return text;
  }

  private fail(text: string): false {
    this.msgEl.textContent = text;
    this.msgEl.hidden = false;
    return false;
  }

  private clearMsg(): void {
    this.msgEl.hidden = true;
  }

  private note(text: string): void {
    this.h.notice(text);
  }

  // --- Static UI ---------------------------------------------------------------------

  private button(key: string, label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = el('button', 'dbg-btn', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', () => {
      onClick();
      // Keep keyboard focus off the panel so Space/arrows keep driving.
      b.blur();
    });
    if (key) this.buttons.set(key, b);
    return b;
  }

  private build(): void {
    const host = this.host;
    host.classList.add('tun');
    const bar = el('div', 'dbg-row tun-bar');
    bar.append(el('span', 'dbg-label', 'Preset'), this.select, this.dirtyEl, this.carName);
    this.select.title = 'This car’s presets: switching discards unsaved edits';
    this.select.addEventListener('change', () => {
      const id = this.select.value;
      this.select.blur();
      if (this.dirty && !confirm(`Discard unsaved changes to “${this.preset.name}”?`)) {
        this.select.value = this.preset.id;
        return;
      }
      this.choose(id);
    });

    const edit = el('div', 'dbg-row');
    edit.append(
      el('span', 'dbg-label', 'Edit'),
      this.button('save', 'Save', 'Overwrite this preset with the current values', () => this.save()),
      this.button('saveAs', 'Save as…', 'Save the current values as a new preset (duplicate)', () => this.askName('saveAs')),
      this.button('rename', 'Rename…', 'Rename this preset', () => this.askName('rename')),
      this.button('delete', 'Delete', 'Delete this preset (the car goes back to stock)', () => {
        if (confirm(`Delete the preset “${this.preset.name}”?`)) this.remove();
      }),
      this.button('reset', 'Reset', 'Discard unsaved edits: back to this preset as last saved', () => this.reset()),
      this.button('stock', 'Stock', 'Put the stock car’s values in (as unsaved edits); pick Stock in the list to drive it unmodified', () => this.revertToStock()),
    );

    const io = el('div', 'dbg-row');
    io.append(
      el('span', 'dbg-label', 'File'),
      this.button('export', 'Export', 'Download this preset (with any unsaved edits) as JSON', () => this.download(false)),
      this.button('exportAll', 'Export all', 'Download every saved preset, for both cars', () => this.download(true)),
      this.button('copy', 'Copy JSON', 'Copy this preset’s JSON to the clipboard', () => void this.copy()),
      this.button('importFile', 'Import…', 'Import presets from a .json file', () => this.fileInput.click()),
      this.button('paste', 'Paste…', 'Import presets from pasted JSON', () => this.showPaste('')),
    );

    this.nameInput.type = 'text';
    this.nameInput.maxLength = 60;
    this.nameInput.placeholder = 'Preset name';
    this.nameRow.hidden = true;
    this.nameRow.append(
      el('span', 'dbg-label', 'Name'),
      this.nameInput,
      this.button('', 'OK', 'Save the name (Enter)', () => this.submitName()),
      this.button('', 'Cancel', 'Cancel (Esc)', () => (this.nameRow.hidden = true)),
    );

    this.pasteRow.hidden = true;
    this.pasteText.rows = 6;
    this.pasteText.spellcheck = false;
    this.pasteText.placeholder = 'Paste preset JSON here';
    const pasteButtons = el('div', 'dbg-row');
    pasteButtons.append(
      this.button('', 'Import', 'Import the JSON above', () => {
        const r = this.importJson(this.pasteText.value);
        if (r.imported.length && !r.errors.length) this.pasteRow.hidden = true;
      }),
      this.button('', 'Close', 'Close (Esc)', () => (this.pasteRow.hidden = true)),
    );
    this.pasteRow.append(this.pasteText, pasteButtons);

    this.fileInput.type = 'file';
    this.fileInput.accept = '.json,application/json';
    this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', async () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (!file) return;
      if (file.size > 1_000_000) {
        this.fail(`${file.name} is too big to be a preset`);
        return;
      }
      this.importJson(await file.text());
    });

    this.msgEl.hidden = this.warnEl.hidden = true;
    host.append(bar, edit, io, this.nameRow, this.pasteRow, this.msgEl, this.warnEl, this.form, this.fileInput);
    host.addEventListener('keydown', (e) => this.onKey(e));
  }

  /**
   * Keys inside the tab. Text and number boxes already keep keys from the car
   * (InputManager ignores keydowns in inputs); this adds Enter to commit and
   * leave, Esc to back out (without opening the menu), and covers the preset
   * list, which InputManager doesn't count as typing.
   */
  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (!t.matches('input, select, textarea')) return;
    if (/^F\d+$/.test(e.key)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (t === this.nameInput) this.nameRow.hidden = true;
      else if (t === this.pasteText) this.pasteRow.hidden = true;
      // Back to the value the car has, before the blur could commit what was typed.
      else this.syncRows(true);
      t.blur();
      return;
    }
    if (e.key === 'Enter' && t instanceof HTMLInputElement) {
      e.preventDefault();
      if (t === this.nameInput) this.submitName();
      else t.blur();
    }
    if (t.tagName === 'SELECT') e.stopPropagation();
  }

  private askName(mode: 'saveAs' | 'rename'): void {
    this.nameMode = mode;
    this.nameRow.hidden = false;
    this.nameInput.value = mode === 'rename' ? this.preset.name : isStock(this.preset) ? `${CARS[this.base].name} tune` : `${this.preset.name} copy`;
    this.nameInput.focus();
    this.nameInput.select();
  }

  private submitName(): void {
    const ok = this.nameMode === 'rename' ? this.rename(this.nameInput.value) : this.saveAs(this.nameInput.value);
    if (ok) {
      this.nameRow.hidden = true;
      this.nameInput.blur();
    }
  }

  private showPaste(text: string): void {
    this.pasteRow.hidden = false;
    this.pasteText.value = text;
    this.pasteText.focus();
    this.pasteText.select();
  }

  private download(all: boolean): void {
    if (all && !this.store.all().length) {
      this.fail('No saved presets yet: Save as first');
      return;
    }
    if (!all && !this.savable('export')) return;
    const json = this.exportJson(all);
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const file = all ? `drift-presets-${new Date().toISOString().slice(0, 10)}.json` : `drift-preset-${this.base}-${slug(this.preset.name) || 'preset'}.json`;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.note(`Downloaded ${file}${!all && this.dirty ? ' (with unsaved edits)' : ''}`);
  }

  private async copy(): Promise<void> {
    if (!this.savable('copy')) return;
    const json = this.exportJson(false);
    try {
      await navigator.clipboard.writeText(json);
      this.note('Preset JSON copied');
    } catch {
      // Needs focus and, off localhost, HTTPS: hand it over to copy by hand.
      this.showPaste(json);
      this.fail('Couldn’t reach the clipboard: the JSON is selected below, copy it from there');
    }
  }

  private loadUi(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(UI_STORAGE) ?? 'null') as { open?: unknown } | null;
      if (Array.isArray(saved?.open)) this.openGroups = new Set(saved.open.filter((g): g is string => typeof g === 'string'));
    } catch {
      // Defaults.
    }
  }

  private persistUi(): void {
    try {
      localStorage.setItem(UI_STORAGE, JSON.stringify({ open: [...this.openGroups] }));
    } catch {
      // Not persisted.
    }
  }

  // --- Form -----------------------------------------------------------------------------

  /** Rebuilds the preset list and the form for the current spec's shape. */
  private render(): void {
    this.refreshPresets();
    this.rows = [];
    this.liveCurve = null;
    const groups = new Map<string, { body: HTMLElement; items: Array<{ order: number; el: HTMLElement }> }>();
    const groupFor = (name: string) => {
      let g = groups.get(name);
      if (!g) groups.set(name, (g = { body: el('div', 'tun-body'), items: [] }));
      return g;
    };
    const tmpl = template(this.base);
    const add = (path: string[], node: HTMLElement) => {
      const key = path.join('.');
      const i = META_ORDER.indexOf(key);
      groupFor(metaFor(path, getAt(tmpl, path)).group).items.push({ order: i < 0 ? 1e4 + groups.size : i, el: node });
    };
    const walk = (obj: Record<string, unknown>, path: string[]) => {
      for (const [key, t] of Object.entries(obj)) {
        const kp = [...path, key];
        const v = getAt(this.spec, kp);
        if (typeof t === 'object' && t !== null && !Array.isArray(t)) {
          // A nested part (the turbo): its own rows, plus fit / remove when optional.
          if (isOptional(kp)) add(kp, this.optionalObjectRow(kp, v !== undefined));
          if (v !== undefined) walk(t as Record<string, unknown>, kp);
        } else if (v === undefined) {
          add(kp, this.absentRow(kp));
        } else {
          add(kp, this.fieldRow(kp, t));
        }
      }
    };
    for (const s of SECTIONS) walk(tmpl[s] as unknown as Record<string, unknown>, [s]);

    const names = [...groups.keys()].sort((a, b) => (GROUPS.indexOf(a) + 1 || 99) - (GROUPS.indexOf(b) + 1 || 99));
    const nodes = names.map((name) => {
      const g = groups.get(name)!;
      const d = el('details', 'tun-group');
      d.dataset.group = name;
      d.open = this.openGroups.has(name);
      const summary = el('summary', '', name);
      summary.append(el('span', 'tun-count'));
      // Focus left on it would make Space toggle the group instead of the handbrake.
      summary.addEventListener('click', () => summary.blur());
      g.items.sort((a, b) => a.order - b.order);
      g.body.append(...g.items.map((i) => i.el));
      d.append(summary, g.body);
      d.addEventListener('toggle', () => {
        if (d.open) this.openGroups.add(name);
        else this.openGroups.delete(name);
        this.persistUi();
      });
      return d;
    });
    this.form.replaceChildren(...nodes);
    this.refreshMarks();
  }

  private refreshPresets(): void {
    const list = this.store.list(this.base);
    this.select.replaceChildren(
      ...list.map((p) => {
        const o = el('option', '', p.name);
        o.value = p.id;
        return o;
      }),
    );
    this.select.value = this.preset.id;
    this.carName.textContent = CARS[this.base].name;
    const stock = isStock(this.preset);
    this.buttons.get('rename')!.disabled = stock;
    this.buttons.get('delete')!.disabled = stock;
  }

  /** Re-marks rows changed since the last save (●) and tuned away from stock (amber label). */
  private refreshMarks(): void {
    const dirty = this.dirty;
    this.dirtyEl.hidden = !dirty;
    this.buttons.get('save')!.disabled = !dirty || isStock(this.preset);
    this.buttons.get('reset')!.disabled = !dirty;
    this.buttons.get('stock')!.disabled = SECTIONS.every((s) => sameValue(this.spec[s], this.stock[s]));
    for (const r of this.rows) {
      const v = getAt(this.spec, r.path);
      r.el.classList.toggle('changed', !sameValue(v, getAt(this.preset, r.path)));
      r.el.classList.toggle('tuned', !sameValue(v, getAt(this.stock, r.path)));
    }
    for (const d of this.form.querySelectorAll<HTMLDetailsElement>('.tun-group')) {
      const n = d.querySelectorAll('.tun-field.changed').length;
      d.querySelector('.tun-count')!.textContent = n ? ` ● ${n}` : '';
    }
    const errs = crossCheck(this.spec);
    this.warnEl.textContent = errs.length ? `Can’t save until fixed: ${errs.join('; ')}` : '';
    this.warnEl.hidden = !errs.length;
  }

  private syncRows(force = false): void {
    for (const r of this.rows) r.sync(force);
    for (const b of this.form.querySelectorAll('.bad')) b.classList.remove('bad');
  }

  /** A row with its label (stock value and help in the tooltip). */
  private fieldShell(path: string[], m: ReturnType<typeof metaFor>, describeStock: string): HTMLElement {
    const row = el('div', 'tun-field');
    const label = el('label', 'tun-label', m.label);
    label.title = [`${path.join('.')}`, m.help, `Stock: ${describeStock}`].filter(Boolean).join('\n');
    row.append(label);
    if (isOptional(path)) {
      const x = this.button('', '×', `Remove ${m.label.toLowerCase()} (use the default)`, () => this.edit(path, undefined, true));
      x.classList.add('tun-x');
      row.append(x);
    }
    return row;
  }

  private fieldRow(path: string[], tmpl: unknown): HTMLElement {
    const m = metaFor(path, tmpl);
    if (typeof tmpl === 'number') return this.numberRow(path, m);
    if (Array.isArray(tmpl) && Array.isArray(tmpl[0])) return this.curveRow(path, m);
    return this.listRow(path, m, tmpl as number[]);
  }

  /** Slider plus number box (display units). */
  private numberRow(path: string[], m: ReturnType<typeof metaFor>): HTMLElement {
    const digits = digitsFor(m.step);
    const stockV = getAt(this.stock, path) as number | undefined;
    const row = this.fieldShell(path, m, stockV === undefined ? 'none' : `${show(stockV * m.scale, digits)} ${m.unit ?? ''}`.trim());
    const slider = el('input', 'tun-slider');
    slider.type = 'range';
    slider.min = String(m.min);
    slider.max = String(m.max);
    slider.step = String(m.step);
    const num = numberBox();
    const lim = fieldLimit(path, stockV);
    // The sanity range in display units, so its message reads in them.
    const shown: FieldLimit = { ...lim, min: lim.min * m.scale, max: lim.max * m.scale };
    const apply = (display: number, commit: boolean) => {
      const err = checkNumber(display, shown);
      if (err) {
        num.classList.add('bad');
        this.fail(`${m.label} ${err}${m.unit ? ` ${m.unit}` : ''}`);
        return;
      }
      num.classList.remove('bad');
      if (this.edit(path, display / m.scale, commit) === null) {
        this.clearMsg();
        sync(num !== document.activeElement);
      }
    };
    const sync = (box = true) => {
      const v = getAt(this.spec, path) as number;
      slider.value = String(v * m.scale);
      if (box) num.value = show(v * m.scale, digits);
    };
    slider.addEventListener('input', () => {
      num.value = show(+slider.value, digits);
      apply(+slider.value, false);
    });
    // A click that doesn't move it mustn't leave focus (and the arrow keys) on it either.
    slider.addEventListener('pointerup', () => slider.blur());
    slider.addEventListener('change', () => {
      this.h.event('tune', { path: path.join('.'), value: getAt(this.spec, path) });
      slider.blur();
    });
    num.addEventListener('change', () => apply(num.value === '' ? NaN : +num.value, true));
    sync();
    const ctl = el('div', 'tun-ctl');
    ctl.append(slider, num, el('span', 'tun-unit', m.unit ?? ''));
    row.append(ctl);
    this.rows.push({ path, el: row, sync: (force) => sync(force || num !== document.activeElement) });
    return row;
  }

  /** A row of number boxes: gear ratios (add / remove a gear) or a fixed pair like the shift points. */
  private listRow(path: string[], m: ReturnType<typeof metaFor>, tmpl: number[]): HTMLElement {
    const lim = fieldLimit(path, tmpl);
    const variable = !!lim.len;
    const digits = digitsFor(variable ? 0.001 : m.step);
    const stockV = getAt(this.stock, path) as number[] | undefined;
    const row = this.fieldShell(path, m, stockV ? `${stockV.map((v) => show(v * m.scale, digits)).join(', ')} ${m.unit ?? ''}` : 'none');
    // A gear list gets a line of its own; a pair of shift points fits beside its label.
    if (variable) row.classList.add('tun-wide');
    const ctl = el('div', 'tun-ctl tun-list');
    const boxes: HTMLInputElement[] = [];
    const cur = () => getAt(this.spec, path) as number[];
    const commit = (next: number[]) => {
      const err = this.edit(path, next, true);
      for (const b of boxes) b.classList.toggle('bad', !!err);
      if (!err) this.clearMsg();
    };
    cur().forEach((v, i) => {
      const cell = el('label', 'tun-cell');
      const name = m.parts?.[i] ?? (path[path.length - 1] === 'gears' ? ORDINALS[i] ?? `${i + 1}` : `${i + 1}`);
      const box = numberBox(name);
      box.value = show(v * m.scale, digits);
      box.addEventListener('change', () => commit(boxes.map((b, j) => boxValue(b, cur()[j], m.scale, digits))));
      boxes.push(box);
      cell.append(el('span', '', name), box);
      ctl.append(cell);
    });
    if (variable) {
      const [lo, hi] = lim.len!;
      const less = this.button('', '−', 'Remove the top gear', () => commit(cur().slice(0, -1)));
      const more = this.button('', '+', 'Add a gear above the top one', () => {
        const g = cur();
        commit([...g, +(g[g.length - 1] * 0.85).toFixed(3)]);
      });
      less.disabled = cur().length <= lo;
      more.disabled = cur().length >= hi;
      ctl.append(less, more);
    } else if (m.unit) ctl.append(el('span', 'tun-unit', m.unit));
    row.append(ctl);
    this.rows.push({
      path,
      el: row,
      sync: (force) => cur().forEach((v, i) => boxes[i] && (force || boxes[i] !== document.activeElement) && (boxes[i].value = show(v * m.scale, digits))),
    });
    return row;
  }

  /**
   * The torque curve: a plot with power, the engine's live rpm and points to
   * drag, and an [rpm, N·m] table with add / remove.
   */
  private curveRow(path: string[], m: ReturnType<typeof metaFor>): HTMLElement {
    const row = this.fieldShell(path, m, `${(getAt(this.stock, path) as unknown[]).length} points`);
    row.classList.add('tun-wide');
    const lim = fieldLimit(path, getAt(this.stock, path));
    const cur = () => getAt(this.spec, path) as Array<[number, number]>;
    const plot = el('div', 'tun-plot');
    const graph = el('div', 'tun-graph');
    // The curves are redrawn on every edit; the live layer and the handles stay put.
    const curves = el('div', 'tun-layer');
    const liveLayer = el('div', 'tun-layer');
    liveLayer.innerHTML = '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><line class="tun-rpm" y1="0" y2="100"/><polyline class="tun-trail"/></svg>';
    const rpmLine = liveLayer.querySelector('line')!;
    const trail = liveLayer.querySelector('polyline')!;
    const dot = el('div', 'tun-live');
    dot.hidden = true;
    const key = el('div', 'tun-plot-key');
    const liveKey = el('span', 'tun-live-key');
    liveKey.title = 'Engine rpm now, and the torque on tap there at the current boost';
    const table = el('table', 'tun-curve');
    table.innerHTML = '<thead><tr><th>rpm</th><th>N·m</th><th>hp</th><th></th></tr></thead>';
    const tbody = el('tbody');
    table.append(tbody);
    const boxes: Array<[HTMLInputElement, HTMLInputElement]> = [];
    const hpCells: HTMLElement[] = [];
    const commit = (next: Array<[number, number]>) => {
      const err = this.edit(path, next, true);
      for (const pair of boxes) for (const b of pair) b.classList.toggle('bad', !!err);
      if (!err) {
        this.clearMsg();
        update();
      }
    };
    const read = () => {
      const c = cur();
      return boxes.map(([r, t], j) => [boxValue(r, c[j]?.[0], 1, 0), boxValue(t, c[j]?.[1], 1, 1)] as [number, number]);
    };
    cur().forEach(([rpm, nm], i) => {
      const tr = el('tr');
      const r = numberBox('rpm');
      const t = numberBox('N·m');
      r.value = show(rpm, 0);
      t.value = show(nm, 1);
      for (const b of [r, t]) b.addEventListener('change', () => commit(read()));
      const hp = el('td', 'tun-hp');
      hpCells.push(hp);
      const x = this.button('', '×', 'Remove this point', () => commit(cur().filter((_, j) => j !== i)));
      x.disabled = cur().length <= lim.len![0];
      const cells = [r, t].map((b) => {
        const td = el('td');
        td.append(b);
        return td;
      });
      const xc = el('td');
      xc.append(x);
      tr.append(...cells, hp, xc);
      tbody.append(tr);
      boxes.push([r, t]);
    });
    const addRow = el('div', 'dbg-row');
    const more = this.button('', '+ point', 'Add a point 500 rpm past the last', () => {
      const c = cur();
      const [rpm, nm] = c[c.length - 1];
      commit([...c, [rpm + 500, nm]]);
    });
    more.disabled = cur().length >= lim.len![1];
    addRow.append(more);

    // A drag keeps the scale it started on, so the point stays under the pointer.
    let view = curveView(this.spec.drivetrain);
    let drag: { i: number; view: CurveView; moved: boolean } | null = null;
    const handles = cur().map((_, i) => {
      const h = el('div', 'tun-handle');
      h.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        h.classList.add('drag');
        drag = { i, view, moved: false };
      });
      h.addEventListener('pointermove', (e) => drag?.i === i && dragTo(e));
      const end = () => {
        if (drag?.i !== i) return;
        h.classList.remove('drag');
        if (drag.moved) this.h.event('tune', { path: path.join('.'), value: cur() });
        drag = null;
        update();
      };
      h.addEventListener('pointerup', end);
      h.addEventListener('pointercancel', end);
      return h;
    });
    const dragTo = (e: PointerEvent) => {
      const { i, view: v } = drag!;
      const r = graph.getBoundingClientRect();
      const c = cur();
      // Snapped, inside the plot and between its neighbours (the rpm must rise).
      const lo = Math.max(v.lo, (c[i - 1]?.[0] ?? -Infinity) + DRAG_RPM);
      const hi = Math.min(v.hi, (c[i + 1]?.[0] ?? Infinity) - DRAG_RPM);
      const rpmAt = v.lo + ((e.clientX - r.left) / r.width) * (v.hi - v.lo);
      const rpm = lo <= hi ? Math.min(hi, Math.max(lo, Math.round(rpmAt / DRAG_RPM) * DRAG_RPM)) : c[i][0];
      const nmAt = plotValue(((e.clientY - r.top) / r.height) * 100, v.nm);
      const nm = Math.min(Math.floor(v.nm), Math.max(0, Math.round(nmAt)));
      if (rpm === c[i][0] && nm === c[i][1]) return;
      const next = c.map((p) => [...p] as [number, number]);
      next[i] = [rpm, nm];
      const err = this.edit(path, next, false);
      for (const pair of boxes) for (const b of pair) b.classList.toggle('bad', !!err);
      if (err) return;
      drag!.moved = true;
      this.clearMsg();
      syncBoxes(true);
      update();
    };

    const update = () => {
      const D = this.spec.drivetrain;
      view = drag?.view ?? curveView(D);
      cur().forEach(([rpm, nm], i) => {
        if (hpCells[i]) hpCells[i].textContent = show(powerHp(D, rpm), 0);
        const h = handles[i];
        if (!h) return;
        h.style.left = `${plotX(view, rpm)}%`;
        h.style.top = `${plotY(nm, view.nm)}%`;
        h.title = `${show(rpm, 0)} rpm, ${show(nm, 1)} N·m (drag to move)`;
      });
      const drawn = curveSvg(D, view);
      curves.innerHTML = drawn.svg;
      key.innerHTML = drawn.key;
      key.append(liveKey);
    };
    const syncBoxes = (force?: boolean) =>
      cur().forEach(([rpm, nm], i) => {
        const pair = boxes[i];
        if (!pair) return;
        if (force || pair[0] !== document.activeElement) pair[0].value = show(rpm, 0);
        if (force || pair[1] !== document.activeElement) pair[1].value = show(nm, 1);
      });

    // The engine as it runs: a line at its rpm, a dot at the torque on tap, and where it's been.
    const recent: Array<[number, number, number]> = [];
    this.liveCurve = (time, rpm, nm) => {
      if (recent.length && (time < recent[0][0] || time - recent[0][0] > 60)) recent.length = 0;
      recent.push([time, rpm, nm]);
      while (time - recent[0][0] > TRAIL_S) recent.shift();
      const x = plotX(view, rpm).toFixed(2);
      rpmLine.setAttribute('x1', x);
      rpmLine.setAttribute('x2', x);
      trail.setAttribute('points', recent.map(([, r, n]) => `${plotX(view, r).toFixed(2)},${plotY(n, view.nm).toFixed(2)}`).join(' '));
      dot.hidden = false;
      dot.style.left = `${x}%`;
      dot.style.top = `${plotY(nm, view.nm)}%`;
      liveKey.textContent = `now ${Math.round(rpm)} rpm, ${Math.round(nm)} N·m`;
    };

    update();
    graph.append(curves, liveLayer, ...handles, dot);
    plot.append(graph, key);
    const ctl = el('div', 'tun-ctl tun-curve-wrap');
    ctl.append(plot, table, addRow);
    row.append(ctl);
    this.rows.push({
      path,
      el: row,
      sync: (force) => {
        syncBoxes(force);
        update();
      },
    });
    return row;
  }

  /** An optional field this preset goes without, with a button to add it (from a stock car that has it). */
  private absentRow(path: string[]): HTMLElement {
    const tmpl = getAt(template(this.base), path);
    const m = metaFor(path, tmpl);
    const row = el('div', 'tun-field tun-absent');
    row.append(el('label', 'tun-label', m.label));
    row.append(this.button('', 'Add', `Add ${m.label.toLowerCase()}, starting from ${donorName(path)}’s value`, () => this.edit(path, structuredClone(tmpl), true)));
    this.rows.push({ path, el: row, sync: () => {} });
    return row;
  }

  /** Fit / remove an optional part such as the turbo. */
  private optionalObjectRow(path: string[], present: boolean): HTMLElement {
    const m = metaFor(path, null);
    const row = el('div', 'tun-field tun-absent');
    row.append(el('label', 'tun-label', present ? `${m.label} fitted` : `No ${m.label.toLowerCase()}`));
    const tmpl = getAt(template(this.base), path);
    row.append(
      present
        ? this.button('', `Remove ${m.label.toLowerCase()}`, `Take the ${m.label.toLowerCase()} off`, () => this.edit(path, undefined, true))
        : this.button('', `Fit ${m.label.toLowerCase()}`, `Fit one, starting from ${donorName(path)}’s`, () => this.edit(path, structuredClone(tmpl), true)),
    );
    this.rows.push({ path, el: row, sync: () => {} });
    return row;
  }
}

/** The stock car an optional field's starting value comes from. */
function donorName(path: readonly string[]): string {
  const id = (Object.keys(CARS) as CarId[]).find((c) => getAt(CARS[c], path) !== undefined);
  return id ? `the ${CARS[id].name.toLowerCase()}` : 'the default';
}

/** The torque plot's scale: rpm across, N·m up (with headroom to drag the peak higher). */
interface CurveView {
  lo: number;
  hi: number;
  nm: number;
}

/** Plot headroom over each line's peak. */
const HEADROOM = 1.25;
/** Dragged curve points snap to this, and keep this far from their neighbours. */
const DRAG_RPM = 50;
/** Seconds of live rpm the plot trails. */
const TRAIL_S = 1.5;

function curveView(D: CarSpec['drivetrain']): CurveView {
  return {
    lo: Math.min(D.idleRpm, D.torque[0][0]),
    hi: Math.max(D.limiter, D.torque[D.torque.length - 1][0]),
    nm: Math.max(1, ...D.torque.map((p) => p[1])) * HEADROOM,
  };
}

// Plot coordinates are percentages of its box (the svg's viewBox is 0–100 both ways).
const plotX = (v: CurveView, rpm: number) => ((rpm - v.lo) / (v.hi - v.lo)) * 100;
const plotY = (value: number, max: number) => 98 - (value / max) * 96;
const plotValue = (y: number, max: number) => ((98 - y) / 96) * max;

/** Torque (red) and power (amber) from idle to the limiter, power scaled to its own peak; the redline dashed. */
function curveSvg(D: CarSpec['drivetrain'], v: CurveView): { svg: string; key: string } {
  const xs = Array.from({ length: 121 }, (_, i) => v.lo + ((v.hi - v.lo) * i) / 120);
  const hp = xs.map((r) => powerHp(D, r));
  const hpPeak = Math.max(...hp, 1e-6);
  const pt = (rpm: number, y: number, max: number) => `${plotX(v, rpm).toFixed(2)},${plotY(y, max).toFixed(2)}`;
  // Torque is straight between its points and flat past the ends (torqueAt), so drawn through them exactly.
  const c = D.torque;
  const tq = [[v.lo, c[0][1]], ...c, [v.hi, c[c.length - 1][1]]].map(([r, t]) => pt(r, t, v.nm)).join(' ');
  const pw = xs.map((r, i) => pt(r, hp[i], hpPeak * HEADROOM)).join(' ');
  // Peak torque at its curve point; peak power sampled, to the nearest 50 rpm.
  const [nmRpm, nmPeak] = c.reduce((a, p) => (p[1] > a[1] ? p : a));
  const hpRpm = Math.round(xs[hp.indexOf(hpPeak)] / 50) * 50;
  const red = plotX(v, D.redline).toFixed(2);
  return {
    svg:
      `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">` +
      `<line x1="${red}" x2="${red}" y1="0" y2="100" class="tun-redline"/>` +
      `<polyline points="${tq}" class="tun-tq"/><polyline points="${pw}" class="tun-pw"/></svg>`,
    key:
      `<span class="tun-tq-key">${Math.round(nmPeak)} N·m @ ${nmRpm}</span>` +
      `<span class="tun-pw-key">${Math.round(hpPeak)} hp @ ${hpRpm}</span><span>${Math.round(v.lo)}–${Math.round(v.hi)} rpm</span>`,
  };
}
