/**
 * Synthesized car audio. Starts on the first user gesture.
 *
 * - Engine: an inline six, fired cylinder by cylinder in an AudioWorklet. Each
 *   firing is a combustion pulse sized by throttle, with per-cylinder
 *   imbalance and cycle-to-cycle jitter (a lumpy idle, a smooth wail at high
 *   revs). The pulses run through exhaust resonances and soft saturation; an
 *   intake roar comes in under load. Overrun after a high-rpm lift crackles,
 *   the limiter's fuel cut stutters, and a hard upshift pops.
 * - Transmission: gear whine at the gear-mesh frequency (so it changes with
 *   each gear; reverse's straight-cut gears whine loudest), differential whine
 *   with road speed, and a clunk on every shift.
 * - Tyres: front and rear squeal voices pitched by how fast each axle slides,
 *   a rasp from wheelspin, rolling road noise and wind with speed.
 */

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
  /** Ground speed (m/s). */
  speed: number;
  /** How far the rear wheels' surface speed runs ahead of the road (m/s). */
  wheelSpin: number;
  /** Sliding speed at the front and rear contact patches (m/s). */
  slideF: number;
  slideR: number;
  airborne: boolean;
}

/** Gear-mesh teeth per input-shaft turn, by gear (reverse: straight-cut idler). */
const GEAR_TEETH: Record<number, number> = { [-1]: 37, 1: 14, 2: 18, 3: 22, 4: 25, 5: 28, 6: 31 };
/** Differential pinion teeth; driveshaft turns per wheel turn. */
const PINION_TEETH = 11;
const FINAL_DRIVE = 3.9;
const WHEEL_RADIUS = 0.33;
const MASTER = 0.5;

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
  constructor() {
    super();
    this.cyl = 6;
    this.firings = 0;
    this.count = 0;
    this.rpm = 900;
    this.pulses = [];
    this.bangs = 0;
    this.seed = (Math.random() * 4294967295) >>> 0 || 1;
    // No two cylinders burn quite alike: that's the engine's character.
    this.trim = [];
    for (let i = 0; i < this.cyl; i++) this.trim.push(1 + (Math.random() - 0.5) * 0.14);
    this.port.onmessage = (e) => {
      if (e.data === 'bang') this.bangs++;
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
    // Blowdown lasts about 70 degrees of crank: shorter in time as the revs rise.
    const tau = Math.max(0.0006, (60 / Math.max(this.rpm, 300)) * (70 / 360) / 3);
    // Bangs and pops go off in the exhaust, not the cylinder: their own output.
    if (this.bangs > 0) {
      this.bangs--;
      this.pulses.push({ t: 0, tau: Math.max(tau * 3, 0.002), amp: 1, noise: 1.6, pop: true });
    }
    if (cut) {
      // No fuel: only the pumping of the cylinders.
      this.pulses.push({ t: 0, tau, amp: 0.18, noise: 0.06 });
      return;
    }
    // Overrun: now and then an unburnt charge going off in the hot exhaust.
    if (load < 0.08 && pops > 0 && this.rand() < pops * 0.045) {
      this.pulses.push({ t: 0, tau: Math.max(tau * 2.5, 0.0015), amp: 0.5 + this.rand() * 0.8, noise: 1.2, pop: true });
    }
    // Idle and light load burn unevenly; full load is steady.
    const lumpy = 0.05 + 0.3 * (1 - load) * Math.max(0, 1 - (this.rpm - 800) / 2500);
    const amp = (0.3 + 0.7 * load) * this.trim[c] * (1 + (this.rand() - 0.5) * 2 * lumpy);
    this.pulses.push({ t: 0, tau, amp, noise: 0.15 + 0.45 * load });
  }
  process(inputs, outputs, params) {
    const ex = outputs[0][0];
    const intake = outputs[1][0];
    const popOut = outputs[2][0];
    const target = params.rpm[0];
    const load = params.load[0];
    const cut = params.cut[0] > 0.5;
    const pops = params.pops[0];
    const dt = 1 / sampleRate;
    for (let i = 0; i < ex.length; i++) {
      // Glide so the firing rate never steps.
      this.rpm += (target - this.rpm) * 0.002;
      this.firings += ((this.rpm / 60) * (this.cyl / 2)) / sampleRate;
      if (this.firings >= 1) {
        this.firings -= 1;
        this.fire(load, cut, pops);
      }
      let e = 0;
      let env = 0;
      let pop = 0;
      for (let k = this.pulses.length - 1; k >= 0; k--) {
        const p = this.pulses[k];
        const x = p.t / p.tau;
        const g = x * Math.exp(1 - x); // rises fast, peaks at t = tau, decays
        const v = p.amp * g + p.noise * g * (this.rand() - 0.5);
        if (p.pop) pop += v;
        else {
          e += v;
          env += p.amp * g;
        }
        p.t += dt;
        if (x > 8) this.pulses.splice(k, 1);
      }
      ex[i] = e;
      intake[i] = env * (this.rand() * 2 - 1);
      popOut[i] = pop;
    }
    return true;
  }
}
registerProcessor('drift-engine', Engine);
`;

interface Squeal {
  osc: OscillatorNode;
  bands: BiquadFilterNode[];
  gain: GainNode;
}

export class CarAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  // Engine
  private engine: AudioWorkletNode | null = null;
  private fallback: OscillatorNode[] = [];
  private exhaustIn!: GainNode;
  private exhaustLow!: BiquadFilterNode;
  private exhaustGain!: GainNode;
  private intakeFilter!: BiquadFilterNode;
  private intakeGain!: GainNode;
  private popIn!: GainNode;
  // Transmission
  private whine!: OscillatorNode;
  private whineGain!: GainNode;
  private diff!: OscillatorNode;
  private diffGain!: GainNode;
  // Tyres, road, wind
  private rear!: Squeal;
  private front!: Squeal;
  private spinFilter!: BiquadFilterNode;
  private spinGain!: GainNode;
  private roadFilter!: BiquadFilterNode;
  private roadGain!: GainNode;
  private windGain!: GainNode;
  // State between frames
  private gear = 1;
  /** Throttle lately (decays): a lift is measured against it, since the pedal is smoothed. */
  private recentThrottle = 0;
  private crackle = 0;
  private wander = 0;
  muted = false;

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

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = () => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      // Different offsets so the noise voices don't correlate.
      src.start(0, Math.random() * 2);
      return src;
    };
    const filter = (type: BiquadFilterType, frequency: number, Q = 0.7, gain = 0) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = frequency;
      f.Q.value = Q;
      f.gain.value = gain;
      return f;
    };
    const gainNode = (v = 0) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };

    // Exhaust: DC out, the pipe's resonances, a load-dependent muffle, then
    // soft saturation for the rasp.
    this.exhaustIn = gainNode(1);
    this.exhaustLow = filter('lowpass', 1500, 0.8);
    const shaper = ctx.createWaveShaper();
    shaper.curve = saturation(2.2);
    shaper.oversample = '2x';
    this.exhaustGain = gainNode(0);
    this.exhaustIn
      .connect(filter('highpass', 28))
      .connect(filter('peaking', 140, 1, 6))
      .connect(filter('peaking', 430, 1.4, 4))
      .connect(this.exhaustLow)
      .connect(shaper)
      .connect(this.exhaustGain)
      .connect(bus);
    this.intakeFilter = filter('bandpass', 1500, 1.1);
    this.intakeGain = gainNode(0);
    this.intakeFilter.connect(this.intakeGain).connect(bus);
    // Exhaust pops: sharp, bright, unmuffled.
    this.popIn = gainNode(0.55);
    const popShaper = ctx.createWaveShaper();
    popShaper.curve = saturation(3);
    this.popIn.connect(filter('highpass', 180)).connect(filter('peaking', 1800, 0.8, 5)).connect(popShaper).connect(bus);

    // Transmission
    this.whine = ctx.createOscillator();
    this.whineGain = gainNode(0);
    this.whine.connect(this.whineGain).connect(bus);
    this.whine.start();
    this.diff = ctx.createOscillator();
    this.diffGain = gainNode(0);
    this.diff.connect(this.diffGain).connect(bus);
    this.diff.start();

    // Tyres: a squeal is a few narrow, wandering resonances, part tone, part noise.
    const squeal = (base: number): Squeal => {
      const gain = gainNode(0);
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = base;
      const oscGain = gainNode(0.12);
      osc.connect(oscGain).connect(gain);
      osc.start();
      const src = noise();
      const bands = [filter('bandpass', base, 16), filter('bandpass', base * 1.62, 10), filter('bandpass', base * 2.4, 8)];
      const weights = [1, 0.55, 0.3];
      bands.forEach((b, i) => src.connect(b).connect(gainNode(weights[i] * 4)).connect(gain));
      gain.connect(bus);
      return { osc, bands, gain };
    };
    this.rear = squeal(950);
    this.front = squeal(720);
    this.spinFilter = filter('bandpass', 700, 1.6);
    this.spinGain = gainNode(0);
    noise().connect(this.spinFilter).connect(this.spinGain).connect(bus);
    this.roadFilter = filter('lowpass', 200, 0.6);
    this.roadGain = gainNode(0);
    noise().connect(this.roadFilter).connect(this.roadGain).connect(bus);
    this.windGain = gainNode(0);
    noise().connect(filter('highpass', 500)).connect(filter('lowpass', 2800)).connect(this.windGain).connect(bus);

    this.startEngine(ctx);
  }

  /** The worklet engine; oscillators if worklets aren't available (they need a secure context). */
  private startEngine(ctx: AudioContext): void {
    const fallback = () => {
      for (const [type, mix] of [
        ['sawtooth', 0.5],
        ['square', 0.25],
      ] as const) {
        const osc = ctx.createOscillator();
        osc.type = type;
        const g = ctx.createGain();
        g.gain.value = mix;
        osc.connect(g).connect(this.exhaustIn);
        osc.start();
        this.fallback.push(osc);
      }
    };
    if (!ctx.audioWorklet) {
      fallback();
      return;
    }
    const url = URL.createObjectURL(new Blob([ENGINE_WORKLET], { type: 'application/javascript' }));
    ctx.audioWorklet
      .addModule(url)
      .then(() => {
        const node = new AudioWorkletNode(ctx, 'drift-engine', { numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [1, 1, 1] });
        node.connect(this.exhaustIn, 0);
        node.connect(this.intakeFilter, 1);
        node.connect(this.popIn, 2);
        this.engine = node;
      })
      .catch(fallback)
      .finally(() => URL.revokeObjectURL(url));
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
    for (const g of [this.exhaustGain, this.intakeGain, this.whineGain, this.diffGain, this.rear.gain, this.front.gain, this.spinGain, this.roadGain, this.windGain])
      g.gain.setTargetAtTime(0, t, 0.05);
  }

  update(s: AudioState, dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const set = (p: AudioParam, v: number, tau: number) => p.setTargetAtTime(v, t, tau);
    const frac = s.rpm / s.redline;
    const cut = s.limiting || (s.shifting && s.throttle > 0.3);
    const load = cut ? 0 : s.throttle;

    // Shifts: a clunk, and a hard upshift near redline pops.
    if (s.gear !== this.gear) {
      if (s.gear > 0 && this.gear > 0) {
        this.clunk(0.5);
        if (s.gear > this.gear && s.throttle > 0.6 && frac > 0.75) this.engine?.port.postMessage('bang');
      } else this.clunk(0.8);
      this.gear = s.gear;
    }
    // Lifting off from high revs: a couple of seconds of crackle on the overrun.
    this.recentThrottle = Math.max(s.throttle, this.recentThrottle - dt * 1.5);
    if (this.recentThrottle > 0.5 && s.throttle < 0.1 && frac > 0.5) {
      this.crackle = 1.6;
      this.recentThrottle = 0;
    }
    this.crackle = Math.max(0, this.crackle - dt);
    const overrun = s.throttle < 0.05 && s.engaged ? smoothstep(0.45, 0.8, frac) : 0;
    const pops = Math.min(1, this.crackle * smoothstep(0.35, 0.7, frac) + overrun * 0.25);

    // Engine
    if (this.engine) {
      const p = this.engine.parameters;
      p.get('rpm')!.setTargetAtTime(s.rpm, t, 0.02);
      p.get('load')!.setTargetAtTime(load, t, 0.03);
      p.get('cut')!.setValueAtTime(cut ? 1 : 0, t);
      p.get('pops')!.setValueAtTime(pops, t);
    }
    for (const [i, osc] of this.fallback.entries()) set(osc.frequency, ((s.rpm / 60) * 3) / (i + 1), 0.03);
    // Pulses carry more energy the faster they come: level it off a little with rpm.
    const level = (0.5 + 0.5 * load) * Math.pow(Math.max(frac, 0.1), -0.3) * 0.32;
    set(this.exhaustGain.gain, cut && !this.engine ? level * 0.3 : level, cut ? 0.01 : 0.05);
    set(this.exhaustLow.frequency, 700 + 3800 * load * (0.4 + 0.6 * frac) + 900 * frac, 0.05);
    set(this.intakeFilter.frequency, 900 + 1800 * frac, 0.05);
    set(this.intakeGain.gain, 0.5 * load * frac * frac, 0.06);

    // Transmission: only while the clutch carries the drive.
    const teeth = GEAR_TEETH[s.gear] ?? 20;
    set(this.whine.frequency, Math.min(12000, (s.rpm / 60) * teeth), 0.02);
    const strain = 0.25 + 0.75 * Math.max(load, overrun * 0.6);
    const whine = s.engaged && !s.airborne ? (s.gear < 0 ? 0.05 : 0.009) * strain * smoothstep(1, 8, s.speed) : 0;
    set(this.whineGain.gain, whine, 0.05);
    const shaftHz = (s.speed / (2 * Math.PI * WHEEL_RADIUS)) * FINAL_DRIVE;
    set(this.diff.frequency, Math.max(1, shaftHz * PINION_TEETH), 0.03);
    set(this.diffGain.gain, s.engaged && !s.airborne ? 0.006 * smoothstep(5, 30, s.speed) : 0, 0.08);

    // Tyres sing with the speed they slide at (a standing burnout too), and
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
    set(this.windGain.gain, 0.09 * Math.min(1.5, (s.speed / 50) ** 2), 0.2);
  }

  private voice(v: Squeal, gain: number, f: number, t: number): void {
    v.gain.gain.setTargetAtTime(gain, t, 0.05);
    v.osc.frequency.setTargetAtTime(f, t, 0.04);
    const ratios = [1, 1.62, 2.4];
    v.bands.forEach((b, i) => b.frequency.setTargetAtTime(f * ratios[i], t, 0.04));
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
