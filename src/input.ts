import type { CarInput } from './car/physics';

export type InputDevice = 'keyboard' | 'gamepad' | 'touch';

export interface Actions {
  /** Reset tapped (R, Y, ⟲): fires on release, so a hold can mean something else… */
  reset: boolean;
  /** …held for RESET_HOLD: fires once, while still held. */
  roadReset: boolean;
  /** How long (s) reset has been held so far, 0 once it fires or is let go. */
  resetHold: number;
  pause: boolean;
  /** Step through the camera's pitch presets: +1 next, −1 previous, 0 none. */
  cameraCycle: number;
  /** Whether the step wraps past the last preset (the one-key C) or stops there (the D-pad's two directions). */
  cameraWrap: boolean;
  /** Toggle the free camera easing back behind the car once the stick is let go. */
  cameraRecenter: boolean;
  mute: boolean;
  /** The big map is shown while this is held. */
  map: boolean;
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
  /** Free camera from the right stick: orbit rate around the car (x) and tilt (y), −1…1. */
  look: { x: number; y: number };
  /** Free camera from a mouse drag on the view: movement this frame as fractions of its height, or null if not dragging. */
  drag: { x: number; y: number } | null;
  /** Menu navigation from a gamepad: a focus move (with auto-repeat), select and back. */
  nav: { x: number; y: number } | null;
  select: boolean;
  back: boolean;
}

const DRIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab']);
// Browser defaults for these (find bar, caret browsing…) get in the way of the debug keys.
const DEBUG_KEYS = new Set(['F3', 'F8', 'F9']);

/** Standard-mapping button indices (Xbox names; PlayStation: A = ✕, B = ○, X = □, Y = △). */
const PAD = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  view: 8,
  menu: 9,
  r3: 11,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const;
const STICK_DEADZONE = 0.12;
const TRIGGER_DEADZONE = 0.04;
/** Menu focus auto-repeat while a direction is held (s). */
const NAV_DELAY = 0.4;
const NAV_REPEAT = 0.12;
/** Held zoom keys/buttons: log-scale change per second (the full 0.6–2.5× range in about 1.6 s). */
const ZOOM_RATE = 0.9;
/** Holding reset this long (s) asks for the nearest road instead of a breadcrumb. */
export const RESET_HOLD = 0.5;

/** Rescales `v` so the deadzone reads 0 and full travel still reads 1. */
const deadzone = (v: number, dz: number) => (Math.abs(v) < dz ? 0 : (Math.sign(v) * (Math.abs(v) - dz)) / (1 - dz));

/** Merges keyboard, gamepad and touch into one CarInput per frame. */
export class InputManager {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<string>();
  private wheel = 0;
  private readonly mouseDrag = { id: null as number | null, x: 0, y: 0 };
  private readonly touch = { steer: 0, throttle: 0, brake: 0, handbrake: false, pause: false, reset: false };
  /** Reset held on any device: for how long (s), and whether this hold has already fired (or was held through a flush). */
  private readonly resetHold = { t: 0, spent: false };
  /** Last frame's buttons per pad index, for edge detection. */
  private readonly padPrev = new Map<number, boolean[]>();
  /** Buttons held through a flush (e.g. the A that pressed Resume), ignored until released. */
  private readonly padHeld = new Map<number, Set<number>>();
  private readonly navHold = { x: 0, y: 0, t: 0 };
  private lastPoll = performance.now();
  /** Shift requests from on-screen buttons (the gear selector). */
  readonly shiftQueue = { up: false, down: false, mode: false };
  enabled = true;
  /** The device used most recently, for on-screen prompts. */
  device: InputDevice = matchMedia('(pointer: coarse)').matches ? 'touch' : 'keyboard';
  /** A controller was connected (`supported` false if the browser gives it no standard mapping). */
  onPadConnected: ((name: string, supported: boolean) => void) | null = null;

