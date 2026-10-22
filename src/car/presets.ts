// Car tuning presets: a named set of chassis and drivetrain numbers for one of
// the cars (its body model and engine sound come from the base car). The stock
// cars are read-only built-in presets; the player's own live in localStorage.
//
// The schema is the stock specs themselves, walked at runtime, so a field added
// to cars.ts is validated (and filled into older presets from the base car's
// stock value) without touching this file. FIELDS only adds sanity limits.

import { CAR_IDS, CARS, isCarId, type CarId, type CarSpec, type ChassisSpec, type DrivetrainSpec } from './cars';

/** Bumped when a preset's meaning changes in a way old files can't be read as. */
export const PRESET_VERSION = 1;
/** Marks exported files, so a stray JSON file is recognised as not ours. */
export const PRESET_FORMAT = 'drift.earth/car-preset';
export const BUNDLE_FORMAT = 'drift.earth/car-presets';
/** Longest preset name: renames and the " (2)" suffixes stay within it. */
const NAME_MAX = 60;

export interface CarPreset {
  version: number;
  /** Unique; `stock-<base>` for the built-ins. */
  id: string;
  name: string;
  /** The car it tunes: body model, engine sound, drive layout and paint come from it. */
  base: CarId;
  chassis: ChassisSpec;
  drivetrain: DrivetrainSpec;
  /** ISO time of the last save. */
  updated: string;
}

export type Section = 'chassis' | 'drivetrain';
export const SECTIONS: Section[] = ['chassis', 'drivetrain'];

/**
 * Sanity limits, in stored (SI) units: generous, only there to keep a typo or
 * a hand-edited file from feeding the physics a NaN or a 0 it divides by.
 * `above` makes `min` exclusive. Arrays: `len` for variable-length lists (others
 * keep their stock length), `order` for the ratios / curve rpm, `cols` for
 * [rpm, N·m] pairs. Keys missing here get a generic range from their stock value.
 */
export interface FieldLimit {
  min: number;
  max: number;
  above?: boolean;
  len?: [number, number];
  order?: 'asc' | 'desc';
  cols?: [FieldLimit, FieldLimit];
}

const pos = (max: number): FieldLimit => ({ min: 0, max, above: true });
const range = (min: number, max: number): FieldLimit => ({ min, max });
const RPM = range(0, 30000);

export const FIELDS: Record<string, FieldLimit> = {
  'chassis.mass': pos(20000),
  'chassis.wheelbase': range(0.5, 10),
  'chassis.halfWidth': range(0.2, 5),
  'chassis.halfLength': range(0.5, 10),
  'chassis.cornerX': range(0.1, 5),
  'chassis.cornerZ': range(0.1, 10),
  'chassis.topSpeed': pos(200),
  'chassis.topSpeedReverse': range(0, 100),
  'chassis.reverseAccel': range(0, 100),
  'chassis.rollingDecel': range(0, 20),
  'chassis.dragK': range(0, 0.1),
  'chassis.yawInertia': pos(100000),
  'chassis.cgToFront': pos(10),
  'chassis.cgHeight': range(0, 3),
  'chassis.muFront': pos(5),
  'chassis.muRear': pos(5),
  'chassis.muRearSide': pos(5),
  'chassis.peakSlipAngle': pos(1.2),
  'chassis.peakSlipRatio': pos(2),
  'chassis.slideFront': range(0, 2),
  'chassis.slideRear': range(0, 2),
  'chassis.steerMax': pos(1.5),
  'chassis.steerSpeedFalloff': pos(1000),
  'chassis.steerRate': pos(100),
  'chassis.steerReturn': pos(100),
  'chassis.steerAlign': range(0, 2),
  'chassis.wheelLock': pos(1.5),
  'chassis.brakeDecel': range(0, 100),
  'chassis.brakeFront': range(0, 1),
  'chassis.absLimit': range(0, 3),
  'chassis.handbrakeForce': range(0, 5),
  'chassis.stability': range(0, 5000),
  'chassis.stabilityOff': range(0, 30),
  'chassis.stabilitySlip': range(0, 1.5),
  'chassis.tractionControl': range(0, 1),
  'drivetrain.wheelRadius': range(0.1, 2),
  'drivetrain.finalDrive': pos(20),
  'drivetrain.gears': { ...pos(20), len: [1, 10], order: 'desc' },
  'drivetrain.reverse': pos(20),
  'drivetrain.efficiency': pos(1),
  'drivetrain.idleRpm': range(100, 5000),
  'drivetrain.redline': range(500, 30000),
  'drivetrain.limiter': range(500, 30000),
  'drivetrain.limiterCut': range(0, 2),
  'drivetrain.clutchRpm': RPM,
  'drivetrain.launchRpm': RPM,
  'drivetrain.torque': { ...RPM, len: [2, 40], order: 'asc', cols: [RPM, range(0, 10000)] },
  'drivetrain.turbo.onsetRpm': RPM,
  'drivetrain.turbo.fullRpm': RPM,
  'drivetrain.turbo.spool': pos(20),
  'drivetrain.turbo.vent': pos(20),
  'drivetrain.turbo.share': range(0, 1),
  'drivetrain.engineBrakeTorque': range(0, 5000),
  'drivetrain.wheelInertia': pos(100),
  'drivetrain.engineInertia': pos(50),
  'drivetrain.shiftTime': range(0, 5),
  'drivetrain.autoUpRpm': RPM,
  'drivetrain.autoDownRpm': RPM,
  'drivetrain.autoHold': range(0, 30),
};

