/**
 * Synthesized car audio. Starts on the first user gesture.
 *
 * - Engine: fired cylinder by cylinder in an AudioWorklet, each car's engine
 *   described by a CarSound. Each firing is a combustion pulse sized by
 *   throttle, with per-cylinder imbalance and cycle-to-cycle jitter, and goes
 *   out of its own exhaust; each pipe resonates (a tuned delay loop), is
 *   muffled by load and lightly saturated; an intake roar comes in under
 *   load. Overrun after a high-rpm lift crackles, the limiter's fuel cut
 *   stutters, and a hard upshift pops.
 *   - Muscle car: a cross-plane V8 with true dual exhausts. Each bank fires at
 *     uneven intervals into its own pipe, which is where a V8's burble and low
 *     body come from even at high revs.
 *   - Hot hatch: a turbo inline four, after a Focus ST. Even firing into one
 *     pipe, tuned for mid-range rasp over the V8's boom; a gruff induction
 *     growl under load (the ST pipes its intake into the cabin), a turbo
 *     whistle with boost, a blow-off 'pssh' when the throttle lifts on boost,
 *     and a keener overrun crackle.
 * - Transmission: gear whine at the gear-mesh frequency (so it changes with
 *   each gear; reverse's straight-cut gears whine loudest), differential whine
 *   with road speed, and a clunk on every shift.
 * - Tires: front and rear squeal voices pitched by how fast each axle slides,
 *   a rasp from wheelspin and rolling road noise with speed.
 * - Wind: a rush either side that rises in pitch and swells with speed,
 *   gusting on its own each side, with a low buffeting under it. Sliding
 *   sideways, it blows harder and from the side the air comes from.
 * - Placement: each voice comes from its place on the car (the tailpipes, the
 *   engine bay, the gearbox, each axle), heard from a few metres behind the
 *   car along the camera's view; the camera itself is too far back to tell
 *   them apart. HRTF on headphones, plain level panning on speakers.
 */

import { CARS, DEFAULT_CAR, type CarId, type DrivetrainSpec } from './car/cars';
import { AUDIO } from './config';

export interface AudioState {
  /** Engine rpm and redline. */
  rpm: number;
  redline: number;
  /** Throttle the engine is getting (0–1). */
  throttle: number;
  /** The rev limiter is cutting fuel; a shift is in progress (drive cut). */
  limiting: boolean;
  shifting: boolean;
  /** −1 reverse, else 1…6. */
  gear: number;
  /** Clutch locked to the wheels (gear noise only then). */
  engaged: boolean;
  /** Turbo boost, 0…1 (always 0 for a naturally aspirated engine). */
  boost: number;
  /** Ground speed (m/s). */
  speed: number;
  /** How far the driven wheels' surface speed runs ahead of the road (m/s). */
  wheelSpin: number;
  /** Sliding speed at the front and rear contact patches (m/s). */
  slideF: number;
  slideR: number;
  airborne: boolean;
  /** The car's heading relative to the camera's view (rad, left +): which way it faces the listener. */
  yaw: number;
  /** Which way the car is travelling, relative to the camera's view (rad, left +): where the wind comes from. */
  travel: number;
}

/** A point on the car (m): x right, y up from the road, z back (the car faces −z, as in CarModel). */
type Vec3 = readonly [x: number, y: number, z: number];

/** How one car's engine, exhaust and gearbox sound. */
interface CarSound {
  /** The exhaust (0 or 1) each firing goes out of, in firing order; its length is the cylinder count. */
  banks: number[];
  /** Crank degrees a blowdown pulse lasts, smeared by the header. */
  blowdownDeg: number;
  /** Cylinder-to-cylinder spread in how hard each burns (± half this). */
  trimSpread: number;
  /** Chance per firing, at full overrun, of an unburnt charge popping in the exhaust. */
  popChance: number;
  /** Per exhaust outlet (index = bank): its pipe's resonant delay (s) and where it comes out. */
  pipes: Array<[delay: number, at: Vec3]>;
  /** Where the intake (and turbo, and blow-off valve) and the gearbox are. */
  engineBay: Vec3;
  gearbox: Vec3;
  /** The pipe loop's damping lowpass (Hz) and feedback: how many overtones ring, and how long. */
  pipeDamp: number;
  pipeFeedback: number;
  /** Below this the exhaust is DC and rumble (Hz). */
  highpass: number;
  /** Body EQ after the pipe: peaking filters as [Hz, Q, dB]. */
  eq: Array<[hz: number, q: number, db: number]>;
  /** Muffle lowpass (Hz): base + load·throttle·(0.35 + 0.65·frac) + rev·frac, frac = rpm / redline. */
  muffle: { base: number; load: number; rev: number; q: number };
  /** Exhaust saturation drive. */
  drive: number;
  /** Exhaust level at full load and redline. */
  level: number;
  /**
   * Intake: noise shaped by the firing envelope, plus `tone` of the exhaust
   * pulses (an induction growl rather than a hiss), through a bandpass at
   * base + rev·frac Hz; gain·load·frac^power, saturated by `drive` if set.
   */
  intake: { base: number; rev: number; q: number; gain: number; power: number; tone: number; drive: number };
  /** Overrun: seconds of crackle after a lift, the rpm (as frac) it ramps in over, and the steady share on a closed throttle. */
  pops: { crackle: number; from: number; to: number; overrunFrom: number; overrunTo: number; overrun: number; gain: number; highpass: number; presence: number };
  /** Turbo whistle (Hz at no boost and the rise at full boost and redline, gain at full) and blow-off gain; null without one. */
  turbo: { whistle: number; rise: number; gain: number; blowOff: number } | null;
  /** Gear-mesh teeth per input-shaft turn, by gear (reverse: straight-cut idler). */
  gearTeeth: Record<number, number>;
  /** Final-drive pinion teeth (it turns finalDrive times per wheel turn) and the diff whine's level. */
  pinionTeeth: number;
  diffGain: number;
}

