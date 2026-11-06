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
 *     snap?(x, z, marker?): {x, z, yaw} | null;                // large-map click: where to teleport
 *     describe?(x, z): string;                                 // hover text
 *     hidden?: boolean;                                        // e.g. inside a building: hide the map
 *   }
 *
 * Tiles are painted once into offscreen canvases (TILE_PX², LRU, at most MAX_TILES) and only blitted
 * afterwards. The HUD (≈180 px, heading-up) composites the tiles around the player into one map
 * canvas only after the player moved RECOMPOSITE_M (or a tile filled in); every frame it only turns
 * and shifts that canvas with a CSS transform (GPU-composited), under a fixed SVG arrow and cone.
 * The large map (north-up, wheel zoom, drag pan, click to teleport, legend, greedy-placed labels with
 * a halo) redraws on input. Stats: window.__minimap.stats = { tiles, painted, composites, draws,
 * lastMs, avgMs (per composite/draw), frameMs (average update() cost per frame) }.
 */

export interface MapLabel {
  x: number;
  z: number;
  text: string;
  /** 'district' (big label), 'showcase' (a dot and small text), 'door' (a small dot) */
  kind: 'district' | 'showcase' | 'door';
}
/** the 2D calls a source may use (a CanvasRenderingContext2D, or a recorder in qa) */
export type Ctx2D = Pick<CanvasRenderingContext2D, 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'lineJoin' | 'strokeText' | 'fillRect' | 'strokeRect' | 'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'fill' | 'stroke' | 'arc' | 'save' | 'restore' | 'translate' | 'scale' | 'rotate' | 'setTransform' | 'clearRect' | 'drawImage' | 'fillText' | 'font' | 'textAlign' | 'textBaseline' | 'globalAlpha'>;
export interface MinimapSource {
  tileSize: number;
  drawTile(g: Ctx2D, tx: number, tz: number, px: number): void;
  version?(tx: number, tz: number): number;
  labels?(x0: number, z0: number, x1: number, z1: number): MapLabel[];
  /** a click on the large map: the walkable spot to teleport to (null: not here) */
  snap?(x: number, z: number, marker?: MapLabel): { x: number; z: number; yaw: number } | null;
  /** a short name for the hovered place (district, showcase) */
  describe?(x: number, z: number): string;
  /** the large map's legend: [colour or 'dot', text] */
  legend?: [string, string][];
  /** the part of the world worth showing (the large map opens fitted to it, with a margin) */
  extent?(): { minX: number; minZ: number; maxX: number; maxZ: number } | null;
  hidden?: boolean;
}
type Resolver = (level: unknown) => MinimapSource | null;
const resolvers: Resolver[] = [];
/** a level type registers how to map itself (first resolver that returns a source wins) */
export function registerMinimapSource(r: Resolver) {
  resolvers.push(r);
}

/** large map: screen <-> world for a view centred on (vx, vz) at `ppm` px per metre in a W x H canvas */
export function largeToWorld(sx: number, sy: number, vx: number, vz: number, ppm: number, W: number, H: number): [number, number] {
  return [vx + (sx - W / 2) / ppm, vz + (sy - H / 2) / ppm];
}
export function worldToLarge(x: number, z: number, vx: number, vz: number, ppm: number, W: number, H: number): [number, number] {
  return [W / 2 + (x - vx) * ppm, H / 2 + (z - vz) * ppm];
}

export const TILE_PX = 256;
export const MAX_TILES = 64;
/** HUD: how often a composite may fill in a missing tile (Hz) */
export const HUD_HZ = 10;
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

/** HUD: the composited map canvas is HUD_MAP css px square, recomposited after the player moves this far */
export const HUD_MAP = 360;
export const RECOMPOSITE_M = 8;

/** a label's screen box for greedy placement */
interface Box { x0: number; y0: number; x1: number; y1: number }
const hit = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