// --- Schema (from the stock specs) -----------------------------------------------

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export function getAt(root: unknown, path: readonly string[]): unknown {
  let v = root;
  for (const k of path) v = isObject(v) ? v[k] : undefined;
  return v;
}

/** Sets (or, with `undefined`, deletes) the value at `path`; the parents must exist. */
export function setAt(root: object, path: readonly string[], value: unknown): void {
  const parent = getAt(root, path.slice(0, -1)) as Json;
  const key = path[path.length - 1];
  if (value === undefined) delete parent[key];
  else parent[key] = value;
}

/**
 * Every field any stock car has, with the base car's value where it has one:
 * the shape a preset of `base` may take. (A field only some cars have, like
 * the turbo, is optional: see `isOptional`.)
 */
export function template(base: CarId): Pick<CarSpec, Section> {
  const merge = (into: Json, from: Json) => {
    for (const [k, v] of Object.entries(from)) {
      if (!(k in into)) into[k] = structuredClone(v);
      else if (isObject(into[k]) && isObject(v)) merge(into[k] as Json, v);
    }
  };
  const out = { chassis: {}, drivetrain: {} } as Json;
  for (const id of [base, ...CAR_IDS.filter((c) => c !== base)]) {
    for (const s of SECTIONS) merge(out[s] as Json, CARS[id][s] as unknown as Json);
  }
  return out as unknown as Pick<CarSpec, Section>;
}

/** A field some stock car goes without (inside a parent it has): a preset may leave it out. */
export function isOptional(path: readonly string[]): boolean {
  return CAR_IDS.some((id) => {
    const parent = getAt(CARS[id], path.slice(0, -1));
    return isObject(parent) && !(path[path.length - 1] in parent);
  });
}

/** Sanity limits for a field (or an array's elements), from FIELDS or its stock value. */
export function fieldLimit(path: readonly string[], stock: unknown): FieldLimit {
  const known = FIELDS[path.join('.')];
  if (known) return known;
  const v = Array.isArray(stock) ? (stock.flat()[0] as number) : (stock as number);
  const big = Math.max(1, Math.abs(Number.isFinite(v) ? v : 1)) * 100;
  return v < 0 ? range(-big, big) : range(0, big);
}

const fmt = (n: number) => String(+n.toPrecision(6));
const name = (path: readonly string[]) => path.join('.');

/** Why `v` isn't an acceptable value for a number field, or null. */
export function checkNumber(v: unknown, lim: FieldLimit): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'must be a number';
  if (lim.above ? v <= lim.min : v < lim.min) return `must be ${lim.above ? 'above' : 'at least'} ${fmt(lim.min)}`;
  if (v > lim.max) return `must be at most ${fmt(lim.max)}`;
  return null;
}

/**
 * Validates one field against the stock value it stands in for (`tmpl`: number,
 * number list, [a, b] pair list or object), pushing `path: problem` messages.
 * Returns a clean copy: unknown keys dropped, missing ones filled from `fill`
 * (the base car's stock value there, if it has one).
 */