const SOUNDS: Record<CarId, CarSound> = {
  muscle: {
    // Cross-plane V8, firing order 1-8-4-3-6-5-7-2: the bank each firing goes
    // out of. Each bank fires 270, 180, 90, 180 degrees apart.
    banks: [0, 1, 1, 0, 1, 0, 0, 1],
    blowdownDeg: 110,
    trimSpread: 0.14,
    popChance: 0.026,
    // Slightly different pipe lengths keep the banks from sounding identical.
    // Out either side of the rear bumper.
    pipes: [
      [0.0118, [-0.55, 0.3, 2.1]],
      [0.0134, [0.55, 0.3, 2.1]],
    ],
    engineBay: [0, 0.8, -1.5],
    // Behind the engine, under the front of the cabin.
    gearbox: [0, 0.4, -0.3],
    pipeDamp: 650,
    pipeFeedback: 0.55,
    highpass: 25,
    eq: [
      [95, 0.8, 6],
      [260, 1, 3],
    ],
    muffle: { base: 320, load: 1700, rev: 500, q: 0.9 },
    drive: 1.3,
    level: 0.5,
    intake: { base: 500, rev: 1000, q: 0.9, gain: 0.3, power: 2, tone: 0, drive: 0 },
    pops: { crackle: 1.6, from: 0.35, to: 0.7, overrunFrom: 0.45, overrunTo: 0.8, overrun: 0.25, gain: 0.55, highpass: 180, presence: 1800 },
    turbo: null,
    gearTeeth: { [-1]: 37, 1: 14, 2: 18, 3: 22, 4: 25, 5: 28, 6: 31 },
    pinionTeeth: 11,
    diffGain: 0.006,
  },
  hatch: {
    // Inline four, firing order 1-3-4-2: a firing every 180 degrees, all into
    // one pipe.
    banks: [0, 0, 0, 0],
    // A sharper pulse than the V8's: with half the firings, a smeared one
    // leaves little but the fundamental, a hum.
    blowdownDeg: 60,
    // More uneven than the V8: the four's lilt at idle and light load.
    trimSpread: 0.3,
    // Half as many firings as the V8 and still pops more often.
    popChance: 0.065,
    // One shorter pipe: it rings at 217 Hz and up, not in the V8's sub-bass.
    // Out the middle of the bumper, like the ST's.
    pipes: [[0.0046, [0, 0.3, 2.15]]],
    engineBay: [0, 0.8, -1.55],
    // A transverse transaxle, beside the engine at the front axle.
    gearbox: [0.25, 0.4, -1.3],
    pipeDamp: 950,
    pipeFeedback: 0.5,
    highpass: 40,
    // Rasp at 380–700 Hz; the dip at 1.4 kHz keeps it from buzzing like a bike.
    eq: [
      [380, 0.8, 7],
      [700, 1.2, 3],
      [1400, 1.2, -2],
    ],
    muffle: { base: 380, load: 1800, rev: 600, q: 0.8 },
    drive: 2,
    level: 0.44,
    intake: { base: 220, rev: 450, q: 1.6, gain: 0.7, power: 1, tone: 1, drive: 2.5 },
    pops: { crackle: 2.2, from: 0.3, to: 0.6, overrunFrom: 0.4, overrunTo: 0.75, overrun: 0.4, gain: 0.6, highpass: 220, presence: 2200 },
    turbo: { whistle: 2400, rise: 3200, gain: 0.02, blowOff: 0.27 },
    // A helical transaxle: quieter final drive than a hypoid rear axle.
    gearTeeth: { [-1]: 33, 1: 13, 2: 17, 3: 21, 4: 26, 5: 29, 6: 32 },
    pinionTeeth: 17,
    diffGain: 0.004,
  },
};

const MASTER = 0.5;
/**
 * A mono voice straight into the stereo bus plays at full level in both ears;
 * an equal-power panner gives each ear 0.707 of it in the middle. Voices that
 * went straight in before they were placed get this back, to keep the mix.
 */
const CENTRE_LIFT = Math.SQRT2;
/**
 * The browser's HRTF swells around 230 Hz (+6 dB) and thins the deep bass,
 * whichever way the sound comes from; this takes it back out so headphones
 * keep the tuned sound. Measured against equal-power panning in Chrome (within
 * ±1.3 dB from 30 Hz to 5 kHz after it, but for the notches that tell
 * direction).
 */
const HRTF_EQ: Array<[type: BiquadFilterType, hz: number, q: number, db: number]> = [
  ['peaking', 230, 0.5, -6.5],
  ['lowshelf', 40, 0.7, 6],
];