export class Minimap {
  mode: Mode = 'hud';
  cache = new TileCache();
  /** composites: HUD map canvas rebuilt; draws: large-map draws; frameMs: average cost of update() per frame */
  stats = { tiles: 0, painted: 0, composites: 0, draws: 0, lastMs: 0, avgMs: 0, frameMs: 0, frames: 0 };
  private src: MinimapSource | null = null;
  private hudBox: HTMLDivElement | null = null;
  private hudMap: HTMLCanvasElement | null = null;
  private hudN: HTMLDivElement | null = null;
  private hudName: HTMLDivElement | null = null;
  private big: HTMLCanvasElement | null = null;
  /** where the HUD map canvas is centred (world) and when it was built */
  private anchor = { x: NaN, z: NaN, t: -1 };
  /** the CSS transform last written (qa reads it) */
  hudTransform = '';
  private last = { x: NaN, z: NaN, yaw: NaN, t: -1 };
  private pos = { x: 0, z: 0 };
  private view = { x: 0, z: 0, ppm: 0.5, dirty: true };
  private sourceOf = new WeakMap<object, MinimapSource | null>();
  /** for qa: no DOM, composite / draw into this surface */
  headless: Surface | null = null;
  /** teleport hook (main.ts: the same path the e2e journeys use) */
  onTeleport: ((x: number, z: number, yaw: number) => void) | null = null;
  private hover: { x: number; z: number } | null = null;
  /** the large map's last scale (canvas px per metre) and size, for clicks */
  large = { ppm: 1, W: 1, H: 1, k: 1 };
  private markers: { l: MapLabel; sx: number; sy: number }[] = [];
  /** a tile in view was left unpainted (paint budget): composite again soon */
  private pending = false;

  /**
   * A click on the large map at canvas pixel (sx, sy): snap to a walkable spot (a showcase marker
   * within 14 px wins and the player faces it), teleport, back to the HUD. Returns where it went.
   */
  clickLarge(sx: number, sy: number) {
    const src = this.src;
    if (!src?.snap) return null;
    const { ppm, W, H, k } = this.large;
    const [wx, wz] = largeToWorld(sx, sy, this.view.x, this.view.z, ppm, W, H);
    let mk: MapLabel | undefined, md = 14 * k;
    for (const m of this.markers) {
      const d = Math.hypot(m.sx - sx, m.sy - sy);
      if (m.l.kind === 'showcase' && d < md) (md = d), (mk = m.l);
    }
    const to = src.snap(wx, wz, mk);
    if (!to) return null;
    this.onTeleport?.(to.x, to.z, to.yaw);
    this.mode = 'hud';
    this.anchor.t = -1;
    this.show();
    return to;
  }

  cycle() {
    this.mode = this.mode === 'hud' ? 'large' : this.mode === 'large' ? 'off' : 'hud';
    this.view.dirty = true;
    this.anchor.t = -1;
    if (this.mode === 'large') {
      this.view.x = this.pos.x;
      this.view.z = this.pos.z;
      // a source with a known extent (the museum's explored rooms) opens fitted to it
      const e = this.src?.extent?.();
      if (e) {
        const W = this.headless?.width ?? (typeof innerWidth === 'number' ? innerWidth : 1280);
        const H = this.headless?.height ?? (typeof innerHeight === 'number' ? innerHeight : 720);
        const m = 8;
        this.view.x = (e.minX + e.maxX) / 2;
        this.view.z = (e.minZ + e.maxZ) / 2;
        this.view.ppm = Math.min(4, Math.max(0.12, Math.min(W / (e.maxX - e.minX + 2 * m), H / (e.maxZ - e.minZ + 2 * m))));
      }
      if (typeof document !== 'undefined') document.exitPointerLock?.();
    }
    this.show();
  }

