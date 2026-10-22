import {
  AlwaysDepth,
  BufferGeometry,
  DepthTexture,
  Float32BufferAttribute,
  MathUtils,
  Matrix4,
  Mesh,
  NormalBlending,
  OrthographicCamera,
  SRGBColorSpace,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type Light,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { SPEED_FX as F } from './config';

/** What the effects need to know each frame. */
export interface SpeedFxState {
  /** Ground speed (m/s), 0 when not driving (the effects fade out); and the car's top speed. */
  speed: number;
  topSpeed: number;
  /** The car's velocity: the speed lines rush out from where it's heading. */
  vel: Vector3;
  /** Frame time (s), and game time (slowed or frozen with the physics) for the speed lines. */
  dt: number;
  gameDt: number;
}

const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Camera motion blur. Each pixel's world point (from depth) is projected with
 * last frame's camera to find how far it moved on screen, and the colour is
 * averaged along that path, scaled to the shutter time. The world doesn't
 * move, so this is the camera's motion (and the car's, which it follows).
 * Lighter in the middle and ahead of it, toward where the car is heading,
 * where you're looking. Writes the world's depth too, so the car drawn after
 * it is hidden as before.
 */
const blurFragment = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 uReproject;
uniform float uScale;
uniform float uMaxBlur;
uniform float uAspect;
uniform float uHeight;
uniform vec2 uForward;
uniform vec4 uClear;
varying vec2 vUv;

// Interleaved gradient noise: jitters the taps so the smear doesn't band.
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
  float depth = texture2D(tDepth, vUv).r;
  vec4 prev = uReproject * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec2 v = prev.w > 0.0 ? (vUv - (prev.xy / prev.w * 0.5 + 0.5)) * uScale : vec2(0.0);
  // In screen heights from a point a little ahead of the middle; the clear
  // patch reaches twice as far ahead as it does to the sides and behind.
  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0) - uForward * uClear.w;
  float ahead = dot(q, uForward);
  float off = length(vec2(ahead * (ahead > 0.0 ? 0.5 : 1.0), dot(q, vec2(-uForward.y, uForward.x))));
  v *= mix(uClear.x, 1.0, smoothstep(uClear.y, uClear.z, off));
  // In screen heights, whichever way it points.
  float len = length(v * vec2(uAspect, 1.0));
  if (len > uMaxBlur) v *= uMaxBlur / len;
  vec3 c;
  if (len * uHeight < 0.5) {
    c = texture2D(tColor, vUv).rgb;
  } else {
    const int TAPS = 12;
    float j = ign(gl_FragCoord.xy);
    c = vec3(0.0);
    for (int i = 0; i < TAPS; i++) c += texture2D(tColor, vUv + v * ((float(i) + j) / float(TAPS) - 0.5)).rgb;
    c /= float(TAPS);
  }
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragDepth = depth;
}
`;

/**
 * Over everything: the vignette darkens toward the corners; speed lines are
 * thin dashes rushing out along rays from the vanishing point of the car's
 * travel (above the top of the screen at the default tilt), only near the
 * edges, so the car and the road ahead stay clear. Premultiplied: the lines
 * add light, the vignette takes it away.
 */
const overlayFragment = /* glsl */ `
uniform float uVignette;
uniform float uLines;
uniform float uLineAlpha;
uniform vec2 uRes;
uniform vec2 uFoe;
uniform vec2 uAxis;
uniform float uSlot;
uniform float uTime;
varying vec2 vUv;

float hash(float n) {
  return fract(sin(n * 127.1 + 311.7) * 43758.5453);
}