export function cleanValue(v: unknown, path: readonly string[], tmpl: unknown, fill: unknown, errs: string[]): unknown {
  const fail = (msg: string) => {
    errs.push(`${name(path)} ${msg}`);
    return structuredClone(fill ?? tmpl);
  };
  if (typeof tmpl === 'number') {
    const err = checkNumber(v, fieldLimit(path, tmpl));
    return err ? fail(err) : v;
  }
  if (Array.isArray(tmpl)) {
    if (!Array.isArray(v)) return fail('must be a list');
    const lim = fieldLimit(path, tmpl);
    const pairs = Array.isArray(tmpl[0]);
    const [lo, hi] = lim.len ?? (pairs ? [2, 64] : [tmpl.length, tmpl.length]);
    if (v.length < lo || v.length > hi) return fail(lo === hi ? `must have ${lo} values` : `must have ${lo}–${hi} entries`);
    const keys: number[] = [];
    for (let i = 0; i < v.length; i++) {
      const e = v[i];
      if (pairs) {
        if (!Array.isArray(e) || e.length !== 2) return fail(`[${i}] must be a [${pathIs(path, 'torque') ? 'rpm, N·m' : 'a, b'}] pair`);
        for (let j = 0; j < 2; j++) {
          const err = checkNumber(e[j], lim.cols?.[j] ?? lim);
          if (err) return fail(`[${i}][${j}] ${err}`);
        }
        keys.push(e[0]);
      } else {
        const err = checkNumber(e, lim);
        if (err) return fail(`[${i}] ${err}`);
        keys.push(e);
      }
    }
    if (lim.order) {
      for (let i = 1; i < keys.length; i++) {
        const ok = lim.order === 'asc' ? keys[i] > keys[i - 1] : keys[i] < keys[i - 1];
        if (!ok) return fail(pairs ? `rpm must rise from point to point (point ${i + 1})` : `must fall from one to the next (entry ${i + 1})`);
      }
    }
    return structuredClone(v);
  }
  if (isObject(tmpl)) {
    if (!isObject(v)) return fail('must be an object');
    const out: Json = {};
    const stock = isObject(fill) ? fill : null;
    for (const [key, t] of Object.entries(tmpl)) {
      const kp = [...path, key];
      const e = v[key];
      if (e === undefined) {
        // An older preset: fill from the base car. Inside an object the base car
        // doesn't have (a turbo fitted to the muscle car), from the template.
        const from = stock ? stock[key] : isOptional(kp) ? undefined : t;
        if (from !== undefined) out[key] = structuredClone(from);
      } else if (e === null) {
        // Written for a field the preset deliberately goes without.
        if (!isOptional(kp)) errs.push(`${name(kp)} is required`);
      } else {
        out[key] = cleanValue(e, kp, t, stock?.[key], errs);
      }
    }
    return out;
  }
  return fail('has no schema');
}

const pathIs = (path: readonly string[], key: string) => path[path.length - 1] === key;

/** Rules between fields; each problem as a message. A preset with any can't be saved. */
export function crossCheck(spec: Pick<CarSpec, Section>): string[] {
  const c = spec.chassis;
  const d = spec.drivetrain;
  const errs: string[] = [];
  if (c.cgToFront >= c.wheelbase) errs.push('chassis.cgToFront must be shorter than the wheelbase');
  if (d.idleRpm >= d.redline) errs.push('drivetrain.idleRpm must be below the redline');
  if (d.limiter < d.redline) errs.push('drivetrain.limiter must be at or above the redline');
  if (d.turbo && d.turbo.onsetRpm >= d.turbo.fullRpm) errs.push('drivetrain.turbo.onsetRpm must be below fullRpm');
  for (let i = 0; i < 2; i++) {
    if (d.autoDownRpm[i] >= d.autoUpRpm[i]) errs.push(`drivetrain.autoDownRpm[${i}] must be below autoUpRpm[${i}]`);
  }
  return errs;
}

// --- Presets ---------------------------------------------------------------------

const STOCK_PREFIX = 'stock-';

export function stockPreset(base: CarId): CarPreset {
  const car = CARS[base];
  return {
    version: PRESET_VERSION,
    id: `${STOCK_PREFIX}${base}`,
    name: 'Stock',
    base,
    chassis: structuredClone(car.chassis),
    drivetrain: structuredClone(car.drivetrain),
    updated: '',
  };
}

export const isStock = (p: CarPreset) => p.id.startsWith(STOCK_PREFIX);

