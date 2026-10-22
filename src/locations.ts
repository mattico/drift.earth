export interface Spot {
  name: string;
  subtitle: string;
  lat: number;
  lon: number;
  /** Compass bearing to face on spawn, degrees (0 = north, 90 = east). */
  bearing: number;
  /** Spawn on the topmost surface (bridges, decks) instead of the lowest nearby street. */
  top?: boolean;
  /** Spawn on the surface closest to this height (ellipsoidal, m), for streets stacked on a hillside. */
  height?: number;
}

// Points sit on drivable streets; spawn snaps to the lowest flat ground nearby
// unless `top` is set. The first spot is the default start.
export const SPOTS: Spot[] = [
  { name: 'Downtown Minneapolis', subtitle: 'Minnesota', lat: 44.977634, lon: -93.275376, bearing: 225 },
  { name: 'I-35W Bridge', subtitle: 'Minneapolis — over the Mississippi', lat: 44.97889, lon: -93.24472, bearing: 14, top: true },
  { name: 'Arc de Triomphe', subtitle: 'Paris — 12-lane roundabout', lat: 48.87432, lon: 2.29503, bearing: 270 },
  { name: 'Shibuya Crossing', subtitle: 'Tokyo', lat: 35.65944, lon: 139.70055, bearing: 280 },
  { name: 'Times Square', subtitle: 'New York', lat: 40.75773, lon: -73.98571, bearing: 209 },
  { name: 'Las Vegas Strip', subtitle: 'Las Vegas Blvd at Flamingo', lat: 36.1156, lon: -115.17278, bearing: 0 },
  { name: 'Piccadilly Circus', subtitle: 'London', lat: 51.50995, lon: -0.13475, bearing: 270 },
  // On the hairpin-strewn hillside the lowest flat ground nearby is another street.
  { name: 'Casino Square', subtitle: 'Monte Carlo', lat: 43.7399107, lon: 7.4274625, bearing: 218, height: 89.95 },
  { name: 'Embarcadero', subtitle: 'San Francisco', lat: 37.795, lon: -122.39366, bearing: 325 },
  // `top`: every point on this stretch is within 30 m of the Metro C construction pit.
  { name: 'Colosseum', subtitle: 'Rome — Via dei Fori Imperiali', lat: 41.891689, lon: 12.490067, bearing: 121, top: true },
];

/** Parses "lat, lng" or a Google Maps URL containing "@lat,lng". */
export function parseCoordinates(text: string): { lat: number; lon: number } | null {
  const at = text.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  const plain = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  const m = at ?? plain;
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
