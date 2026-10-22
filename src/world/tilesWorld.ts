import {
  Euler,
  Material,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Sphere,
  Vector3,
  type Object3D,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer/three';
import type { Tile } from '3d-tiles-renderer/core';
// Must come from core/plugins: the three/plugins re-export only exists in the type declarations.
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import {
  GLTFExtensionsPlugin,
  LoadRegionPlugin,
  ReorientationPlugin,
  SphereRegion,
} from '3d-tiles-renderer/three/plugins';
import { TILES } from '../config';
import { overlapsColumn, worldBox } from './meshBounds';
import type { Geo, RebaseResult, World, WorldStatus } from './types';

// azimuth = π gives +X east, +Y up, −Z north (verified against the library).
const AZIMUTH = Math.PI;
const DRACO_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
/** Consecutive tile failures (with no successful load) before suspecting a stuck session. */
const STUCK_FAILURES = 8;
const MAX_SESSION_RECOVERIES = 3;

export interface TilesWorldOptions {
  apiKey: string;
  lat: number; // degrees
  lon: number; // degrees
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
}

export class TilesWorld implements World {
  readonly kind = 'tiles' as const;
  readonly root: Object3D;
  private readonly tiles: TilesRenderer;
  private readonly draco: DRACOLoader;
  private readonly reorient: ReorientationPlugin;
  private readonly region: SphereRegion;
  private readonly meshesByScene = new WeakMap<Object3D, Mesh[]>();
  private epoch = 0;
  private fatal: string | null = null;
  private loadErrors = 0;
  private failStreak = 0;
  private recoveries = 0;
  private recoveryTimer = 0;
  private readonly auth: GoogleCloudAuthPlugin;
  private attributionText = '';
  private attributionAge = Infinity;
  private minLeafError = Infinity;
  private readonly renderer: WebGLRenderer;
  private readonly camera: PerspectiveCamera;
  private readonly onResize = () => this.tiles.setResolutionFromRenderer(this.camera, this.renderer);

  constructor(opts: TilesWorldOptions) {
    this.camera = opts.camera;
    this.renderer = opts.renderer;
    this.draco = new DRACOLoader().setDecoderPath(DRACO_PATH);

    const tiles = new TilesRenderer();
    this.auth = new GoogleCloudAuthPlugin({ apiToken: opts.apiKey, autoRefreshToken: true });
    tiles.registerPlugin(this.auth);
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: this.draco }));
    this.reorient = new ReorientationPlugin({
      lat: opts.lat * MathUtils.DEG2RAD,
      lon: opts.lon * MathUtils.DEG2RAD,
      height: 0,
      azimuth: AZIMUTH,
    });
    tiles.registerPlugin(this.reorient);

    // Keep the finest LOD loaded around (and just ahead of) the car, even off-screen.
    this.region = new SphereRegion({ sphere: new Sphere(new Vector3(), TILES.regionRadius), errorTarget: TILES.regionErrorTarget });
    const loadRegion = new LoadRegionPlugin();
    loadRegion.addRegion(this.region);
    tiles.registerPlugin(loadRegion);

    // Set after the Google plugin, which applies its own recommended errorTarget.
    tiles.errorTarget = TILES.errorTarget;
    // Google's bounding volumes are loose; the accelerated traversal can miss geometry.
    tiles.accelerateRaycast = false;
    tiles.lruCache.maxBytesSize = TILES.cacheMaxBytes;
    tiles.lruCache.minBytesSize = TILES.cacheMinBytes;

    tiles.setCamera(opts.camera);
    tiles.setResolutionFromRenderer(opts.camera, opts.renderer);
    window.addEventListener('resize', this.onResize);

    tiles.addEventListener('load-model', ({ scene, tile }) => this.onLoadModel(scene, tile));
    tiles.addEventListener('dispose-model', ({ scene }) => this.meshesByScene.delete(scene));
    tiles.addEventListener('load-error', ({ tile, error }) => this.onLoadError(tile, error));

    this.tiles = tiles;
    this.root = tiles.group;
  }

  private onLoadModel(scene: Object3D, tile: Tile): void {
    this.failStreak = 0;
    const meshes: Mesh[] = [];
    // The renderer disposes the materials it recorded at parse time; register the
    // replacements there too so they're disposed with the tile.
    const owned = (tile as Tile & { engineData?: { materials?: Material[] | null } }).engineData?.materials;
    const swapped = new Map<Material, Material>();
    const unlitFor = (m: Material) => {
      let u = swapped.get(m);
      if (!u) {
        u = toUnlit(m);
        swapped.set(m, u);
        if (u !== m) owned?.push(u);
      }
      return u;
    };
    scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      meshes.push(mesh);
      // Photogrammetry has baked lighting; render it unlit so scene lights only affect the car.
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(unlitFor) : unlitFor(mesh.material);
    });
    this.meshesByScene.set(scene, meshes);
    if (!tile.children?.length && tile.geometricError < this.minLeafError) this.minLeafError = tile.geometricError;
  }

  private onLoadError(tile: Tile | null, error: Error): void {
    this.loadErrors++;
    console.warn('[tiles] load error', error);
    if (tile === null) {
      this.fatal = describeRootError(error);
      return;
    }
    // A failed session refresh leaves GoogleCloudAuth holding a rejected promise
    // that every later request awaits, so nothing loads again. Detect a streak of
    // failures with no successes, clear it after a back-off, and give up after a
    // few tries (each refresh is a billable root request).
    this.failStreak++;
    // `auth` and its promise are runtime fields the type declarations don't expose.
    const auth = (this.auth as unknown as { auth: { _tokenRefreshPromise: Promise<unknown> | null } }).auth;
    if (this.failStreak < STUCK_FAILURES || !auth._tokenRefreshPromise || this.recoveryTimer) return;
    if (this.recoveries >= MAX_SESSION_RECOVERIES) {
      this.fatal = `Lost the Google 3D Tiles session: ${describeRootError(error)}`;
      return;
    }
    const delay = 5000 * 2 ** this.recoveries++;
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = 0;
      this.failStreak = 0;
      auth._tokenRefreshPromise = null;
      this.tiles.resetFailedTiles();
    }, delay);
  }

  collectColliders(x: number, z: number, radius: number, out: Mesh[]): void {
    for (const tile of this.tiles.activeTiles) {
      const scene = (tile as Tile & { engineData?: { scene?: Object3D | null } }).engineData?.scene;
      if (!scene) continue;
      const meshes = this.meshesByScene.get(scene);
      if (!meshes) continue;
      for (const mesh of meshes) {
        if (overlapsColumn(worldBox(mesh, this.epoch), x, z, radius)) out.push(mesh);
      }
    }
  }

  hasCoverage(x: number, z: number): boolean {
    const probe: Mesh[] = [];
    this.collectColliders(x, z, 0, probe);
    return probe.length > 0;
  }

  update(camera: PerspectiveCamera, focus: Vector3, velocity: Vector3): void {
    const g = this.tiles.group;
    this.region.sphere.center
      .copy(velocity)
      .multiplyScalar(TILES.regionLookAhead)
      .add(focus)
      .applyMatrix4(g.matrixWorldInverse);
    camera.updateMatrixWorld();
    this.tiles.update();

    this.attributionAge++;
    if (this.attributionAge > 30) {
      this.attributionAge = 0;
      this.attributionText = formatAttributions(this.tiles.getAttributions());
    }
  }

  maybeRebase(p: Vector3): RebaseResult | null {
    if (Math.hypot(p.x, p.z) < TILES.rebaseDistance) return null;
    const g = this.tiles.group;
    g.updateMatrixWorld();
    const oldWorld = g.matrixWorld.clone();
    const oldQuat = g.quaternion.clone();
    const ecef = p.clone().applyMatrix4(g.matrixWorldInverse);
    const carto = this.tiles.ellipsoid.getPositionToCartographic(ecef, { lat: 0, lon: 0, height: 0 });
    // Keep the frame's height at the ellipsoid so world Y stays comparable across rebases.
    this.reorient.transformLatLonHeightToOrigin(carto.lat, carto.lon, 0, AZIMUTH);
    const matrix = new Matrix4().multiplyMatrices(g.matrixWorld, oldWorld.invert());
    const dq = new Quaternion().multiplyQuaternions(g.quaternion, oldQuat.invert());
    const yaw = new Euler().setFromQuaternion(dq, 'YXZ').y;
    this.epoch++;
    return { matrix, yaw };
  }

  attribution(): string {
    return this.attributionText;
  }

  status(): WorldStatus {
    const stats = (this.tiles as unknown as { stats: { downloading: number; parsing: number } }).stats;
    return {
      loading: stats.downloading + stats.parsing > 0,
      progress: this.tiles.loadProgress,
      fatal: this.fatal,
    };
  }

  debugInfo(): string {
    const s = (this.tiles as unknown as { stats: Record<string, number> }).stats;
    const leaf = Number.isFinite(this.minLeafError) ? this.minLeafError.toFixed(2) : '–';
    return (
      `tiles active ${this.tiles.activeTiles.size} visible ${this.tiles.visibleTiles.size}` +
      ` dl ${s.downloading} parse ${s.parsing} failed ${s.failed} errors ${this.loadErrors}\n` +
      `min leaf geometricError ${leaf} m`
    );
  }

  stats(): Record<string, number> {
    const s = (this.tiles as unknown as { stats: Record<string, number> }).stats;
    return {
      active: this.tiles.activeTiles.size,
      visible: this.tiles.visibleTiles.size,
      downloading: s.downloading,
      parsing: s.parsing,
      failed: s.failed,
      loadErrors: this.loadErrors,
      recoveries: this.recoveries,
      epoch: this.epoch,
    };
  }

  geo(p: Vector3): Geo {
    const g = this.tiles.group;
    g.updateMatrixWorld();
    const ecef = p.clone().applyMatrix4(g.matrixWorldInverse);
    const c = this.tiles.ellipsoid.getPositionToCartographic(ecef, { lat: 0, lon: 0, height: 0 });
    return { lat: c.lat * MathUtils.RAD2DEG, lon: c.lon * MathUtils.RAD2DEG, height: c.height };
  }

  dispose(): void {
    clearTimeout(this.recoveryTimer);
    window.removeEventListener('resize', this.onResize);
    this.tiles.dispose();
    this.draco.dispose();
  }
}