const ENGINE_WORKLET = /* js */ `
class Engine extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 900, minValue: 0, maxValue: 15000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'pops', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor(options) {
    super();
    const o = options.processorOptions;
    // The bank each firing goes out of, in firing order.
    this.banks = o.banks;
    this.cyl = o.banks.length;
    this.blowdown = o.blowdownDeg / 360;
    this.popChance = o.popChance;
    this.alive = true;
    this.firings = 0;
    this.count = 0;
    this.rpm = 900;
    this.pulses = [];
    this.bangs = 0;
    this.seed = (Math.random() * 4294967295) >>> 0 || 1;
    // No two cylinders burn quite alike: that's the engine's character.
    this.trim = [];
    for (let i = 0; i < this.cyl; i++) this.trim.push(1 + (Math.random() - 0.5) * o.trimSpread);
    this.port.onmessage = (e) => {
      if (e.data === 'bang') this.bangs++;
      // Swapped out: let the node be collected.
      if (e.data === 'stop') this.alive = false;
    };
  }
  rand() {
    let x = this.seed;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.seed = x;
    return x / 4294967296;
  }
  fire(load, cut, pops) {
    const c = this.count++ % this.cyl;
    const bank = this.banks[c];
    const tau = Math.max(0.0009, (60 / Math.max(this.rpm, 300)) * this.blowdown / 3);
    // Bangs and pops go off in the exhaust, not the cylinder: their own output.
    if (this.bangs > 0) {
      this.bangs--;
      this.pulses.push({ t: 0, tau: Math.max(tau * 3, 0.002), amp: 1, noise: 1.6, pop: true });
    }
    if (cut) {
      // No fuel: only the pumping of the cylinders.
      this.pulses.push({ t: 0, tau, amp: 0.18, noise: 0.05, bank });
      return;
    }
    // Overrun: now and then an unburnt charge going off in the hot exhaust.
    if (load < 0.08 && pops > 0 && this.rand() < pops * this.popChance) {
      this.pulses.push({ t: 0, tau: Math.max(tau * 2.5, 0.0015), amp: 0.5 + this.rand() * 0.8, noise: 1.2, pop: true });
    }
    // Idle and light load burn unevenly; full load is steady.
    const lumpy = 0.05 + 0.3 * (1 - load) * Math.max(0, 1 - (this.rpm - 800) / 2500);
    const amp = (0.3 + 0.7 * load) * this.trim[c] * (1 + (this.rand() - 0.5) * 2 * lumpy);
    this.pulses.push({ t: 0, tau, amp, noise: 0.1 + 0.3 * load, bank });
  }
  process(inputs, outputs, params) {
    const exA = outputs[0][0];
    const exB = outputs[1][0];
    const intake = outputs[2][0];
    const popOut = outputs[3][0];
    const target = params.rpm[0];
    const load = params.load[0];
    const cut = params.cut[0] > 0.5;
    const pops = params.pops[0];
    const dt = 1 / sampleRate;
    for (let i = 0; i < exA.length; i++) {
      // Glide so the firing rate never steps.
      this.rpm += (target - this.rpm) * 0.002;
      this.firings += ((this.rpm / 60) * (this.cyl / 2)) / sampleRate;
      if (this.firings >= 1) {
        this.firings -= 1;
        this.fire(load, cut, pops);
      }
      let a = 0;
      let b = 0;
      let env = 0;
      let pop = 0;
      for (let k = this.pulses.length - 1; k >= 0; k--) {
        const p = this.pulses[k];
        const x = p.t / p.tau;
        const g = x * Math.exp(1 - x); // rises fast, peaks at t = tau, decays
        const v = p.amp * g + p.noise * g * (this.rand() - 0.5);
        if (p.pop) pop += v;
        else {
          if (p.bank) b += v;
          else a += v;
          env += p.amp * g;
        }
        p.t += dt;
        if (x > 8) this.pulses.splice(k, 1);
      }
      exA[i] = a;
      exB[i] = b;
      intake[i] = env * (this.rand() * 2 - 1);
      popOut[i] = pop;
    }
    return this.alive;
  }
}
registerProcessor('drift-engine', Engine);
`;

/** One car's engine voice: the worklet (or its fallback) and everything after it up to the bus. */
interface EngineRig {
  sound: CarSound;
  /** Everything the engine makes passes through here, so a swap can fade it out. */
  out: GainNode;
  node: AudioWorkletNode | null;
  fallback: OscillatorNode[];
  /** Per exhaust outlet: its input and its load-dependent muffle. */
  bankIn: GainNode[];
  exhaustLow: BiquadFilterNode[];
  exhaustGain: GainNode;
  intakeIn: GainNode;
  intakeFilter: BiquadFilterNode;
  intakeGain: GainNode;
  /** The exhaust's share fed to the intake (CarSound.intake.tone). */
  intakeTone: GainNode;
  popIn: GainNode;
  whistle: { osc: OscillatorNode; band: BiquadFilterNode; gain: GainNode; src: AudioBufferSourceNode } | null;
  /** The engine bay's voices (intake, turbo, blow-off) go through here. */
  bay: PannerNode;
  /** The tailpipes, the pops and the engine bay. */
  placed: Placed[];
  /** Swapped out: ignore a worklet that finishes loading after this. */
  dead: boolean;
}

interface Squeal {
  osc: OscillatorNode;
  bands: BiquadFilterNode[];
  gain: GainNode;
}

/** A voice's panner, its HRTF correction (HRTF_EQ) and where on the car it sits. */
interface Placed {
  panner: PannerNode;
  eq: BiquadFilterNode[];
  at: Vec3;
}