  /**
   * Call every frame. The HUD costs a CSS transform write per frame (the browser composites the
   * rotation on the GPU); its map canvas is rebuilt only after the player moved RECOMPOSITE_M or a
   * tile filled in. The large map redraws on pan/zoom/hover, and a few times a second as you move.
   */
  update(level: unknown, pos: { x: number; z: number }, yaw: number, time: number) {
    const t0 = performance.now();
    const src = this.resolve(level);
    if (src !== this.src) {
      this.src = src;
      this.cache.clear();
      this.anchor.t = -1;
      this.view.dirty = true;
    }
    this.pos.x = pos.x;
    this.pos.z = pos.z;
    this.show();
    if (src && !src.hidden && this.mode !== 'off') {
      if (this.mode === 'large') {
        const moved = Math.hypot(pos.x - this.last.x, pos.z - this.last.z) > 0.25 || Math.abs(yaw - this.last.yaw) > 0.02 || Number.isNaN(this.last.x);
        if (this.view.dirty || (moved && time - this.last.t > 0.25)) {
          this.last.x = pos.x;
          this.last.z = pos.z;
          this.last.yaw = yaw;
          this.last.t = time;
          this.drawLarge(src, pos, yaw);
        }
      } else {
        const far = Math.hypot(pos.x - this.anchor.x, pos.z - this.anchor.z) > RECOMPOSITE_M || Number.isNaN(this.anchor.x) || this.anchor.t < 0;
        if (far || (this.pending && time - this.anchor.t > 1 / HUD_HZ)) this.composite(src, pos, time);
        this.place(pos, yaw);
      }
    }
    const ms = performance.now() - t0;
    if (!this.hudBox && !this.headless && typeof document !== 'undefined') return;
    if (this.stats.frames === 0 && !this.headless) return void (this.stats.frames = 1); // the first frame builds the DOM: not counted
    this.stats.frames++;
    this.stats.frameMs = +(this.stats.frameMs + (ms - this.stats.frameMs) / Math.min(this.stats.frames, 300)).toFixed(4);
  }

  private resolve(level: unknown): MinimapSource | null {
    if (!level || typeof level !== 'object') return null;
    if (this.sourceOf.has(level)) return this.sourceOf.get(level)!;
    let s: MinimapSource | null = null;
    for (const r of resolvers) if ((s = r(level))) break;
    this.sourceOf.set(level, s);
    return s;
  }

  private shown = '';
  private show() {
    if (this.headless || typeof document === 'undefined') return;
    const want = !!this.src && !this.src.hidden;
    if (!this.hudBox) this.buildHud();
    if (!this.big) this.buildLarge();
    // write the styles only when they change (no per-frame style churn)
    const key = `${want}|${this.mode}`;
    if (key === this.shown) return;
    this.shown = key;
    this.hudBox!.style.display = want && this.mode === 'hud' ? 'block' : 'none';
    this.big!.style.display = want && this.mode === 'large' ? 'block' : 'none';
  }

  private buildHud() {
    const box = (this.hudBox = document.createElement('div'));
    box.id = 'minimap';
    Object.assign(box.style, { position: 'fixed', right: '14px', bottom: '14px', width: '180px', height: '180px', borderRadius: '50%', overflow: 'hidden', background: '#26343c', boxShadow: '0 2px 10px rgba(0,0,0,.45)', border: '2px solid rgba(255,255,255,.75)', pointerEvents: 'none', zIndex: '20' });
    const dpr = Math.min(2, devicePixelRatio || 1);
    const map = (this.hudMap = document.createElement('canvas'));
    map.width = map.height = HUD_MAP * dpr;
    Object.assign(map.style, { position: 'absolute', left: '0', top: '0', width: `${HUD_MAP}px`, height: `${HUD_MAP}px`, transformOrigin: '0 0', willChange: 'transform' });
    box.appendChild(map);
    // the view cone and the arrow never move: a fixed SVG over the turning map
    box.insertAdjacentHTML('beforeend', `<svg width="180" height="180" viewBox="0 0 180 180" style="position:absolute;left:0;top:0">
      <path d="M90 90 L${90 + 70 * Math.sin(-0.5)} ${90 - 70 * Math.cos(-0.5)} A70 70 0 0 1 ${90 + 70 * Math.sin(0.5)} ${90 - 70 * Math.cos(0.5)} Z" fill="rgba(255,240,180,.2)"/>
      <path d="M90 82 L95.5 96 L90 93 L84.5 96 Z" fill="#ffd23f" stroke="#1b1b1b" stroke-width="1.5" stroke-linejoin="round"/></svg>`);
    const n = (this.hudN = document.createElement('div'));
    n.textContent = 'N';
    Object.assign(n.style, { position: 'absolute', left: '84px', top: '2px', width: '12px', textAlign: 'center', font: '700 11px system-ui, sans-serif', color: '#e8463c', textShadow: '0 0 3px #000', transformOrigin: '6px 88px' });
    box.appendChild(n);
    const name = (this.hudName = document.createElement('div'));
    Object.assign(name.style, { position: 'absolute', left: '0', right: '0', bottom: '16px', textAlign: 'center', font: '600 10px system-ui, sans-serif', color: '#fff', textShadow: '0 0 3px #000, 0 0 3px #000' });
    box.appendChild(name);
    document.body.appendChild(box);
  }

