/**
 * Minimap: a 2D canvas overlay drawn from the level generator's own layout data (no extra WebGL
 * pass, no second camera, zero draw calls in the 3D renderer).
 *
 *   import { minimap, registerMinimapSource, type MinimapSource } from './minimap';
 *
 *   registerMinimapSource((level) => (level instanceof MyLevel ? mySource : null));
 *   minimap.update(level, player.pos, player.yaw, timeSeconds);   // every frame (cheap: throttled)
 *   minimap.cycle();                                              // M: minimap → large map → off
 *
 * A source describes a world in square tiles of `tileSize` metres (+x east on screen... in the
 * level's own axes: x right, z down on the map, so north (-z) is up):
 *
 *   interface MinimapSource {
 *     tileSize: number;                                        // metres per tile edge
 *     drawTile(g, tx, tz, px): void;                           // paint world [tx*T,(tx+1)*T]×[tz*T,(tz+1)*T] into px×px
 *     version?(tx, tz): number;                                // bump to repaint a tile (new data arrived)
 *     labels?(x0, z0, x1, z1): MapLabel[];                     // upright text / showcase markers in a world rect
 *     hidden?: boolean;                                        // e.g. inside a building: hide the map
 *   }
 *
 * Tiles are painted once into offscreen canvases (TILE_PX², LRU, at most MAX_TILES) and only blitted
 * afterwards. The HUD (≈180 px, heading-up) redraws at ≤ 12 Hz and only when the player moved or
 * turned; the large map (north-up, wheel to zoom, drag to pan) redraws on input. Stats:
 * window.__minimap.stats = { tiles, painted, draws, lastMs, avgMs }.
 */

export interface MapLabel {
  x: number;
  z: number;
  text: string;
  /** 'district' (big label), 'showcase' (a dot and small text), 'door' (a small dot) */
  kind: 'district' | 'showcase' | 'door';
}
/** the 2D calls a source may use (a CanvasRenderingContext2D, or a recorder in qa) */
export type Ctx2D = Pick<CanvasRenderingContext2D, 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'fillRect' | 'strokeRect' | 'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'fill' | 'stroke' | 'arc' | 'save' | 'restore' | 'translate' | 'scale' | 'rotate' | 'setTransform' | 'clearRect' | 'drawImage' | 'fillText' | 'font' | 'textAlign' | 'textBaseline' | 'globalAlpha'>;
export interface MinimapSource {
  tileSize: number;
  drawTile(g: Ctx2D, tx: number, tz: number, px: number): void;
  version?(tx: number, tz: number): number;
  labels?(x0: number, z0: number, x1: number, z1: number): MapLabel[];
  hidden?: boolean;
}
type Resolver = (level: unknown) => MinimapSource | null;
const resolvers: Resolver[] = [];
/** a level type registers how to map itself (first resolver that returns a source wins) */
export function registerMinimapSource(r: Resolver) {
  resolvers.push(r);
}

export const TILE_PX = 256;
export const MAX_TILES = 64;
/** HUD redraw rate cap (Hz) */
export const HUD_HZ = 12;
/** HUD scale: pixels per metre */
export const HUD_PPM = 1.0;

/** a canvas factory (the browser's by default; qa passes its own) */
export interface Surface {
  width: number;
  height: number;
  getContext(t: '2d'): Ctx2D | null;
}
let makeSurface = (w: number, h: number): Surface => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c as unknown as Surface;
};
export function setSurfaceFactory(f: (w: number, h: number) => Surface) {
  makeSurface = f;
}

/** world → map screen (heading-up): centre (cx, cy), `ppm` px per metre, the view turned by yaw */
export function worldToMap(x: number, z: number, px: number, pz: number, yaw: number, ppm: number, cx: number, cy: number): [number, number] {
  // camera yaw 0 looks -z (north); heading-up turns the world by +yaw so the view direction is up
  const dx = (x - px) * ppm, dz = (z - pz) * ppm;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [cx + dx * c - dz * s, cy + dx * s + dz * c];
}

