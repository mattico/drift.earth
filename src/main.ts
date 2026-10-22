import './style.css';
import { Game, type SpawnOptions } from './game';
import { SPOTS } from './locations';
import { Hud, Menu } from './ui';

const KEY_STORAGE = 'drift.earth:key';

function readKey(): string | null {
  const env = (import.meta.env.MAPS_API_KEY ?? import.meta.env.VITE_GOOGLE_MAPS_KEY) as string | undefined;
  if (env) return env;
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

let apiKey = readKey();
const hud = new Hud();

const game = new Game(document.getElementById('view') as HTMLCanvasElement, hud, {
  onFatal(message) {
    menu.showError(message);
    menu.show(false);
  },
  onPause() {
    menu.show(true);
  },
  onResume() {
    menu.hide();
    game.resume();
  },
  onMenu() {
    menu.show(false);
  },
  onMenuInput(actions, device) {
    menu.setDevice(device);
    if (!actions || !menu.visible) return;
    if (actions.nav) menu.navigate(actions.nav);
    if (actions.select) menu.select();
    if (actions.back && !menu.back() && game.canResume) {
      menu.hide();
      game.resume();
    }
  },
});

const menu = new Menu({
  onPlace(lat, lon, bearing, name, top = false) {
    if (!apiKey) {
      menu.showError('Add a Google Maps Platform API key with the Map Tiles API enabled first.');
      return;
    }
    menu.showError(null);
    menu.hide();
    const url = new URL(location.href);
    const q = new URLSearchParams({ lat: lat.toFixed(6), lon: lon.toFixed(6), bearing: String(Math.round(bearing)) });
    if (top) q.set('top', '1');
    url.search = q.toString();
    history.replaceState(null, '', url);
    game.startTiles(apiKey, lat, lon, bearing, name, top);
  },
  onPractice() {
    menu.showError(null);
    menu.hide();
    history.replaceState(null, '', `${location.pathname}?practice`);
    game.startPractice();
  },
  onResume() {
    menu.hide();
    game.resume();
  },
  onRespawn() {
    menu.hide();
    game.respawnHere();
  },
  onKey(key) {
    apiKey = key;
    try {
      localStorage.setItem(KEY_STORAGE, key);
    } catch {
      // Not persisted; still usable for this session.
    }
    menu.setApiKey(key);
  },
  onDebug() {
    game.debug.toggle();
  },
});
menu.setApiKey(apiKey);

window.addEventListener('keydown', (e) => {
  // Ignore auto-repeat: holding Esc would pause and immediately resume.
  if (e.repeat) return;
  if (e.code === 'Escape' && menu.visible && game.canResume) {
    menu.hide();
    game.resume();
  }
});

// Deep links: ?lat=..&lon=..&bearing=..[&top=1][&h=..][&mph=..|&kmh=..] or ?practice.
// With no link, drop straight into the default spot; Esc opens the menu.
// ?debug[=wire,probes,…] opens the debug panel.
const params = new URLSearchParams(location.search);
const lat = Number(params.get('lat'));
const lon = Number(params.get('lon'));
if (params.has('debug')) game.debug.applyParam(params.get('debug') ?? '');
if (params.has('practice')) {
  menu.hide();
  game.startPractice();
} else if (apiKey && params.has('lat') && params.has('lon') && Number.isFinite(lat) && Number.isFinite(lon)) {
  const opts: SpawnOptions = {};
  const h = params.get('h')?.trim();
  const kmh = params.has('mph') ? Number(params.get('mph')) * 1.609344 : Number(params.get('kmh'));
  if (h && Number.isFinite(Number(h))) opts.height = Number(h);
  if (Number.isFinite(kmh) && kmh) opts.kmh = kmh;
  menu.hide();
  game.startTiles(
    apiKey,
    lat,
    lon,
    Number(params.get('bearing')) || 0,
    params.get('name') ?? 'your spot',
    params.get('top') === '1',
    opts,
  );
} else if (apiKey) {
  const home = SPOTS[0];
  menu.hide();
  game.startTiles(apiKey, home.lat, home.lon, home.bearing, home.name, home.top);
}

// Exposed for debugging and automated runs; `__drift.debug` is the trace and
// overlay API (see tools/capture.mjs).
(window as unknown as { __drift: Game }).__drift = game;

// The splash (inline in index.html) covers the page until the game has drawn
// its first frame, then fades into whatever's next: the menu or the fly-in.
const splash = document.getElementById('splash');
if (splash) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      splash.classList.add('done');
      splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    }),
  );
}
