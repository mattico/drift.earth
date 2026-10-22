import type { CarInput } from './car/physics';

export interface Actions {
  reset: boolean;
  pause: boolean;
  cameraCycle: boolean;
  mute: boolean;
  debug: boolean;
  /** Drop a marker into the debug trace. */
  mark: boolean;
  saveTrace: boolean;
  /** Gear changes (either switches the gearbox to manual) and auto/manual toggle. */
  shiftUp: boolean;
  shiftDown: boolean;
  gearMode: boolean;
  /** Multiplicative zoom change requested this frame (1 = none). */
  zoom: number;
}

const DRIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
// Browser defaults for these (find bar, caret browsing…) get in the way of the debug keys.
const DEBUG_KEYS = new Set(['F3', 'F8', 'F9']);

/** Merges keyboard, gamepad and touch into one CarInput per frame. */
export class InputManager {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<string>();
  private wheel = 0;
  private readonly touch = { steer: 0, throttle: 0, brake: 0, handbrake: false, pause: false, reset: false };
  private readonly padPrev: boolean[] = [];
  /** Shift requests from on-screen buttons (the gear selector). */
  readonly shiftQueue = { up: false, down: false, mode: false };
  enabled = true;

  constructor(private readonly touchRoot: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      // Leave Space/arrows alone in the menu so buttons and scrolling still work.
      if (DRIVE_KEYS.has(e.code) && !inMenu()) e.preventDefault();
      if (DEBUG_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('visibilitychange', () => this.keys.clear());
    window.addEventListener(
      'wheel',
      (e) => {
        if ((e.target as HTMLElement)?.closest?.('.panel')) return;
        this.wheel += e.deltaY;
      },
      { passive: true },
    );
    this.setupTouch();
  }

  private setupTouch(): void {
    const root = this.touchRoot;
    const stick = root.querySelector<HTMLElement>('.touch-stick')!;
    const knob = root.querySelector<HTMLElement>('.touch-knob')!;
    let stickId: number | null = null;
    let originX = 0;
    stick.addEventListener('pointerdown', (e) => {
      stickId = e.pointerId;
      originX = e.clientX;
      stick.setPointerCapture(e.pointerId);
    });
    stick.addEventListener('pointermove', (e) => {
      if (e.pointerId !== stickId) return;
      const dx = Math.max(-70, Math.min(70, e.clientX - originX));
      this.touch.steer = -dx / 70;
      knob.style.transform = `translateX(${dx}px)`;
    });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      this.touch.steer = 0;
      knob.style.transform = '';
    };
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);

    const hold = (sel: string, set: (v: boolean) => void) => {
      const el = root.querySelector<HTMLElement>(sel)!;
      el.addEventListener('pointerdown', (e) => {
        el.setPointerCapture(e.pointerId);
        el.classList.add('down');
        set(true);
      });
      const up = () => {
        el.classList.remove('down');
        set(false);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    hold('.touch-gas', (v) => (this.touch.throttle = v ? 1 : 0));
    hold('.touch-brake', (v) => (this.touch.brake = v ? 1 : 0));
    hold('.touch-drift', (v) => (this.touch.handbrake = v));
    root.querySelector('.touch-menu')!.addEventListener('click', () => (this.touch.pause = true));
    root.querySelector('.touch-reset')!.addEventListener('click', () => (this.touch.reset = true));
  }

  /** Drops edge-triggered presses (e.g. the Esc that just closed the menu). */
  flush(): void {
    this.pressed.clear();
  }

  /** Call once per frame. */
  poll(): { car: CarInput; actions: Actions } {
    const k = (...codes: string[]) => codes.some((c) => this.keys.has(c));
    const p = (...codes: string[]) => codes.some((c) => this.pressed.has(c));

    let throttle = k('KeyW', 'ArrowUp') ? 1 : 0;
    let brake = k('KeyS', 'ArrowDown') ? 1 : 0;
    let steer = (k('KeyA', 'ArrowLeft') ? 1 : 0) - (k('KeyD', 'ArrowRight') ? 1 : 0);
    let handbrake = k('Space');
    const actions: Actions = {
      reset: p('KeyR'),
      pause: p('Escape', 'KeyP'),
      cameraCycle: p('KeyC'),
      mute: p('KeyM'),
      debug: p('F3', 'Backquote'),
      mark: p('F8'),
      saveTrace: p('F9'),
      shiftUp: p('KeyE'),
      shiftDown: p('KeyQ'),
      gearMode: p('KeyT'),
      zoom: 1,
    };
    if (k('Equal', 'NumpadAdd')) actions.zoom *= 0.98;
    if (k('Minus', 'NumpadSubtract')) actions.zoom *= 1.02;
    if (this.wheel !== 0) {
      actions.zoom *= Math.exp(this.wheel * 0.001);
      this.wheel = 0;
    }

    // Touch
    if (this.touch.pause) actions.pause = true;
    if (this.touch.reset) actions.reset = true;
    this.touch.pause = this.touch.reset = false;
    if (this.shiftQueue.up) actions.shiftUp = true;
    if (this.shiftQueue.down) actions.shiftDown = true;
    if (this.shiftQueue.mode) actions.gearMode = true;
    this.shiftQueue.up = this.shiftQueue.down = this.shiftQueue.mode = false;
    if (Math.abs(this.touch.steer) > Math.abs(steer)) steer = this.touch.steer;
    throttle = Math.max(throttle, this.touch.throttle);
    brake = Math.max(brake, this.touch.brake);
    handbrake ||= this.touch.handbrake;

    // Gamepad (standard mapping)
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad || pad.mapping !== 'standard') continue;
      const ax = pad.axes[0] ?? 0;
      const dz = 0.12;
      const s = Math.abs(ax) < dz ? 0 : (Math.sign(ax) * (Math.abs(ax) - dz)) / (1 - dz);
      const padSteer = -Math.sign(s) * Math.abs(s) ** 1.5;
      if (Math.abs(padSteer) > Math.abs(steer)) steer = padSteer;
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0);
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0);
      handbrake ||= !!(pad.buttons[0]?.pressed || pad.buttons[5]?.pressed);
      const edge = (i: number) => {
        const now = !!pad.buttons[i]?.pressed;
        const was = this.padPrev[i] ?? false;
        this.padPrev[i] = now;
        return now && !was;
      };
      if (edge(3)) actions.reset = true;
      if (edge(9)) actions.pause = true;
      if (edge(4)) actions.cameraCycle = true;
      if (edge(1)) actions.shiftUp = true;
      if (edge(2)) actions.shiftDown = true;
      const zoomAxis = pad.axes[3] ?? 0;
      if (Math.abs(zoomAxis) > 0.2) actions.zoom *= 1 + zoomAxis * 0.02;
      break;
    }

    this.pressed.clear();
    if (!this.enabled) return { car: { throttle: 0, brake: 0, steer: 0, handbrake: false }, actions };
    return { car: { throttle, brake, steer, handbrake }, actions };
  }

  rumble(strength: number): void {
    for (const pad of navigator.getGamepads?.() ?? []) {
      const act = (pad as Gamepad & { vibrationActuator?: GamepadHapticActuator })?.vibrationActuator;
      act?.playEffect?.('dual-rumble', { duration: 140, strongMagnitude: Math.min(1, strength), weakMagnitude: 0.3 }).catch(() => {});
    }
  }
}

function inMenu(): boolean {
  const menu = document.getElementById('menu');
  return !!menu && !menu.hidden;
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
}
