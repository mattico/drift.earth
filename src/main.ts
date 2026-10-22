// First, so it sees the page before any game code touches it.
import { resetPage } from './hot';
import './style.css';
import { type CarId, DEFAULT_CAR, isCarId } from './car/cars';
import { Game, type SpawnOptions } from './game';
import { SPOTS } from './locations';
import { Hud, Menu } from './ui';

const KEY_STORAGE = 'drift.earth:key';
const CAR_STORAGE = 'drift.earth:car';

/** ?car= wins (a shared or repro link names its car), then the last pick in the menu. */
function readCar(): CarId {
  const linked = linkedCar();
  if (linked) return linked;
  try {
    const saved = localStorage.getItem(CAR_STORAGE);
    if (isCarId(saved)) return saved;
  } catch {
    // Storage blocked: the default car.
  }
  return DEFAULT_CAR;
}

function readKey(): string | null {
  const env = (import.meta.env.MAPS_API_KEY ?? import.meta.env.VITE_GOOGLE_MAPS_KEY) as string | undefined;
  if (env) return env;
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

/** The page's ?car=, if any: a new run's link keeps it (it was never saved, unlike a menu pick). */
function linkedCar(): CarId | null {
  const car = new URLSearchParams(location.search).get('car');
  return isCarId(car) ? car : null;
}

// Hot updates (dev): an edit re-runs this module with fresh copies of the
// edited modules, and the new game takes over the old one's renderer and
// world (Game.restore). Reloading the page instead would start a new, billed
// Map Tiles session and fetch every tile again. Edits to the world's own code
// still reload the page (vite.config.ts).
const prev = import.meta.hot?.data.game as Game | undefined;
let built: Game | null = null;
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose((data) => {
    // A run that failed part-way may have no game: the last good one's world carries on.
    if (built) {
      built.detach();
      data.game = built;
    }
    resetPage();
  });
}

let apiKey = readKey();
const hud = new Hud();

const game = new Game(document.getElementById('view') as HTMLCanvasElement, hud, {
  onFatal(message) {
    menu.showError(message);
    menu.show(false);
  },
  onPause() {
    menu.setRoadAvailable(game.hasRoads);
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
    // Road tiles keep loading while paused.
    if (game.canResume) menu.setRoadAvailable(game.hasRoads);
    if (!actions || !menu.visible) return;
    if (actions.nav) menu.navigate(actions.nav);
    if (actions.select) menu.select();
    if (actions.back && !menu.back() && game.canResume) {
      menu.hide();
      game.resume();
    }
  },
}, prev);
built = game;

const menu = new Menu({
  onPlace(lat, lon, bearing, name, top = false, height) {
    if (!apiKey) {
      menu.showError('Add a Google Maps Platform API key with the Map Tiles API enabled first.');
      return;
    }
    menu.showError(null);
    menu.hide();
    const url = new URL(location.href);
    const q = new URLSearchParams({ lat: lat.toFixed(6), lon: lon.toFixed(6), bearing: String(Math.round(bearing)) });
    if (top) q.set('top', '1');
    if (height !== undefined) q.set('h', String(height));
    const car = linkedCar();
    if (car) q.set('car', car);
    url.search = q.toString();
    history.replaceState(null, '', url);
    game.startTiles(apiKey, lat, lon, bearing, name, top, { height });
  },
  onPractice() {
    menu.showError(null);
    menu.hide();
    const car = linkedCar();
    history.replaceState(null, '', `${location.pathname}?practice${car ? `&car=${car}` : ''}`);
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
  onRoad() {
    menu.hide();
    game.backToRoad();
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
  onCar(id) {
    // Paused, the new car takes the old one's place, stopped; before a run it's just the one you'll drive.
    game.setCar(id);
    menu.setCar(id);
    try {
      localStorage.setItem(CAR_STORAGE, id);
    } catch {
      // Not persisted; still this session's car.
    }
    // A ?car= link would override the pick on reload. (Edited by hand: URLSearchParams
    // would turn a bare ?practice into ?practice=.)
    if (linkedCar()) {
      const rest = location.search.slice(1).split('&').filter((kv) => kv.split('=')[0] !== 'car');
      history.replaceState(null, '', `${location.pathname}${rest.length ? `?${rest.join('&')}` : ''}${location.hash}`);
    }
  },
  onHeadphones(on) {
    game.setHeadphones(on);
    menu.setHeadphones(on);
  },
  onSpeedEffects(on) {
    game.setSpeedEffects(on);
    menu.setSpeedEffects(on);
  },
});
menu.setApiKey(apiKey);
menu.setHeadphones(game.headphones);
menu.setSpeedEffects(game.speedEffects);
// Before anything is driven, so the first run is in the chosen car.
const startCar = readCar();
game.setCar(startCar);
menu.setCar(startCar);

window.addEventListener('keydown', (e) => {
  // Ignore auto-repeat: holding Esc would pause and immediately resume.
  if (e.repeat) return;
  if (e.code === 'Escape' && menu.visible && game.canResume) {
    menu.hide();
    game.resume();
  }
});

// Deep links: ?lat=..&lon=..&bearing=..[&top=1][&h=..][&mph=..|&kmh=..] or ?practice,
// either with [&car=hatch|muscle].
// With no link, drop straight into the default spot; Esc opens the menu.
// ?debug[=wire,probes,…] opens the debug panel.
// After a hot update, carry on where the last game was instead.
const params = new URLSearchParams(location.search);
const lat = Number(params.get('lat'));
const lon = Number(params.get('lon'));
if (!prev && params.has('debug')) game.debug.applyParam(params.get('debug') ?? '');
if (prev) {
  menu.hide();
  game.restore(prev);
  menu.setCar(game.carId);
} else if (params.has('practice')) {
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
  game.startTiles(apiKey, home.lat, home.lon, home.bearing, home.name, home.top, { height: home.height });
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