/** A drivable spec: the base car's identity with a working copy of the preset's numbers. */
export function presetSpec(p: Pick<CarPreset, 'base' | Section>): CarSpec {
  return { ...CARS[p.base], chassis: structuredClone(p.chassis), drivetrain: structuredClone(p.drivetrain) };
}

/**
 * Equal within float noise (a value nudged off and back, or degrees converted
 * there and back, still counts as unchanged).
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => sameValue(a[k], b[k]));
  }
  return a === b;
}

export function freshId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The preset as JSON-ready data. An optional field the preset goes without is
 * written as null, so loading it doesn't fill the base car's value back in (a
 * hot hatch with its turbo taken off stays without one).
 */
export function serialize(p: CarPreset): Json {
  const tmpl = template(p.base) as unknown as Json;
  const withNulls = (v: Json, t: Json, path: string[]): Json => {
    const out: Json = {};
    for (const [k, tv] of Object.entries(t)) {
      const kp = [...path, k];
      if (v[k] === undefined) {
        if (isOptional(kp)) out[k] = null;
      } else {
        out[k] = isObject(v[k]) && isObject(tv) ? withNulls(v[k] as Json, tv, kp) : v[k];
      }
    }
    return out;
  };
  return {
    format: PRESET_FORMAT,
    version: p.version,
    id: p.id,
    name: p.name,
    base: p.base,
    updated: p.updated,
    chassis: withNulls(p.chassis as unknown as Json, tmpl.chassis as Json, ['chassis']),
    drivetrain: withNulls(p.drivetrain as unknown as Json, tmpl.drivetrain as Json, ['drivetrain']),
  };
}

/** Validates one preset object strictly; throws an Error listing every problem. */
export function parsePreset(raw: unknown): CarPreset {
  if (!isObject(raw)) throw new Error('not a preset object');
  const errs: string[] = [];
  if (raw.format !== undefined && raw.format !== PRESET_FORMAT) errs.push(`format must be "${PRESET_FORMAT}"`);
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) errs.push('version must be a whole number from 1');
  else if (version > PRESET_VERSION) errs.push(`version ${version} is newer than this game reads (${PRESET_VERSION})`);
  const base = raw.base;
  if (typeof base !== 'string' || !isCarId(base)) {
    throw new Error([...errs, `base must be one of ${CAR_IDS.join(', ')}`].join('; '));
  }
  const nm = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!nm || nm.length > NAME_MAX) errs.push(`name must be 1–${NAME_MAX} characters`);
  const tmpl = template(base);
  const stock = CARS[base];
  const parts = {} as Pick<CarSpec, Section>;
  for (const s of SECTIONS) {
    if (!isObject(raw[s])) {
      errs.push(`${s} must be an object`);
      continue;
    }
    (parts as Json)[s] = cleanValue(raw[s], [s], tmpl[s], stock[s], errs);
  }
  if (!errs.length) errs.push(...crossCheck(parts));
  if (errs.length) throw new Error(errs.join('; '));
  const id = typeof raw.id === 'string' && /^[\w.:-]{1,64}$/.test(raw.id) ? raw.id : freshId();
  const updated = typeof raw.updated === 'string' && !Number.isNaN(Date.parse(raw.updated)) ? raw.updated : new Date().toISOString();
  return { version: PRESET_VERSION, id, name: nm, base, chassis: parts.chassis, drivetrain: parts.drivetrain, updated };
}

/**
 * Reads an imported file or pasted text: one preset, an `export all` bundle or
 * a plain array of presets. Valid presets come back even if others failed.
 */
export function parsePresets(text: string): { presets: CarPreset[]; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { presets: [], errors: [`Not valid JSON: ${(e as Error).message}`] };
  }
  let list: unknown[];
  if (Array.isArray(raw)) list = raw;
  else if (isObject(raw) && 'presets' in raw) {
    if (raw.format !== undefined && raw.format !== BUNDLE_FORMAT) return { presets: [], errors: [`format must be "${BUNDLE_FORMAT}"`] };
    if (!Array.isArray(raw.presets)) return { presets: [], errors: ['presets must be a list'] };
    list = raw.presets;
  } else list = [raw];
  if (!list.length) return { presets: [], errors: ['No presets in it'] };
  const presets: CarPreset[] = [];
  const errors: string[] = [];
  list.forEach((p, i) => {
    try {
      presets.push(parsePreset(p));
    } catch (e) {
      const label = isObject(p) && typeof p.name === 'string' ? `“${p.name.slice(0, NAME_MAX)}”` : `#${i + 1}`;
      errors.push(`${list.length > 1 ? `Preset ${label}: ` : ''}${(e as Error).message}`);
    }
  });
  return { presets, errors };
}

