/**
 * Google's 2D map tiles (Map Tiles API, the same API and key as the 3D tiles),
 * for the minimap: sessions, tile URLs, copyright and the Web Mercator
 * projection.
 */

const API = 'https://tile.googleapis.com';
/** Logical tile size (px at scale 1); high-DPI sessions serve twice the pixels. */
export const TILE = 256;
/** Metres per tile pixel at zoom 0, at the equator. */
export const EARTH_MPP = 156543.034;

// Dark roadmap to sit with the HUD. (At the closest zooms the API keeps its
// own colours for each road class; only the plain `road` colour applies.)
const STYLES = [
  { elementType: 'geometry', stylers: [{ color: '#1c1f25' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#9aa1ab' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#14161a' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#23262d' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#454b56' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#596070' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#7a6a52' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0f1b27' }] },
];

export interface MapSession {
  token: string;
  key: string;
  /** Image pixels per logical tile pixel. */
  density: number;
}

/** One session per key for the page: tile URLs stay the same, so the browser cache keeps working. */
const sessions = new Map<string, Promise<MapSession>>();

async function createSession(key: string, styled: boolean): Promise<MapSession> {
  const highDpi = devicePixelRatio > 1;
  const language = navigator.language || 'en-US';
  let region = 'US';
  try {
    region = new Intl.Locale(language).maximize().region ?? region;
  } catch {
    // Keep the default.
  }
  const body: Record<string, unknown> = { mapType: 'roadmap', language, region, highDpi };
  if (highDpi) body.scale = 'scaleFactor2x';
  if (styled) body.styles = STYLES;
  const res = await fetch(`${API}/v1/createSession?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`createSession ${res.status}`);
  const j = (await res.json()) as { session: string; tileWidth?: number };
  return { token: j.session, key, density: (j.tileWidth ?? TILE) / TILE };
}

export function mapSession(key: string): Promise<MapSession> {
  const cached = sessions.get(key);
  if (cached) return cached;
  // A style the API rejects shouldn't cost the map: fall back to Google's own look.
  const p = createSession(key, true).catch(() => createSession(key, false));
  sessions.set(key, p);
  p.catch(() => sessions.delete(key));
  return p;
}

/** Forgets the session for `key` (expired or rejected), so the next mapSession() makes a new one. */
export function dropSession(key: string): void {
  sessions.delete(key);
}

export function tileUrl(s: MapSession, z: number, x: number, y: number): string {
  return `${API}/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(s.token)}&key=${encodeURIComponent(s.key)}`;
}

/** The map data copyright for an area (Google requires it shown with the tiles). */
export async function copyright(s: MapSession, z: number, north: number, south: number, east: number, west: number): Promise<string> {
  const q = new URLSearchParams({
    session: s.token,
    key: s.key,
    zoom: String(z),
    north: north.toFixed(6),
    south: south.toFixed(6),
    east: east.toFixed(6),
    west: west.toFixed(6),
  });
  const res = await fetch(`${API}/tile/v1/viewport?${q}`);
  if (!res.ok) throw new Error(`viewport ${res.status}`);
  return ((await res.json()) as { copyright?: string }).copyright ?? '';
}

/** Web Mercator: tile-pixel coordinates of a lat/lon at zoom z. */
export function project(lat: number, lon: number, z: number): [number, number] {
  const n = TILE * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

/** Metres per tile pixel at zoom z and latitude `lat`. */
export function metresPerPixel(lat: number, z: number): number {
  return (EARTH_MPP * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}