/** LRU tile cache: canvas per tile, at most `cap` */
export class TileCache {
  private tiles = new Map<string, { surf: Surface; ver: number }>();
  painted = 0;
  constructor(public cap = MAX_TILES) {}
  get size() {
    return this.tiles.size;
  }
  clear() {
    this.tiles.clear();
  }
  /** the tile's canvas, painted now if missing or stale (returns null when `allowPaint` is false and it would need painting) */
  get(src: MinimapSource, tx: number, tz: number, allowPaint = true): Surface | null {
    const key = `${tx},${tz}`;
    const ver = src.version?.(tx, tz) ?? 0;
    let t = this.tiles.get(key);
    if (t && t.ver === ver) {
      this.tiles.delete(key);
      this.tiles.set(key, t); // LRU bump
      return t.surf;
    }
    if (!allowPaint) return t?.surf ?? null;
    const surf = t?.surf ?? makeSurface(TILE_PX, TILE_PX);
    const g = surf.getContext('2d');
    if (g) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, TILE_PX, TILE_PX);
      src.drawTile(g, tx, tz, TILE_PX);
    }
    this.painted++;
    if (t) this.tiles.delete(key);
    this.tiles.set(key, (t = { surf, ver }));
    while (this.tiles.size > this.cap) this.tiles.delete(this.tiles.keys().next().value!);
    return surf;
  }
}

type Mode = 'hud' | 'large' | 'off';

export class Minimap {
  mode: Mode = 'hud';
  cache = new TileCache();
  stats = { tiles: 0, painted: 0, draws: 0, lastMs: 0, avgMs: 0 };
  private src: MinimapSource | null = null;
  private hud: HTMLCanvasElement | null = null;
  private big: HTMLCanvasElement | null = null;
  private last = { x: NaN, z: NaN, yaw: NaN, t: -1 };
  private pos = { x: 0, z: 0 };
  private view = { x: 0, z: 0, ppm: 0.5, dirty: true };
  private sourceOf = new WeakMap<object, MinimapSource | null>();
  /** for qa: no DOM, just count and paint into the given surface */
  headless: Surface | null = null;

  cycle() {
    this.mode = this.mode === 'hud' ? 'large' : this.mode === 'large' ? 'off' : 'hud';
    this.view.dirty = true;
    this.last.t = -1;
    if (this.mode === 'large' && typeof document !== 'undefined') {
      this.view.x = this.pos.x;
      this.view.z = this.pos.z;
      document.exitPointerLock?.();
    }
    this.show();
  }

  /** call every frame; draws at most HUD_HZ times a second, and only when something changed */
  update(level: unknown, pos: { x: number; z: number }, yaw: number, time: number) {
    const src = this.resolve(level);
    if (src !== this.src) {
      this.src = src;
      this.cache.clear();
      this.last.t = -1;
      this.view.dirty = true;
    }
    this.pos.x = pos.x;
    this.pos.z = pos.z;
    this.show();
    if (!src || src.hidden || this.mode === 'off') return;
    const moved = Math.hypot(pos.x - this.last.x, pos.z - this.last.z) > 0.25 || Math.abs(yaw - this.last.yaw) > 0.015 || Number.isNaN(this.last.x);
    if (this.mode === 'large') {
      // on pan/zoom at once; for the player's own arrow, a few times a second
      if (this.view.dirty || (moved && time - this.last.t > 0.25)) {
        this.last.x = pos.x;
        this.last.z = pos.z;
        this.last.yaw = yaw;
        this.last.t = time;
        this.drawLarge(src, pos, yaw);
      }
      return;
    }
    if (!moved || (this.last.t >= 0 && time - this.last.t < 1 / HUD_HZ)) return;
    this.last.x = pos.x;
    this.last.z = pos.z;
    this.last.yaw = yaw;
    this.last.t = time;
    this.drawHud(src, pos, yaw);
  }

  private resolve(level: unknown): MinimapSource | null {
    if (!level || typeof level !== 'object') return null;
    if (this.sourceOf.has(level)) return this.sourceOf.get(level)!;
    let s: MinimapSource | null = null;
    for (const r of resolvers) if ((s = r(level))) break;
    this.sourceOf.set(level, s);
    return s;
  }

