import { CanvasTexture, EquirectangularReflectionMapping, SRGBColorSpace, type Texture } from 'three';

/**
 * A plain daytime sky for the scene background: a vertical gradient from deep
 * blue overhead to pale haze at the horizon, and a muted ground tone below it
 * for gaps in the map. An equirectangular strip, so it only varies with height.
 */
export function createSky(): Texture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, '#2f6fbf');
  g.addColorStop(0.25, '#5d97d6');
  g.addColorStop(0.42, '#a9c8e6');
  g.addColorStop(0.5, '#dde7ee');
  g.addColorStop(0.52, '#c4c8c6');
  g.addColorStop(1, '#5e605c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  const tex = new CanvasTexture(c);
  tex.mapping = EquirectangularReflectionMapping;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
