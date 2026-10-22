/** Tiny synthesized engine / tyre / impact audio. Starts on the first user gesture. */
export class CarAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineA!: OscillatorNode;
  private engineB!: OscillatorNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private squealGain!: GainNode;
  private squealFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  muted = false;

  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(ctx.destination);

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineA = ctx.createOscillator();
    this.engineA.type = 'sawtooth';
    this.engineB = ctx.createOscillator();
    this.engineB.type = 'square';
    const bGain = ctx.createGain();
    bGain.gain.value = 0.5;
    this.engineA.connect(this.engineFilter);
    this.engineB.connect(bGain).connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.master);
    this.engineA.start();
    this.engineB.start();

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const squeal = ctx.createBufferSource();
    squeal.buffer = this.noise;
    squeal.loop = true;
    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = 'bandpass';
    this.squealFilter.frequency.value = 1400;
    this.squealFilter.Q.value = 6;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    squeal.connect(this.squealFilter).connect(this.squealGain).connect(this.master);
    squeal.start();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  /** speed m/s, throttle 0..1, slide 0..1 */
  update(speed: number, throttle: number, slide: number, active: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    // Fake 5-speed gearbox: rpm sawtooths with speed.
    const gearSpan = 9.2;
    const gear = Math.min(4, Math.floor(speed / gearSpan));
    const inGear = Math.min(1, (speed - gear * gearSpan) / gearSpan);
    const rpm = speed < 0.5 ? 0.15 : 0.3 + 0.7 * inGear;
    const f = 38 + rpm * 120 + throttle * 8;
    this.engineA.frequency.setTargetAtTime(f, t, 0.05);
    this.engineB.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(500 + throttle * 1400 + rpm * 600, t, 0.08);
    this.engineGain.gain.setTargetAtTime(active ? 0.08 + throttle * 0.07 : 0, t, 0.1);
    this.squealGain.gain.setTargetAtTime(active ? Math.min(1, slide) * 0.16 : 0, t, 0.06);
    this.squealFilter.frequency.setTargetAtTime(1100 + slide * 700, t, 0.1);
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

  suspend(): void {
    void this.ctx?.suspend();
  }
}