function toUnlit(m: Material): Material {
  if ((m as MeshBasicMaterial).isMeshBasicMaterial) return m;
  const src = m as Material & { map?: Texture | null; color?: MeshBasicMaterial['color'] };
  const basic = new MeshBasicMaterial({ map: src.map ?? null, side: m.side });
  if (src.color && !src.map) basic.color.copy(src.color);
  m.dispose();
  return basic;
}

/** Google requires attributions sorted by frequency; the plugin sorts, we trim and dedupe. */
function formatAttributions(list: Array<{ type: string; value: unknown }>): string {
  const parts: string[] = [];
  for (const a of list) {
    if (a.type !== 'string') continue;
    for (const raw of String(a.value).split(';')) {
      const s = raw.trim();
      if (s && !parts.includes(s)) parts.push(s);
    }
  }
  return parts.join('; ');
}

function describeRootError(error: Error): string {
  const msg = String(error?.message ?? error);
  if (/403/.test(msg)) {
    return 'Google rejected the API key (403). Enable the Map Tiles API for this key and allow it under API restrictions.';
  }
  if (/429/.test(msg)) return 'Map Tiles API quota exceeded (429). Try again later.';
  if (/400|401/.test(msg)) return 'The Map Tiles API rejected the request. Check the API key.';
  return `Could not load Google 3D tiles: ${msg}`;
}