  constructor(
    private readonly touchRoot: HTMLElement,
    private readonly view: HTMLElement,
  ) {
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      this.device = 'keyboard';
      // Leave Space/arrows/Tab alone in the menu so buttons, scrolling and focus still work.
      if (DRIVE_KEYS.has(e.code) && !inMenu()) e.preventDefault();
      if (DEBUG_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('visibilitychange', () => this.keys.clear());
    window.addEventListener('pointerdown', (e) => {
      this.device = e.pointerType === 'touch' ? 'touch' : 'keyboard';
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if ((e.target as HTMLElement)?.closest?.('.panel')) return;
        this.wheel += e.deltaY;
      },
      { passive: true },
    );
    window.addEventListener('gamepadconnected', (e) => {
      const pad = e.gamepad;
      // A new pad must not fire edges for buttons already held when it appears.
      this.padPrev.set(pad.index, pad.buttons.map((b) => b.pressed));
      this.onPadConnected?.(pad.id, pad.mapping === 'standard');
    });
    window.addEventListener('gamepaddisconnected', (e) => this.padPrev.delete(e.gamepad.index));
    this.setupTouch();
    this.setupDrag();
  }

  private setupDrag(): void {
    const view = this.view;
    const drag = this.mouseDrag;
    view.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      drag.id = e.pointerId;
      view.setPointerCapture(e.pointerId);
      view.style.cursor = 'grabbing';
    });
    view.addEventListener('pointermove', (e) => {
      if (e.pointerId !== drag.id) return;
      drag.x += e.movementX / view.clientHeight;
      drag.y += e.movementY / view.clientHeight;
    });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== drag.id) return;
      drag.id = null;
      view.style.cursor = '';
    };
    view.addEventListener('pointerup', release);
    view.addEventListener('pointercancel', release);
    view.addEventListener('lostpointercapture', release);
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

    const hold = (sel: string, set: (v: boolean) => void, cancel?: () => void) => {
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
      el.addEventListener('pointercancel', () => {
        cancel?.();
        up();
      });
    };
    hold('.touch-gas', (v) => (this.touch.throttle = v ? 1 : 0));
    hold('.touch-brake', (v) => (this.touch.brake = v ? 1 : 0));
    hold('.touch-drift', (v) => (this.touch.handbrake = v));
    // A press the browser cancels (it took the touch for a gesture) is neither a tap nor a hold.
    hold('.touch-reset', (v) => (this.touch.reset = v), () => (this.resetHold.spent = true));
    root.querySelector('.touch-menu')!.addEventListener('click', () => (this.touch.pause = true));
  }

  /**
   * Drops edge-triggered presses (e.g. the Esc that just closed the menu), and
   * ignores pad buttons held right now until they're released, so the A that
   * pressed Resume doesn't pull the handbrake.
   */
  flush(): void {
    this.pressed.clear();
    // A reset key held through the menu does nothing until it's let go.
    this.resetHold.spent = this.resetHold.t > 0 || this.keys.has('KeyR') || this.touch.reset;
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad) continue;
      const held = new Set<number>();
      pad.buttons.forEach((b, i) => b.pressed && held.add(i));
      this.padHeld.set(pad.index, held);
    }
  }

  /** The menu just opened: a direction already held (steering, shifting) mustn't move its focus until released. */
  latchNav(): void {
    this.navHold.t = Infinity;
  }

  /** Call once per frame. */
  poll(): { car: CarInput; actions: Actions } {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastPoll) / 1000);
    this.lastPoll = now;
    const k = (...codes: string[]) => codes.some((c) => this.keys.has(c));
    const p = (...codes: string[]) => codes.some((c) => this.pressed.has(c));

    let throttle = k('KeyW', 'ArrowUp') ? 1 : 0;
    let brake = k('KeyS', 'ArrowDown') ? 1 : 0;
    let steer = (k('KeyA', 'ArrowLeft') ? 1 : 0) - (k('KeyD', 'ArrowRight') ? 1 : 0);
    let handbrake = k('Space');
    let resetDown = k('KeyR') || this.touch.reset;
    const actions: Actions = {
      reset: false,
      roadReset: false,
      resetHold: 0,
      pause: p('Escape', 'KeyP'),
      cameraCycle: p('KeyC') ? 1 : 0,
      cameraWrap: true,
      cameraRecenter: false,
      mute: p('KeyM'),
      map: k('Tab'),
      debug: p('F3', 'Backquote'),
      mark: p('F8'),
      saveTrace: p('F9'),
      shiftUp: p('KeyE'),
      shiftDown: p('KeyQ'),
      gearMode: p('KeyT'),
      zoom: 1,
      look: { x: 0, y: 0 },
      drag: this.mouseDrag.id === null ? null : { x: this.mouseDrag.x, y: this.mouseDrag.y },
      nav: null,
      select: false,
      back: false,
    };
    if (k('Equal', 'NumpadAdd')) actions.zoom *= Math.exp(-ZOOM_RATE * dt);
    if (k('Minus', 'NumpadSubtract')) actions.zoom *= Math.exp(ZOOM_RATE * dt);
    if (this.wheel !== 0) {
      actions.zoom *= Math.exp(this.wheel * 0.001);
      this.wheel = 0;
    }
    this.mouseDrag.x = this.mouseDrag.y = 0;

    // Touch
    if (this.touch.pause) actions.pause = true;
    this.touch.pause = false;
    if (this.shiftQueue.up) actions.shiftUp = true;
    if (this.shiftQueue.down) actions.shiftDown = true;
    if (this.shiftQueue.mode) actions.gearMode = true;
    this.shiftQueue.up = this.shiftQueue.down = this.shiftQueue.mode = false;
    if (Math.abs(this.touch.steer) > Math.abs(steer)) steer = this.touch.steer;
    throttle = Math.max(throttle, this.touch.throttle);
    brake = Math.max(brake, this.touch.brake);
    handbrake ||= this.touch.handbrake;

    // Gamepads (standard mapping), merged: any connected pad can drive.
    let padBrakeMax = 0;
    let navX = 0;
    let navY = 0;
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad?.connected || pad.mapping !== 'standard') continue;
      const ignored = this.padHeld.get(pad.index);
      if (ignored) for (const i of ignored) if (!pad.buttons[i]?.pressed) ignored.delete(i);
      const held = pad.buttons.map((b, i) => b.pressed && !ignored?.has(i));
      const prev = this.padPrev.get(pad.index) ?? held.map(() => false);
      this.padPrev.set(pad.index, held);
      const edge = (i: number) => !!held[i] && !prev[i];
      const value = (i: number) => (ignored?.has(i) ? 0 : deadzone(pad.buttons[i]?.value ?? 0, TRIGGER_DEADZONE));

      const s = deadzone(pad.axes[0] ?? 0, STICK_DEADZONE);
      const padSteer = -Math.sign(s) * Math.abs(s) ** 1.5;
      const padThrottle = value(PAD.rt);
      const padBrake = value(PAD.lt);
      if (Math.abs(padSteer) > Math.abs(steer)) steer = padSteer;
      throttle = Math.max(throttle, padThrottle);
      brake = Math.max(brake, padBrake);
      padBrakeMax = Math.max(padBrakeMax, padBrake);
      handbrake ||= !!held[PAD.a];
      resetDown ||= !!held[PAD.y];
      if (edge(PAD.menu)) actions.pause = true;
      if (edge(PAD.rb)) actions.shiftUp = true;
      if (edge(PAD.lb)) actions.shiftDown = true;
      if (edge(PAD.view)) actions.gearMode = true;
      // D-pad: left/right step the camera angle, up/down zoom (in the menu it moves focus).
      if (edge(PAD.r3)) actions.cameraRecenter = true;
      if (edge(PAD.right) || edge(PAD.left)) {
        actions.cameraCycle = edge(PAD.right) ? 1 : -1;
        actions.cameraWrap = false;
      }
      if (held[PAD.up]) actions.zoom *= Math.exp(-ZOOM_RATE * dt);
      if (held[PAD.down]) actions.zoom *= Math.exp(ZOOM_RATE * dt);
      if (edge(PAD.a)) actions.select = true;
      if (edge(PAD.b)) actions.back = true;
      const lookX = deadzone(pad.axes[2] ?? 0, 0.15);
      const lookY = deadzone(pad.axes[3] ?? 0, 0.15);
      if (Math.abs(lookX) > Math.abs(actions.look.x)) actions.look.x = lookX;
      if (Math.abs(lookY) > Math.abs(actions.look.y)) actions.look.y = lookY;

      // Menu focus: D-pad or the left stick, whichever is pushed. Near a
      // diagonal the stick keeps the axis it's on, rather than flickering.
      const ly = pad.axes[1] ?? 0;
      const lx = pad.axes[0] ?? 0;
      let sx = 0;
      let sy = 0;
      if (Math.max(Math.abs(lx), Math.abs(ly)) > 0.6) {
        const onX = this.navHold.x !== 0 ? Math.abs(lx) * 1.3 > Math.abs(ly) : Math.abs(lx) > Math.abs(ly) * 1.3;
        const onY = this.navHold.y !== 0 ? Math.abs(ly) * 1.3 > Math.abs(lx) : Math.abs(ly) > Math.abs(lx) * 1.3;
        if (onX && !(onY && this.navHold.y !== 0)) sx = Math.sign(lx);
        else if (onY) sy = Math.sign(ly);
      }
      navX ||= held[PAD.left] ? -1 : held[PAD.right] ? 1 : sx;
      navY ||= held[PAD.up] ? -1 : held[PAD.down] ? 1 : sy;

      const active =
        held.some(Boolean) || padThrottle > 0 || padBrake > 0 || s !== 0 || lookX !== 0 || lookY !== 0 || Math.abs(ly) > STICK_DEADZONE;
      if (active) this.device = 'gamepad';
    }
    actions.nav = this.navRepeat(navX, navY, dt);
    this.resetPress(resetDown, dt, actions);

    this.pressed.clear();
    if (!this.enabled) return { car: { throttle: 0, brake: 0, steer: 0, handbrake: false }, actions };
    // A key or touch button is on/off; a trigger pressed as far is the driver's own easing.
    const brakeDigital = brake > padBrakeMax;
    return { car: { throttle, brake, steer, handbrake, brakeDigital }, actions };
  }

  /** Reset: a tap fires `reset` when let go; held for RESET_HOLD, `roadReset` fires once and the release is ignored. */
  private resetPress(down: boolean, dt: number, actions: Actions): void {
    const h = this.resetHold;
    if (!down) {
      if (h.t > 0 && !h.spent) actions.reset = true;
      h.t = 0;
      h.spent = false;
      return;
    }
    if (h.spent) return;
    h.t += dt;
    if (h.t >= RESET_HOLD) {
      actions.roadReset = true;
      h.spent = true;
    } else {
      actions.resetHold = h.t;
    }
  }

  /** A held direction moves once, then repeats after NAV_DELAY every NAV_REPEAT. */
  private navRepeat(x: number, y: number, dt: number): { x: number; y: number } | null {
    const h = this.navHold;
    if (!x && !y) {
      h.x = h.y = 0;
      return null;
    }
    if (x !== h.x || y !== h.y) {
      h.x = x;
      h.y = y;
      h.t = NAV_DELAY;
      return { x, y };
    }
    h.t -= dt;
    if (h.t > 0) return null;
    h.t += NAV_REPEAT;
    return { x, y };
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