  /** rebuild the HUD's map canvas around the player (tiles blitted, at most one new tile painted) */
  private composite(src: MinimapSource, pos: { x: number; z: number }, time: number) {
    const t0 = performance.now();
    const surf = this.headless ?? (this.hudMap as unknown as Surface);
    const g = surf?.getContext('2d');
    if (!g) return;
    const S = surf.width, ppm = (S / HUD_MAP) * HUD_PPM;
    this.anchor = { x: pos.x, z: pos.z, t: time };
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#26343c';
    g.fillRect(0, 0, S, S);
    g.setTransform(ppm, 0, 0, ppm, S / 2 - pos.x * ppm, S / 2 - pos.z * ppm);
    const half = S / 2 / ppm;
    this.blit(g, src, pos.x - half, pos.z - half, pos.x + half, pos.z + half, 1, 6);
    if (this.hudName && src.describe) {
      const t = src.describe(pos.x, pos.z).split(' · ')[0];
      if (this.hudName.textContent !== t) this.hudName.textContent = t;
    }
    this.stats.composites++;
    this.done(t0);
  }

  /** per frame: turn and shift the composited map with a CSS transform (no canvas work) */
  private place(pos: { x: number; z: number }, yaw: number) {
    const u0 = HUD_MAP / 2 + (pos.x - this.anchor.x) * HUD_PPM, v0 = HUD_MAP / 2 + (pos.z - this.anchor.z) * HUD_PPM;
    const tf = `translate(90px,90px) rotate(${yaw.toFixed(4)}rad) translate(${(-u0).toFixed(2)}px,${(-v0).toFixed(2)}px)`;
    if (tf === this.hudTransform) return;
    this.hudTransform = tf;
    if (this.hudMap) this.hudMap.style.transform = tf;
    if (this.hudN) this.hudN.style.transform = `rotate(${yaw.toFixed(4)}rad)`;
  }