void main() {
  // 0 in the middle, 0.71 at the middle of each edge, 1 in the corners.
  float d = length(vUv * 2.0 - 1.0) * 0.7071;
  float vig = uVignette * smoothstep(0.3, 1.0, d);
  float line = 0.0;
  if (uLines > 0.001) {
    vec2 p = gl_FragCoord.xy - uFoe;
    float r = length(p);
    // Angle from the ray through the middle of the screen, so the seam is off-screen.
    float a = atan(dot(p, vec2(-uAxis.y, uAxis.x)), dot(p, uAxis));
    float cell = floor(a / uSlot);
    float h1 = hash(cell);
    float h2 = hash(cell + 17.3);
    float h3 = hash(cell + 41.7);
    // One line per slot, somewhere across it, 1–2.5 px wide at 1080 lines.
    float off = (fract(a / uSlot) - (0.2 + 0.6 * h1)) * uSlot * r;
    float w = (1.0 + 1.5 * h2) * uRes.y / 1080.0;
    float across = 1.0 - smoothstep(0.0, w, abs(off));
    // Dashes rushing outward, each line at its own pace: a fading tail, a crisp head.
    float x = fract((r / uRes.y) * (0.6 + 0.5 * h3) - uTime * (0.8 + 0.4 * h2) + h1 * 7.0);
    float dash = smoothstep(0.0, 0.2, x) * (1.0 - smoothstep(0.28, 0.31, x));
    // More of the slots light up the faster you go, up to about three in four.
    float on = smoothstep(h3, h3 + 0.2, uLines * 0.85);
    // Along the sides and in the corners, clear of the middle, the top and the bottom.
    float edge = smoothstep(0.6, 1.0, length((vUv * 2.0 - 1.0) * vec2(1.0, 0.6)));
    line = across * dash * on * edge * uLines * uLineAlpha;
  }
  gl_FragColor = vec4(vec3(line), 1.0 - (1.0 - vig) * (1.0 - line));
}
`;

const _vp = new Matrix4();
const _inv = new Matrix4();
const _dir = new Vector4();
const _size = new Vector2();

/**
 * Speed effects: camera motion blur on the world, then a vignette and speed
 * lines over the whole view, all growing with speed (config SPEED_FX).
 *
 * With blur, the world (everything but `sharp`) draws into a multisampled
 * target with a depth texture. The blur pass puts it on the canvas with its
 * depth, and `sharp` (the car and its ghost, smoke, skid marks, debug layers)
 * draws over that unblurred, depth-tested against the world as before.
 * Without blur it's one plain render, as before.
 */
export class SpeedFx {
  /** Off: one plain render, no effects (the menu's switch). */
  enabled = true;
  /** Each effect's strength now: the vignette's darkness, and the lines' and blur's ramps (0–1). */
  private vignette = 0;
  private lines = 0;
  private blur = 0;
  private time = 0;
  /** The vanishing point of the car's travel (px from the middle of the screen), and +1, or −1 when it's behind the camera. */
  private readonly foe = new Vector2();
  private foeSign = 1;
  private readonly target: WebGLRenderTarget;
  private readonly prevVP = new Matrix4();
  private hasPrev = false;
  private readonly quad: Mesh;
  private readonly quadCam = new OrthographicCamera();
  private readonly blurMat: ShaderMaterial;
  private readonly overlayMat: ShaderMaterial;

  constructor(private readonly renderer: WebGLRenderer) {
    // sRGB storage: 8 bits a channel without banding in the shadows, and renderable everywhere.
    this.target = new WebGLRenderTarget(1, 1, { samples: 4, colorSpace: SRGBColorSpace, depthTexture: new DepthTexture(1, 1) });
    const g = new BufferGeometry();
    // One triangle over the whole screen.
    g.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.blurMat = new ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: blurFragment,
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        uReproject: { value: new Matrix4() },
        uScale: { value: 0 },
        uMaxBlur: { value: F.blur.maxBlur },
        uAspect: { value: 1 },
        uHeight: { value: 1 },
        uForward: { value: new Vector2(0, 1) },
        // What's left in the middle, where it starts and stops growing, and how far ahead the middle is.
        uClear: { value: new Vector4(F.blur.clear, F.blur.clearFrom, F.blur.clearTo, F.blur.clearAhead) },
      },
      // Depth is written whatever is there: the canvas isn't cleared under it.
      depthFunc: AlwaysDepth,
    });
    this.overlayMat = new ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: overlayFragment,
      uniforms: {
        uVignette: { value: 0 },
        uLines: { value: 0 },
        uLineAlpha: { value: F.lines.max },
        uRes: { value: new Vector2() },
        uFoe: { value: new Vector2() },
        uAxis: { value: new Vector2(0, -1) },
        uSlot: { value: 0.02 },
        uTime: { value: 0 },
      },
      transparent: true,
      blending: NormalBlending,
      premultipliedAlpha: true,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new Mesh(g, this.blurMat);
    this.quad.frustumCulled = false;
  }

  /** The camera jumped (spawn, reset): nothing to smear from the last frame. */
  reset(): void {
    this.hasPrev = false;
  }

  /** The world was re-centred by `m`: last frame's camera moves with it. */
  rebase(m: Matrix4): void {
    this.prevVP.multiply(_inv.copy(m).invert());
  }

  render(scene: Scene, camera: PerspectiveCamera, sharp: Object3D[], s: SpeedFxState): void {
    const r = this.renderer;
    const f = this.enabled ? s.speed / Math.max(s.topSpeed, 1) : 0;
    const k = 1 - Math.exp(-s.dt / F.tau);
    this.vignette += (F.vignette.max * MathUtils.smoothstep(f, F.vignette.from, F.vignette.to) - this.vignette) * k;
    this.lines += (MathUtils.smoothstep(f, F.lines.from, F.lines.to) - this.lines) * k;
    this.blur += (MathUtils.smoothstep(f, F.blur.from, F.blur.to) - this.blur) * k;

    _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const blurring = this.hasPrev && this.blur > 0.01 && s.dt > 0;
    r.getDrawingBufferSize(_size);
    if (blurring || this.lines > 0.002) this.vanish(camera, s.vel);
    r.info.autoReset = false;
    r.info.reset();
    if (blurring) this.renderBlurred(scene, camera, sharp, s.dt);
    else r.render(scene, camera);
    this.prevVP.copy(_vp);
    this.hasPrev = true;

    if (this.vignette > 0.002 || this.lines > 0.002) this.renderOverlay(s);
    r.info.autoReset = true;
  }

  /**
   * The vanishing point of the car's travel: its direction, projected as a
   * point at infinity. Behind the camera (reversing toward it), the opposite
   * point, with foeSign −1. No further than a dozen screen heights: looking
   * straight down, it's at infinity.
   */
  private vanish(camera: PerspectiveCamera, vel: Vector3): void {
    const speed = Math.hypot(vel.x, vel.z);
    _dir.set(speed > 0.5 ? vel.x / speed : 0, 0, speed > 0.5 ? vel.z / speed : -1, 0);
    _dir.applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
    this.foeSign = _dir.w < 0 ? -1 : 1;
    const w = Math.max(Math.abs(_dir.w), 1e-4) * this.foeSign;
    this.foe.set(((_dir.x / w) * _size.x) / 2, ((_dir.y / w) * _size.y) / 2);
    const cap = 12 * _size.y;
    if (this.foe.length() > cap) this.foe.setLength(cap);
  }

  private renderBlurred(scene: Scene, camera: PerspectiveCamera, sharp: Object3D[], dt: number): void {
    const r = this.renderer;
    if (this.target.width !== _size.x || this.target.height !== _size.y) this.target.setSize(_size.x, _size.y);

    // The world, without the sharp things.
    const shown = sharp.map((o) => o.visible);
    for (const o of sharp) o.visible = false;
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    r.setRenderTarget(null);
    sharp.forEach((o, i) => (o.visible = shown[i]));

    // Smeared onto the canvas, with its depth.
    const u = this.blurMat.uniforms;
    (u.uReproject.value as Matrix4).copy(this.prevVP).multiply(_inv.copy(_vp).invert());
    u.uScale.value = (F.blur.shutter * this.blur) / dt;
    u.uAspect.value = _size.x / _size.y;
    u.uHeight.value = _size.y;
    // Forward on screen: toward the vanishing point (the other way when it's behind the camera).
    (u.uForward.value as Vector2).copy(this.foe).multiplyScalar(this.foeSign).normalize();
    const autoClear = r.autoClear;
    r.autoClear = false;
    this.drawQuad(this.blurMat);

    // The sharp things over it: nothing else, no background, a fresh stencil
    // for the car's ghost. Matrices were brought up to date by the world pass.
    const hidden: Object3D[] = [];
    for (const o of scene.children) {
      if (o.visible && !sharp.includes(o) && !(o as Light).isLight) {
        o.visible = false;
        hidden.push(o);
      }
    }
    const background = scene.background;
    const autoUpdate = scene.matrixWorldAutoUpdate;
    scene.background = null;
    scene.matrixWorldAutoUpdate = false;
    r.clear(false, false, true);
    r.render(scene, camera);
    scene.background = background;
    scene.matrixWorldAutoUpdate = autoUpdate;
    for (const o of hidden) o.visible = true;
    r.autoClear = autoClear;
  }

  private renderOverlay(s: SpeedFxState): void {
    const r = this.renderer;
    const u = this.overlayMat.uniforms;
    u.uVignette.value = this.vignette;
    u.uLines.value = this.lines;
    (u.uRes.value as Vector2).copy(_size);
    if (this.lines > 0.002) {
      const { x: fx, y: fy } = this.foe;
      const dist = Math.max(this.foe.length(), 1);
      (u.uFoe.value as Vector2).set(_size.x / 2 + fx, _size.y / 2 + fy);
      (u.uAxis.value as Vector2).set(-fx / dist, -fy / dist);
      // A line every `spacing` px across the middle of the screen.
      u.uSlot.value = (F.lines.spacing * (_size.y / 1080)) / Math.max(dist, _size.y * 0.3);
      // Behind the camera (reversing toward it), the lines rush in.
      this.time += s.gameDt * F.lines.rate * Math.min(1.2, s.speed / Math.max(s.topSpeed, 1)) * this.foeSign;
      // Keep it small enough for the shader's float maths.
      u.uTime.value = this.time % 1000;
    }
    const autoClear = r.autoClear;
    r.autoClear = false;
    this.drawQuad(this.overlayMat);
    r.autoClear = autoClear;
  }

  private drawQuad(material: ShaderMaterial): void {
    this.quad.material = material;
    this.renderer.render(this.quad, this.quadCam as Camera);
  }

  dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.quad.geometry.dispose();
    this.blurMat.dispose();
    this.overlayMat.dispose();
  }
}