export class CarAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  /** Where every voice goes: the compressor ahead of the master gain. */
  private bus!: AudioNode;
  private noise!: AudioBuffer;
  /** Resolves true once the engine worklet is registered, false if it can't be. */
  private worklet: Promise<boolean> = Promise.resolve(false);
  // Engine
  private rig: EngineRig | null = null;
  // Transmission
  private whine!: OscillatorNode;
  private whineGain!: GainNode;
  private diff!: OscillatorNode;
  private diffGain!: GainNode;
  // Tires, road
  private rear!: Squeal;
  private front!: Squeal;
  private spinFilter!: BiquadFilterNode;
  private spinGain!: GainNode;
  private roadFilter!: BiquadFilterNode;
  private roadGain!: GainNode;
  // Wind: the rush on the left and right, and the buffeting
  private wind!: Array<{ band: BiquadFilterNode; gain: GainNode }>;
  private buffetGain!: GainNode;
  /** Each side's gusting, and the buffeting's: slow random wanders around 0 (about ±1). */
  private gust = [0, 0, 0];
  /** The buffeting's flutter: the same, but quick (several times a second). */
  private flutter = 0;
  /** The transmission and tire voices' places, which move with the car (see place()). */
  private spots!: Record<'gearbox' | 'diff' | 'front' | 'rear' | 'spin' | 'road', Placed>;
  /** 3D (HRTF) for headphones, else plain level panning for speakers. */
  headphones = false;
  // State between frames
  private gear = 1;
  /** Throttle lately (decays): a lift is measured against it, since the pedal is smoothed. */
  private recentThrottle = 0;
  /** Boost lately (decays), so a lift's blow-off is sized by the boost it vents, not what's left a frame later. */
  private recentBoost = 0;
  /** Boost built under throttle: the next lift blows off. */
  private blowOffArmed = false;
  private crackle = 0;
  private wander = 0;
  muted = false;
  /** Whose engine and drivetrain this sounds like. */
  car: CarId = DEFAULT_CAR;
  /** Its gearing, for the gear and diff whine: the tuned spec the car drives on, if it has one. */
  private drivetrain: DrivetrainSpec = CARS[DEFAULT_CAR].drivetrain;

  /**
   * Switches to another car's engine and drivetrain sound (before or after
   * start). `drivetrain` is the spec it drives on, when tuned away from stock;
   * the engine sound itself is the car's own either way.
   */
  setCar(id: CarId, drivetrain: DrivetrainSpec = CARS[id].drivetrain): void {
    this.drivetrain = drivetrain;
    if (id === this.car) return;
    this.car = id;
    this.gear = 1;
    this.recentThrottle = 0;
    this.recentBoost = 0;
    this.blowOffArmed = false;
    this.crackle = 0;
    const ctx = this.ctx;
    if (!ctx) return;
    this.place();
    const old = this.rig;
    if (old) {
      // A short fade, so the swap doesn't click.
      old.dead = true;
      old.out.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
      setTimeout(() => disposeRig(old), 200);
    }
    this.rig = this.buildEngine(ctx, SOUNDS[id]);
  }

  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.15;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : MASTER;
    comp.connect(this.master).connect(ctx.destination);
    const bus = comp;
    this.bus = bus;

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const filter = (type: BiquadFilterType, frequency: number, Q = 0.7, gain = 0) => filterNode(ctx, type, frequency, Q, gain);
    const gainNode = (v = 0) => gainOf(ctx, v);
    const lift = gainNode(CENTRE_LIFT);
    lift.connect(bus);
    const spot = () => this.placeVoice(ctx, [0, 0, 0], lift);
    const spots = (this.spots = { gearbox: spot(), diff: spot(), front: spot(), rear: spot(), spin: spot(), road: spot() });
    this.place();

    // Transmission
    this.whine = ctx.createOscillator();
    this.whineGain = gainNode(0);
    this.whine.connect(this.whineGain).connect(spots.gearbox.panner);
    this.whine.start();
    this.diff = ctx.createOscillator();
    this.diffGain = gainNode(0);
    this.diff.connect(this.diffGain).connect(spots.diff.panner);
    this.diff.start();

    // Tires: a squeal is a few narrow, wandering resonances, part tone, part noise.
    const squeal = (base: number, out: AudioNode): Squeal => {
      const gain = gainNode(0);
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = base;
      const oscGain = gainNode(0.12);
      osc.connect(oscGain).connect(gain);
      osc.start();
      const src = this.noiseSource(ctx);
      const bands = [filter('bandpass', base, 16), filter('bandpass', base * 1.62, 10), filter('bandpass', base * 2.4, 8)];
      const weights = [1, 0.55, 0.3];
      bands.forEach((b, i) => src.connect(b).connect(gainNode(weights[i] * 4)).connect(gain));
      gain.connect(out);
      return { osc, bands, gain };
    };
    this.rear = squeal(950, spots.rear.panner);
    this.front = squeal(720, spots.front.panner);
    this.spinFilter = filter('bandpass', 700, 1.6);
    this.spinGain = gainNode(0);
    this.noiseSource(ctx).connect(this.spinFilter).connect(this.spinGain).connect(spots.spin.panner);
    this.roadFilter = filter('lowpass', 200, 0.6);
    this.roadGain = gainNode(0);
    this.noiseSource(ctx).connect(this.roadFilter).connect(this.roadGain).connect(spots.road.panner);
    // Wind is all around, not on the car: a rush each side, from its own noise
    // so the two gust apart and sound wide, and a low buffeting in the middle.
    this.wind = [-0.6, 0.6].map((pan) => {
      const band = filter('bandpass', 600, 0.5);
      const gain = gainNode(0);
      this.noiseSource(ctx).connect(band).connect(gain).connect(new StereoPannerNode(ctx, { pan })).connect(bus);
      return { band, gain };
    });
    // Buffeting: up to 300 Hz, so small speakers that can't play the deep
    // part still carry some, with the boom around 110 Hz lifted.
    this.buffetGain = gainNode(0);
    this.noiseSource(ctx).connect(filter('lowpass', 300, 0.8)).connect(filter('peaking', 110, 1, 5)).connect(this.buffetGain).connect(bus);

    // The worklet engine; oscillators if worklets aren't available (they need a secure context).
    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([ENGINE_WORKLET], { type: 'application/javascript' }));
      this.worklet = ctx.audioWorklet
        .addModule(url)
        .then(() => true)
        .catch(() => false)
        .finally(() => URL.revokeObjectURL(url));
    }
    this.rig = this.buildEngine(ctx, SOUNDS[this.car]);
  }

  /** A looping noise voice; different offsets so the noise voices don't correlate. */
  private noiseSource(ctx: AudioContext): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start(0, Math.random() * 2);
    return src;
  }

  /**
   * A voice's place on the car, feeding `to`. Full level out to the listener's
   * distance from the car, so the mix stays as tuned; past that (the far end
   * of the car) it falls off gently.
   */
  private placeVoice(ctx: AudioContext, at: Vec3, to: AudioNode): Placed {
    const panner = new PannerNode(ctx, {
      distanceModel: 'inverse',
      refDistance: AUDIO.listenDistance,
      rolloffFactor: AUDIO.rolloff,
    });
    const eq = HRTF_EQ.map(([type, hz, q]) => filterNode(ctx, type, hz, q, 0));
    let node: AudioNode = panner;
    for (const f of eq) node = node.connect(f);
    node.connect(to);
    const p = { panner, eq, at };
    this.applyOutput(p);
    return p;
  }

  private applyOutput(p: Placed): void {
    p.panner.panningModel = this.headphones ? 'HRTF' : 'equalpower';
    for (const [i, f] of p.eq.entries()) f.gain.value = this.headphones ? HRTF_EQ[i][3] : 0;
  }

  /** Puts the transmission and tire voices where they are on this car. */
  private place(): void {
    const s = this.spots;
    if (!s) return;
    const spec = CARS[this.car];
    const z = spec.chassis.cornerZ;
    const driven = spec.drive === 'fwd' ? -z : z;
    s.gearbox.at = SOUNDS[this.car].gearbox;
    s.diff.at = [0, 0.35, driven];
    s.front.at = [0, 0.1, -z];
    s.rear.at = [0, 0.1, z];
    s.spin.at = [0, 0.1, driven];
    s.road.at = [0, 0.1, 0];
  }

  /** Headphones: 3D (HRTF). Speakers: plain level panning, since HRTF only colours the sound through speakers. */
  setHeadphones(on: boolean): void {
    this.headphones = on;
    for (const p of this.placed()) this.applyOutput(p);
  }

  private placed(): Placed[] {
    return [...(this.spots ? Object.values(this.spots) : []), ...(this.rig?.placed ?? [])];
  }

  /**
   * One car's engine. Each exhaust outlet: DC out, the pipe's resonance (a
   * delay loop: a boom at its fundamental, weaker overtones), the body EQ, a
   * muffle that opens with load, light saturation and its tailpipe. Then the
   * intake, the pops, and the turbo if it has one.
   */
  private buildEngine(ctx: AudioContext, sound: CarSound): EngineRig {
    const filter = (type: BiquadFilterType, frequency: number, Q = 0.7, gain = 0) => filterNode(ctx, type, frequency, Q, gain);
    const gainNode = (v = 0) => gainOf(ctx, v);
    const out = gainNode(1);
    out.connect(this.bus);
    const placed: Placed[] = [];
    const spot = (at: Vec3, to: AudioNode) => {
      const p = this.placeVoice(ctx, at, to);
      placed.push(p);
      return p.panner;
    };

    const exhaustGain = gainNode(0);
    exhaustGain.connect(out);
    const pipe = (delay: number) => {
      const sum = gainNode(1);
      const d = ctx.createDelay(0.05);
      d.delayTime.value = delay;
      sum.connect(d).connect(filter('lowpass', sound.pipeDamp, 0.5)).connect(gainNode(sound.pipeFeedback)).connect(sum);
      return sum;
    };
    const bankIn: GainNode[] = [];
    const exhaustLow: BiquadFilterNode[] = [];
    for (const [delay, at] of sound.pipes) {
      const input = gainNode(1);
      const low = filter('lowpass', 800, sound.muffle.q);
      const shaper = ctx.createWaveShaper();
      shaper.curve = saturation(sound.drive);
      shaper.oversample = '2x';
      let node: AudioNode = input.connect(filter('highpass', sound.highpass)).connect(pipe(delay));
      for (const [hz, q, db] of sound.eq) node = node.connect(filter('peaking', hz, q, db));
      node.connect(low).connect(shaper).connect(spot(at, exhaustGain));
      bankIn.push(input);
      exhaustLow.push(low);
    }

    // The voices that weren't panned before: see CENTRE_LIFT.
    const lift = gainNode(CENTRE_LIFT);
    lift.connect(out);
    const bay = spot(sound.engineBay, lift);
    const I = sound.intake;
    const intakeIn = gainNode(1);
    const intakeTone = gainNode(I.tone);
    intakeTone.connect(intakeIn);
    const intakeFilter = filter('bandpass', 700, I.q);
    const intakeGain = gainNode(0);
    intakeIn.connect(intakeFilter);
    if (I.drive > 0) {
      // Gruff, not a hiss: the growl saturates like the exhaust does.
      const shaper = ctx.createWaveShaper();
      shaper.curve = saturation(I.drive);
      intakeFilter.connect(shaper).connect(intakeGain);
    } else intakeFilter.connect(intakeGain);
    intakeGain.connect(bay);

    // Exhaust pops: sharp, bright, unmuffled. One voice for every tailpipe, so between them.
    const popIn = gainNode(sound.pops.gain);
    const popShaper = ctx.createWaveShaper();
    popShaper.curve = saturation(3);
    const mid = (k: 0 | 1 | 2) => sound.pipes.reduce((sum, [, at]) => sum + at[k], 0) / sound.pipes.length;
    popIn
      .connect(filter('highpass', sound.pops.highpass))
      .connect(filter('peaking', sound.pops.presence, 0.8, 5))
      .connect(popShaper)
      .connect(spot([mid(0), mid(1), mid(2)], lift));

    // Turbo whistle: a narrow band of noise around a faint tone, both following the shaft speed.
    let whistle: EngineRig['whistle'] = null;
    if (sound.turbo) {
      const gain = gainNode(0);
      const osc = ctx.createOscillator();
      osc.frequency.value = sound.turbo.whistle;
      osc.connect(gainNode(0.5)).connect(gain);
      osc.start();
      const band = filter('bandpass', sound.turbo.whistle, 30);
      const src = this.noiseSource(ctx);
      src.connect(band).connect(gainNode(6)).connect(gain);
      gain.connect(bay);
      whistle = { osc, band, gain, src };
    }

    const rig: EngineRig = {
      sound,
      out,
      node: null,
      fallback: [],
      bankIn,
      exhaustLow,
      exhaustGain,
      intakeIn,
      intakeFilter,
      intakeGain,
      intakeTone,
      popIn,
      whistle,
      bay,
      placed,
      dead: false,
    };
    const fallback = () => {
      if (rig.dead) return;
      for (const [type, mix] of [
        ['sawtooth', 0.5],
        ['square', 0.25],
      ] as const) {
        const osc = ctx.createOscillator();
        osc.type = type;
        const g = ctx.createGain();
        g.gain.value = mix;
        osc.connect(g);
        for (const input of bankIn) g.connect(input);
        osc.start();
        rig.fallback.push(osc);
      }
    };
    void this.worklet
      .then((ok) => {
        if (rig.dead) return;
        if (!ok) return fallback();
        const node = new AudioWorkletNode(ctx, 'drift-engine', {
          numberOfInputs: 0,
          numberOfOutputs: 4,
          outputChannelCount: [1, 1, 1, 1],
          processorOptions: { banks: sound.banks, blowdownDeg: sound.blowdownDeg, trimSpread: sound.trimSpread, popChance: sound.popChance },
        });
        for (const [i, input] of bankIn.entries()) node.connect(input, i);
        node.connect(intakeIn, 2);
        node.connect(intakeTone, 0);
        node.connect(popIn, 3);
        rig.node = node;
      })
      .catch(fallback);
    return rig;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : MASTER, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  /** Everything off (paused, or no car). */
  silence(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const gains = [this.whineGain, this.diffGain, this.rear.gain, this.front.gain, this.spinGain, this.roadGain, this.buffetGain, ...this.wind.map((w) => w.gain)];
    const rig = this.rig;
    if (rig) gains.push(rig.exhaustGain, rig.intakeGain, ...(rig.whistle ? [rig.whistle.gain] : []));
    for (const g of gains) g.gain.setTargetAtTime(0, t, 0.05);
    // The pops have their own output, past the exhaust gain: stop the worklet firing them.
    this.crackle = 0;
    rig?.node?.parameters.get('pops')!.setValueAtTime(0, t);
  }

  update(s: AudioState, dt: number): void {
    const ctx = this.ctx;
    const rig = this.rig;
    if (!ctx || !rig) return;
    const S = rig.sound;
    const D = this.drivetrain;
    const t = ctx.currentTime;
    const set = (p: AudioParam, v: number, tau: number) => p.setTargetAtTime(v, t, tau);
    const frac = s.rpm / s.redline;
    const cut = s.limiting || (s.shifting && s.throttle > 0.3);
    const load = cut ? 0 : s.throttle;

    // Shifts: a clunk, and a hard upshift near redline pops.
    if (s.gear !== this.gear) {
      if (s.gear > 0 && this.gear > 0) {
        this.clunk(0.5);
        if (s.gear > this.gear && s.throttle > 0.6 && frac > 0.75) rig.node?.port.postMessage('bang');
      } else this.clunk(0.8);
      this.gear = s.gear;
    }
    // Lifting off from high revs: a couple of seconds of crackle on the overrun.
    this.recentThrottle = Math.max(s.throttle, this.recentThrottle - dt * 1.5);
    if (this.recentThrottle > 0.5 && s.throttle < 0.1 && frac > 0.5) {
      this.crackle = S.pops.crackle;
      this.recentThrottle = 0;
    }
    this.crackle = Math.max(0, this.crackle - dt);
    const overrun = s.throttle < 0.05 && s.engaged ? smoothstep(S.pops.overrunFrom, S.pops.overrunTo, frac) : 0;
    const pops = Math.min(1, this.crackle * smoothstep(S.pops.from, S.pops.to, frac) + S.pops.overrun * overrun);

    // Engine
    if (rig.node) {
      const p = rig.node.parameters;
      p.get('rpm')!.setTargetAtTime(s.rpm, t, 0.02);
      p.get('load')!.setTargetAtTime(load, t, 0.03);
      p.get('cut')!.setValueAtTime(cut ? 1 : 0, t);
      p.get('pops')!.setValueAtTime(pops, t);
    }
    // The fallback's tones sit at the firing rate and half it.
    const fire = (s.rpm / 60) * (S.banks.length / 2);
    for (const [i, osc] of rig.fallback.entries()) set(osc.frequency, fire / (i + 1), 0.03);
    // Pulses carry more energy the faster they come: level it off a little with rpm.
    const level = (0.5 + 0.5 * load) * Math.pow(Math.max(frac, 0.1), -0.3) * S.level;
    set(rig.exhaustGain.gain, cut && !rig.node ? level * 0.3 : level, cut ? 0.01 : 0.05);
    // Muffled off-throttle and low down; it opens up with load and revs, but a
    // car exhaust stays dark (a bike's is open and bright).
    for (const low of rig.exhaustLow) set(low.frequency, S.muffle.base + S.muffle.load * load * (0.35 + 0.65 * frac) + S.muffle.rev * frac, 0.05);
    set(rig.intakeFilter.frequency, S.intake.base + S.intake.rev * frac, 0.05);
    set(rig.intakeGain.gain, S.intake.gain * load * Math.pow(Math.max(frac, 0), S.intake.power), 0.06);

    // Turbo: the whistle climbs with shaft speed (boost and airflow); a lift
    // with boost built vents it through the blow-off valve.
    this.recentBoost = Math.max(s.boost, this.recentBoost - dt * 2);
    if (S.turbo && rig.whistle) {
      const T = S.turbo;
      const spin = s.boost * (0.6 + 0.4 * Math.min(frac, 1));
      set(rig.whistle.osc.frequency, T.whistle + T.rise * spin, 0.08);
      set(rig.whistle.band.frequency, T.whistle + T.rise * spin, 0.08);
      set(rig.whistle.gain.gain, T.gain * s.boost * s.boost * (0.5 + 0.5 * Math.min(frac, 1)), 0.1);
      if (s.throttle > 0.5 && s.boost > 0.35) this.blowOffArmed = true;
      if (this.blowOffArmed && s.throttle < 0.2) {
        this.blowOffArmed = false;
        this.blowOff(T.blowOff * this.recentBoost);
      }
    }

    // Transmission: only while the clutch carries the drive.
    const teeth = S.gearTeeth[s.gear] ?? 20;
    set(this.whine.frequency, Math.min(12000, (s.rpm / 60) * teeth), 0.02);
    const strain = 0.25 + 0.75 * Math.max(load, overrun * 0.6);
    const whine = s.engaged && !s.airborne ? (s.gear < 0 ? 0.05 : 0.009) * strain * smoothstep(1, 8, s.speed) : 0;
    set(this.whineGain.gain, whine, 0.05);
    const shaftHz = (s.speed / (2 * Math.PI * D.wheelRadius)) * D.finalDrive;
    set(this.diff.frequency, Math.max(1, shaftHz * S.pinionTeeth), 0.03);
    set(this.diffGain.gain, s.engaged && !s.airborne ? S.diffGain * smoothstep(5, 30, s.speed) : 0, 0.08);

    // Tires sing with the speed they slide at (a standing burnout too), and
    // the pitch rises with it, wandering a little as the rubber stick-slips.
    const ground = s.airborne ? 0 : 1;
    this.wander += dt;
    const wobble = 1 + 0.035 * Math.sin(this.wander * 11) + 0.02 * Math.sin(this.wander * 27.3);
    this.voice(this.rear, smoothstep(0.4, 5, s.slideR) * ground * 0.7, (880 + 22 * Math.min(s.slideR, 12)) * wobble, t);
    this.voice(this.front, smoothstep(0.4, 5, s.slideF) * ground * 0.45, (680 + 18 * Math.min(s.slideF, 12)) * wobble, t);
    set(this.spinFilter.frequency, 500 + 40 * Math.min(s.wheelSpin, 20), 0.05);
    set(this.spinGain.gain, smoothstep(1, 8, s.wheelSpin) * ground * 0.12, 0.05);
    set(this.roadFilter.frequency, 140 + s.speed * 14, 0.1);
    set(this.roadGain.gain, Math.min(0.12, 0.005 + s.speed * 0.0022) * ground * smoothstep(0.5, 3, s.speed), 0.1);
    this.updateWind(s, dt, t);

    // Everything where it is on the car, turned as the car is to the view. The
    // listener stays put (facing −z) and the car sits in front of it.
    const cos = Math.cos(s.yaw);
    const sin = Math.sin(s.yaw);
    for (const { panner, at } of this.placed()) {
      const [x, y, z] = at;
      set(panner.positionX, x * cos + z * sin, 0.02);
      set(panner.positionY, y - AUDIO.listenHeight, 0.02);
      set(panner.positionZ, -x * sin + z * cos - AUDIO.listenDistance, 0.02);
    }
  }

  /**
   * Wind: louder with speed (about as speed², levelling off near top speed)
   * and higher-pitched, gusting each side on its own, faster the faster you
   * go. Sliding, the body meets the air at an angle: more rush, much more
   * buffeting, and the side the air comes from louder.
   *
   * The buffeting's noise has little energy (only what's under 300 Hz) and
   * ears are deaf down there, so its gain is several times the rush's to
   * sit just under it. It flutters quickly as well as gusting, so it reads
   * as buffeting rather than a steady hum.
   */
  private updateWind(s: AudioState, dt: number, t: number): void {
    const tau = 0.6 - 0.3 * smoothstep(20, 60, s.speed);
    const a = Math.exp(-dt / tau);
    // Uniform noise of unit variance, so each gust wanders about ±1.
    const b = Math.sqrt(1 - a * a) * Math.sqrt(3);
    for (let i = 0; i < this.gust.length; i++) this.gust[i] = this.gust[i] * a + (Math.random() * 2 - 1) * b;
    const sideways = Math.abs(Math.sin(s.yaw - s.travel));
    const cross = Math.sin(s.travel);
    const rush = 0.1 * Math.min(1.8, (s.speed / 45) ** 2) * (1 + 0.6 * sideways);
    for (const [i, w] of this.wind.entries()) {
      // Left first: air from the left (travel left of the view) is louder there.
      const side = 1 + 0.45 * cross * (i === 0 ? 1 : -1);
      w.gain.gain.setTargetAtTime(rush * side * Math.max(0.4, 1 + 0.25 * this.gust[i]), t, 0.08);
      w.band.frequency.setTargetAtTime((300 + 22 * s.speed) * (1 + 0.08 * this.gust[i]), t, 0.08);
    }
    const fa = Math.exp(-dt / 0.06);
    this.flutter = this.flutter * fa + (Math.random() * 2 - 1) * Math.sqrt(1 - fa * fa) * Math.sqrt(3);
    const shake = Math.max(0.25, 1 + 0.3 * this.gust[2] + 0.3 * this.flutter);
    const buffet = 0.42 * Math.min(1.6, (s.speed / 50) ** 2) * (1 + 1.2 * sideways) * shake;
    this.buffetGain.gain.setTargetAtTime(buffet, t, 0.03);
  }

  private voice(v: Squeal, gain: number, f: number, t: number): void {
    v.gain.gain.setTargetAtTime(gain, t, 0.05);
    v.osc.frequency.setTargetAtTime(f, t, 0.04);
    const ratios = [1, 1.62, 2.4];
    v.bands.forEach((b, i) => b.frequency.setTargetAtTime(f * ratios[i], t, 0.04));
  }

  /**
   * The blow-off valve venting boost on a lift: a breathy 'pssh' that falls
   * in pitch as the pressure goes, with a little compressor flutter in it.
   */
  private blowOff(strength: number): void {
    const ctx = this.ctx;
    const rig = this.rig;
    if (!ctx || !rig || strength < 0.02) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.1;
    band.frequency.setValueAtTime(3400, t);
    band.frequency.exponentialRampToValueAtTime(1100, t + 0.45);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(strength, t + 0.012);
    env.gain.setTargetAtTime(0, t + 0.06, 0.13);
    // Flutter: the gain chops at ~20 Hz, deepest at the start.
    const flutter = ctx.createGain();
    flutter.gain.value = 0.6;
    const lfo = ctx.createOscillator();
    lfo.frequency.setValueAtTime(24, t);
    lfo.frequency.linearRampToValueAtTime(15, t + 0.4);
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0.4, t);
    depth.gain.linearRampToValueAtTime(0, t + 0.35);
    lfo.connect(depth).connect(flutter.gain);
    src.connect(band).connect(env).connect(flutter).connect(rig.bay);
    src.start(t, Math.random());
    lfo.start(t);
    src.stop(t + 0.7);
    lfo.stop(t + 0.7);
  }

  /** A short mechanical knock: shifts, and (louder) into or out of reverse. */
  private clunk(strength: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 260;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35 * strength, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.1);
  }

  impact(strength: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(Math.min(0.9, strength / 15), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.4);
  }

  /** Landing: the suspension bottoming out, a low thud. */
  land(speed: number): void {
    const ctx = this.ctx;
    if (!ctx || speed < 1.5) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.7, speed / 8), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.3);
    this.impact(speed * 0.6);
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  /** Stops for good (the game is being replaced by a hot update). */
  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.rig = null;
  }
}

/** Stops and unhooks a swapped-out engine. */
function disposeRig(rig: EngineRig): void {
  if (rig.node) {
    rig.node.port.postMessage('stop');
    rig.node.disconnect();
  }
  for (const osc of rig.fallback) osc.stop();
  if (rig.whistle) {
    rig.whistle.osc.stop();
    rig.whistle.src.stop();
  }
  rig.out.disconnect();
}

function filterNode(ctx: BaseAudioContext, type: BiquadFilterType, frequency: number, Q: number, gain: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  f.gain.value = gain;
  return f;
}

function gainOf(ctx: BaseAudioContext, v: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

function smoothstep(a: number, b: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

/** tanh soft clipping, normalised so ±1 maps to ±1. */
function saturation(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / Math.tanh(drive);
  }
  return curve;
}