  private buildLarge() {
    const b = (this.big = document.createElement('canvas'));
    Object.assign(b.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: '30', background: '#1e2b33', cursor: 'crosshair' });
    b.id = 'minimap-large';
    document.body.appendChild(b);
    let drag: { x: number; y: number } | null = null;
    let down: { x: number; y: number; t: number; moved: number } | null = null;
    const k = () => Math.min(2, devicePixelRatio || 1);
    b.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
      b.setPointerCapture(e.pointerId);
    });
    b.addEventListener('pointerup', (e) => {
      // a click, not a pan: little movement and a short press -> go there
      if (down && down.moved < 6 && performance.now() - down.t < 500) this.clickLarge(e.clientX * k(), e.clientY * k());
      drag = null;
      down = null;
    });
    b.addEventListener('pointermove', (e) => {
      const { ppm, W, H } = this.large;
      const [hx, hz] = largeToWorld(e.clientX * k(), e.clientY * k(), this.view.x, this.view.z, ppm, W, H);
      this.hover = { x: hx, z: hz };
      this.view.dirty = true;
      if (down) down.moved = Math.max(down.moved, Math.hypot(e.clientX - down.x, e.clientY - down.y));
      if (!drag || (down && down.moved < 6)) return;
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

  /** blit the tiles covering a world rect into g with the current transform (paints at most `budget` new tiles) */
  private blit(g: Ctx2D, src: MinimapSource, x0: number, z0: number, x1: number, z1: number, budget: number, msBudget = 0) {
    const T = src.tileSize;
    let painted = 0;
    this.pending = false;
    // nearest the view centre first: the tile under the player paints before the corners
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const tiles: [number, number, number][] = [];
    for (let tz = Math.floor(z0 / T); tz <= Math.floor(z1 / T); tz++)
      for (let tx = Math.floor(x0 / T); tx <= Math.floor(x1 / T); tx++) tiles.push([tx, tz, Math.hypot((tx + 0.5) * T - cx, (tz + 0.5) * T - cz)]);
    tiles.sort((a, b) => a[2] - b[2]);
    const t0 = performance.now();
    for (const [tx, tz] of tiles) {
      const before = this.cache.painted;
      // paint new tiles while within the tile budget, or while within the time budget (a slow frame
      // rate must not leave the map empty for seconds)
      const may = painted < budget || (msBudget > 0 && performance.now() - t0 < msBudget);
      const surf = this.cache.get(src, tx, tz, may);
      if (surf) g.drawImage(surf as unknown as CanvasImageSource, tx * T, tz * T, T, T);
      else this.pending = true;
      painted += this.cache.painted - before;
    }
    return tiles.length;
  }

  /** text with a dark halo, greedy-placed: returns false (and draws nothing) when it would collide */
  private label(g: Ctx2D, placed: Box[], text: string, sx: number, sy: number, size: number, color: string, weight = 600) {
    const w = text.length * size * 0.56, h = size * 1.2;
    for (const dy of [0, -h, h]) {
      const b = { x0: sx - w / 2 - 2, y0: sy + dy - h / 2, x1: sx + w / 2 + 2, y1: sy + dy + h / 2 };
      if (placed.some((p) => hit(p, b))) continue;
      placed.push(b);
      g.font = `${weight} ${Math.round(size)}px system-ui, sans-serif`;
      g.lineWidth = Math.max(2, size / 4);
      g.strokeStyle = 'rgba(10,16,20,.85)';
      g.lineJoin = 'round';
      g.strokeText(text, sx, sy + dy);
      g.fillStyle = color;
      g.fillText(text, sx, sy + dy);
      return true;
    }
    return false;
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
    // never more tiles than the cache holds: zoom limits keep the view under ~40 tiles
    const T = src.tileSize;
    const minPpm = (k * Math.sqrt((W * H) / (k * k) / 40)) / T;
    const ppm = Math.max(this.view.ppm, minPpm) * k;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#1e2b33';
    g.fillRect(0, 0, W, H);
    g.setTransform(ppm, 0, 0, ppm, W / 2 - this.view.x * ppm, H / 2 - this.view.z * ppm);
    const x0 = this.view.x - W / 2 / ppm, x1 = this.view.x + W / 2 / ppm, z0 = this.view.z - H / 2 / ppm, z1 = this.view.z + H / 2 / ppm;
    this.blit(g, src, x0, z0, x1, z1, 64);
    this.view.dirty = this.pending;
    g.setTransform(1, 0, 0, 1, 0, 0);
    this.large = { ppm, W, H, k };
    this.markers = [];
    const toS = (x: number, z: number): [number, number] => worldToLarge(x, z, this.view.x, this.view.z, ppm, W, H);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // labels scale gently with zoom; districts first, then showcase names, greedy (no overlaps)
    const zoom = ppm / k;
    const placed: Box[] = [];
    const labels = src.labels?.(x0, z0, x1, z1) ?? [];
    // the HUD-sized legend box and the help line are taken first
    const lg = src.legend ?? [];
    const legendTop = H - (40 + lg.length * 17 + 18) * k;
    placed.push({ x0: 0, y0: legendTop - 4 * k, x1: 236 * k, y1: H }, { x0: 0, y0: H - 30 * k, x1: W, y1: H });
    const dSize = Math.max(11, Math.min(20, 15 * Math.sqrt(zoom / 0.5))) * k;
    for (const l of labels) if (l.kind === 'district') {
      const [sx, sy] = toS(l.x, l.z);
      this.markers.push({ l, sx, sy });
      this.label(g, placed, l.text.toUpperCase(), sx, sy, dSize, '#ffffff', 700);
    }
    for (const l of labels) if (l.kind !== 'district') {
      const [sx, sy] = toS(l.x, l.z);
      this.markers.push({ l, sx, sy });
      g.fillStyle = l.kind === 'door' ? '#7fd1ff' : '#ffd23f';
      g.strokeStyle = '#1b1b1b';
      g.lineWidth = 1.2 * k;
      g.beginPath();
      g.arc(sx, sy, (l.kind === 'door' ? 2 : 4.5) * k, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (l.kind === 'showcase' && zoom > 0.7) this.label(g, placed, l.text, sx, sy - 12 * k, Math.max(10, Math.min(15, 11 * Math.sqrt(zoom))) * k, '#ffe9a8', 500);
    }
    // the player, with its view cone
    const [px, py] = toS(pos.x, pos.z);
    g.save();
    g.translate(px, py);
    g.rotate(-yaw);
    g.fillStyle = 'rgba(255,240,180,.25)';
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, 60 * k, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    g.closePath();
    g.fill();
    g.fillStyle = '#ffd23f';
    g.strokeStyle = '#111';
    g.lineWidth = 1.5 * k;
    g.beginPath();
    g.moveTo(0, -11 * k);
    g.lineTo(7.5 * k, 8 * k);
    g.lineTo(0, 4 * k);
    g.lineTo(-7.5 * k, 8 * k);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    // the hover crosshair with the place's name and coordinates
    if (this.hover) {
      const [hx, hy] = toS(this.hover.x, this.hover.z);
      g.strokeStyle = 'rgba(255,255,255,.9)';
      g.lineWidth = 1.2 * k;
      g.beginPath();
      g.moveTo(hx - 12 * k, hy);
      g.lineTo(hx + 12 * k, hy);
      g.moveTo(hx, hy - 12 * k);
      g.lineTo(hx, hy + 12 * k);
      g.stroke();
      const t = `${src.describe?.(this.hover.x, this.hover.z) ?? ''}  (${Math.round(this.hover.x)}, ${Math.round(this.hover.z)})`;
      this.label(g, [], t, hx + 16 * k + (t.length * 12 * k * 0.56) / 2, hy - 14 * k, 12 * k, '#ffffff', 500);
    }
    // legend
    g.textAlign = 'left';
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = 'rgba(20,28,34,.82)';
    g.fillRect(12 * k, legendTop, 220 * k, (lg.length * 17 + 30) * k);
    lg.forEach(([color, text], i) => {
      const y = H - (40 + (lg.length - i) * 17) * k;
      g.fillStyle = color;
      if (color === 'dot') {
        g.fillStyle = '#ffd23f';
        g.beginPath();
        g.arc(29 * k, y + 6 * k, 4.5 * k, 0, Math.PI * 2);
        g.fill();
      } else g.fillRect(22 * k, y, 14 * k, 12 * k);
      g.fillStyle = '#e8eef2';
      g.font = `500 ${Math.round(11 * k)}px system-ui, sans-serif`;
      g.fillText(text, 44 * k, y + 7 * k);
    });
    g.font = `500 ${Math.round(12 * k)}px system-ui, sans-serif`;
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.fillText('M: close map · click: go there · wheel: zoom · drag: pan', 16 * k, H - 16 * k);
    this.stats.draws++;
    this.done(t0);
  }

  private done(t0: number) {
    const ms = performance.now() - t0;
    const n = this.stats.composites + this.stats.draws;
    this.stats.lastMs = +ms.toFixed(3);
    this.stats.avgMs = +(this.stats.avgMs + (ms - this.stats.avgMs) / Math.min(Math.max(n, 1), 50)).toFixed(3);
    this.stats.tiles = this.cache.size;
    this.stats.painted = this.cache.painted;
  }
}

export const minimap = new Minimap();
if (typeof window !== 'undefined') (window as unknown as { __minimap: Minimap }).__minimap = minimap;