  private show() {
    if (this.headless || typeof document === 'undefined') return;
    const want = !!this.src && !this.src.hidden;
    if (!this.hud) {
      this.hud = document.createElement('canvas');
      this.hud.width = this.hud.height = 180 * Math.min(2, devicePixelRatio || 1);
      Object.assign(this.hud.style, { position: 'fixed', right: '14px', bottom: '14px', width: '180px', height: '180px', borderRadius: '50%', boxShadow: '0 2px 10px rgba(0,0,0,.45)', border: '2px solid rgba(255,255,255,.75)', pointerEvents: 'none', zIndex: '20' });
      this.hud.id = 'minimap';
      document.body.appendChild(this.hud);
    }
    if (!this.big) {
      const b = (this.big = document.createElement('canvas'));
      Object.assign(b.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: '30', background: '#1e2b33', cursor: 'grab' });
      b.id = 'minimap-large';
      document.body.appendChild(b);
      let drag: { x: number; y: number } | null = null;
      b.addEventListener('pointerdown', (e) => ((drag = { x: e.clientX, y: e.clientY }), b.setPointerCapture(e.pointerId)));
      b.addEventListener('pointerup', () => (drag = null));
      b.addEventListener('pointermove', (e) => {
        if (!drag) return;
        this.view.x -= (e.clientX - drag.x) / this.view.ppm;
        this.view.z -= (e.clientY - drag.y) / this.view.ppm;
        drag = { x: e.clientX, y: e.clientY };
        this.view.dirty = true;
      });
      b.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.view.ppm = Math.min(4, Math.max(0.12, this.view.ppm * Math.exp(-e.deltaY * 0.0015)));
        this.view.dirty = true;
      }, { passive: false });
    }
    this.hud.style.display = want && this.mode === 'hud' ? 'block' : 'none';
    this.big.style.display = want && this.mode === 'large' ? 'block' : 'none';
  }

  /** blit the tiles covering a world rect into g with the current transform (paints at most `budget` new tiles) */
  private blit(g: Ctx2D, src: MinimapSource, x0: number, z0: number, x1: number, z1: number, budget: number) {
    const T = src.tileSize;
    let painted = 0, n = 0;
    for (let tz = Math.floor(z0 / T); tz <= Math.floor(z1 / T); tz++)
      for (let tx = Math.floor(x0 / T); tx <= Math.floor(x1 / T); tx++) {
        const surf = this.cache.get(src, tx, tz, painted < budget);
        const before = this.cache.painted;
        if (surf) g.drawImage(surf as unknown as CanvasImageSource, tx * T, tz * T, T, T);
        painted += this.cache.painted - before;
        n++;
      }
    return n;
  }

  private drawHud(src: MinimapSource, pos: { x: number; z: number }, yaw: number) {
    const t0 = performance.now();
    const surf = this.headless ?? (this.hud as unknown as Surface);
    const g = surf?.getContext('2d');
    if (!g) return;
    const W = surf.width, k = W / 180, ppm = HUD_PPM * k, R = W / 2;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#26343c';
    g.fillRect(0, 0, W, W);
    // world → screen: centre on the player, heading up
    g.setTransform(1, 0, 0, 1, R, R);
    g.rotate(yaw);
    g.scale(ppm, ppm);
    g.translate(-pos.x, -pos.z);
    const reach = (R / ppm) * 1.45;
    this.blit(g, src, pos.x - reach, pos.z - reach, pos.x + reach, pos.z + reach, 2);
    // upright labels for the special blocks in view
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (src.labels) {
      g.font = `600 ${Math.round(10 * k)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const l of src.labels(pos.x - reach, pos.z - reach, pos.x + reach, pos.z + reach)) {
        if (l.kind !== 'district') continue;
        const [sx, sy] = worldToMap(l.x, l.z, pos.x, pos.z, yaw, ppm, R, R);
        if (Math.hypot(sx - R, sy - R) > R - 14 * k) continue;
        g.fillStyle = 'rgba(0,0,0,.55)';
        g.fillText(l.text, sx + k, sy + k);
        g.fillStyle = '#fff';
        g.fillText(l.text, sx, sy);
      }
    }
    // the view cone and the player arrow (always pointing up)
    g.fillStyle = 'rgba(255,240,180,.18)';
    g.beginPath();
    g.moveTo(R, R);
    g.arc(R, R, 70 * k, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    g.closePath();
    g.fill();
    g.fillStyle = '#ffd23f';
    g.strokeStyle = '#1b1b1b';
    g.lineWidth = 1.5 * k;
    g.beginPath();
    g.moveTo(R, R - 8 * k);
    g.lineTo(R + 5.5 * k, R + 6 * k);
    g.lineTo(R, R + 3 * k);
    g.lineTo(R - 5.5 * k, R + 6 * k);
    g.closePath();
    g.fill();
    g.stroke();
    // N marker on the rim
    const [nx, ny] = worldToMap(pos.x, pos.z - 1e3, pos.x, pos.z, yaw, 1, R, R);
    const a = Math.atan2(ny - R, nx - R);
    g.fillStyle = '#e8463c';
    g.font = `700 ${Math.round(11 * k)}px system-ui, sans-serif`;
    g.fillText('N', R + Math.cos(a) * (R - 10 * k), R + Math.sin(a) * (R - 10 * k));
    this.done(t0);
  }

  private drawLarge(src: MinimapSource, pos: { x: number; z: number }, yaw: number) {
    const t0 = performance.now();
    const c = this.headless ?? (this.big as unknown as Surface);
    if (!c) return;
    if (!this.headless && this.big) {
      const w = Math.round(innerWidth * Math.min(2, devicePixelRatio || 1)), h = Math.round(innerHeight * Math.min(2, devicePixelRatio || 1));
      if (this.big.width !== w || this.big.height !== h) ((this.big.width = w), (this.big.height = h));
    }
    const g = c.getContext('2d');
    if (!g) return;
    const W = c.width, H = c.height, k = this.headless ? 1 : Math.min(2, devicePixelRatio || 1);
    // never more tiles than the cache holds: zoom limits keep the view under ~48 tiles
    const T = src.tileSize;
    const minPpm = (k * Math.sqrt((W * H) / (k * k) / 40)) / T;
    const ppm = Math.max(this.view.ppm, minPpm) * k;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#1e2b33';
    g.fillRect(0, 0, W, H);
    g.setTransform(ppm, 0, 0, ppm, W / 2 - this.view.x * ppm, H / 2 - this.view.z * ppm);
    const x0 = this.view.x - W / 2 / ppm, x1 = this.view.x + W / 2 / ppm, z0 = this.view.z - H / 2 / ppm, z1 = this.view.z + H / 2 / ppm;
    const n = this.blit(g, src, x0, z0, x1, z1, 64);
    this.view.dirty = false;
    void n;
    g.setTransform(1, 0, 0, 1, 0, 0);
    const toS = (x: number, z: number): [number, number] => [W / 2 + (x - this.view.x) * ppm, H / 2 + (z - this.view.z) * ppm];
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const l of src.labels?.(x0, z0, x1, z1) ?? []) {
      const [sx, sy] = toS(l.x, l.z);
      if (l.kind === 'district') {
        g.font = `700 ${Math.round(13 * k)}px system-ui, sans-serif`;
        g.fillStyle = 'rgba(0,0,0,.6)';
        g.fillText(l.text, sx + k, sy + k);
        g.fillStyle = '#ffffff';
        g.fillText(l.text, sx, sy);
      } else if (ppm / k > 0.6 || l.kind === 'showcase') {
        g.fillStyle = l.kind === 'door' ? '#7fd1ff' : '#ffd23f';
        g.beginPath();
        g.arc(sx, sy, (l.kind === 'door' ? 2 : 4) * k, 0, Math.PI * 2);
        g.fill();
        if (l.kind === 'showcase' && ppm / k > 0.35) {
          g.font = `500 ${Math.round(10 * k)}px system-ui, sans-serif`;
          g.fillStyle = '#ffe9a8';
          g.fillText(l.text, sx, sy - 10 * k);
        }
      }
    }
    // the player
    const [px, py] = toS(pos.x, pos.z);
    g.save();
    g.translate(px, py);
    g.rotate(-yaw);
    g.fillStyle = '#ffd23f';
    g.strokeStyle = '#111';
    g.lineWidth = 1.5 * k;
    g.beginPath();
    g.moveTo(0, -10 * k);
    g.lineTo(7 * k, 8 * k);
    g.lineTo(0, 4 * k);
    g.lineTo(-7 * k, 8 * k);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    g.font = `500 ${Math.round(12 * k)}px system-ui, sans-serif`;
    g.fillStyle = 'rgba(255,255,255,.8)';
    g.textAlign = 'left';
    g.fillText('M: close map · wheel: zoom · drag: pan', 16 * k, H - 18 * k);
    this.done(t0);
  }

  private done(t0: number) {
    const ms = performance.now() - t0;
    this.stats.draws++;
    this.stats.lastMs = +ms.toFixed(3);
    this.stats.avgMs = +(this.stats.avgMs + (ms - this.stats.avgMs) / Math.min(this.stats.draws, 50)).toFixed(3);
    this.stats.tiles = this.cache.size;
    this.stats.painted = this.cache.painted;
  }
}

export const minimap = new Minimap();
if (typeof window !== 'undefined') (window as unknown as { __minimap: Minimap }).__minimap = minimap;