export function bundle(presets: CarPreset[]): Json {
  return { format: BUNDLE_FORMAT, version: PRESET_VERSION, presets: presets.map(serialize) };
}

// --- Storage -----------------------------------------------------------------------

const STORAGE = 'drift.earth:presets';

interface Stored {
  version: number;
  presets: unknown[];
  /** The preset each car drives on, by id. */
  active: Partial<Record<CarId, string>>;
}

/**
 * The player's presets and which one each car uses, in localStorage. Every
 * access is guarded: with storage blocked it works for the session only.
 */
export class PresetStore {
  private presets: CarPreset[] = [];
  private active: Partial<Record<CarId, string>> = {};

  constructor() {
    this.load();
  }

  /** The stock preset first, then the player's, by name. */
  list(base: CarId): CarPreset[] {
    const mine = this.presets.filter((p) => p.base === base).sort((a, b) => a.name.localeCompare(b.name));
    return [stockPreset(base), ...mine];
  }

  /** Every user preset, for `export all`. */
  all(): CarPreset[] {
    return [...this.presets];
  }

  get(id: string): CarPreset | null {
    const stock = CAR_IDS.find((b) => id === `${STOCK_PREFIX}${b}`);
    if (stock) return stockPreset(stock);
    return this.presets.find((p) => p.id === id) ?? null;
  }

  activeFor(base: CarId): CarPreset {
    const p = this.get(this.active[base] ?? '');
    return p && p.base === base ? p : stockPreset(base);
  }

  setActive(base: CarId, id: string): void {
    this.active[base] = id;
    this.persist();
  }

  /** Adds or replaces (by id) a user preset. */
  put(p: CarPreset): void {
    if (isStock(p)) throw new Error('The stock presets are read-only');
    const i = this.presets.findIndex((q) => q.id === p.id);
    if (i >= 0) this.presets[i] = p;
    else this.presets.push(p);
    this.persist();
  }

  remove(id: string): void {
    this.presets = this.presets.filter((p) => p.id !== id);
    for (const b of CAR_IDS) if (this.active[b] === id) delete this.active[b];
    this.persist();
  }

  /** `name`, or `name (2)`, `name (3)`… if the car already has a preset called that. */
  uniqueName(base: CarId, name: string, except?: string): string {
    const taken = new Set(this.list(base).filter((p) => p.id !== except).map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    const stem = name.replace(/ \(\d+\)$/, '');
    for (let n = 2; ; n++) {
      // Within the name limit, or the next load would refuse (and drop) it.
      const suffix = ` (${n})`;
      const candidate = `${stem.slice(0, NAME_MAX - suffix.length)}${suffix}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  /** An imported preset whose id is taken (or is a stock id) gets a fresh one. */
  adopt(p: CarPreset): CarPreset {
    const id = isStock(p) || this.get(p.id) ? freshId() : p.id;
    return { ...p, id, name: this.uniqueName(p.base, p.name) };
  }

  private load(): void {
    let saved: Stored | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE) ?? 'null') as Stored | null;
    } catch {
      return;
    }
    if (!isObject(saved)) return;
    if (Array.isArray(saved.presets)) {
      for (const raw of saved.presets) {
        try {
          const p = parsePreset(raw);
          if (!isStock(p) && !this.get(p.id)) this.presets.push(p);
        } catch (e) {
          console.warn(`Dropped a stored car preset: ${(e as Error).message}`);
        }
      }
    }
    if (isObject(saved.active)) {
      for (const b of CAR_IDS) {
        const id = saved.active[b];
        if (typeof id === 'string') this.active[b] = id;
      }
    }
  }

  private persist(): void {
    try {
      const data: Stored = { version: PRESET_VERSION, presets: this.presets.map(serialize), active: this.active };
      localStorage.setItem(STORAGE, JSON.stringify(data));
    } catch {
      // Not persisted (storage blocked or full): this session still has them.
    }
  }
}
