/**
 * Browser shim for running the real level generators in Node (npm run qa).
 * Loaded before every test file (node --import). Provides just enough of document / canvas /
 * Image / fetch / Worker / localStorage for modules to import and build scene graphs:
 * canvases are no-op 1x1, images "load" instantly as 1x1, fetches of local paths are served
 * from public/ on disk and remote fetches fail fast. Sets globalThis.__QA = { notex: true } so
 * code can skip texture/model streaming (see `noTex()` in src/qa.ts).
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const g = globalThis as any;
const ROOT = resolve(process.env.QA_ROOT ?? process.cwd());
const PUBLIC = join(ROOT, 'public');
/** models: false (default: binary assets 404), true (all local files), or a RegExp of allowed public/ paths */
g.__QA = { notex: true, models: (process.env.QA_MODELS === '1') as boolean | RegExp };
const modelAllowed = (path: string) => { const m = g.__QA.models; return m === true || (m instanceof RegExp && m.test(path)); };

const noop = () => {};
const listeners = { addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true };

// ---- 2D context: every method is a no-op; a few return what callers read
function ctx2d(canvas: any): any {
  const state: any = { canvas, font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1 };
  const grad = { addColorStop: noop };
  const special: Record<string, any> = {
    measureText: (t: string) => {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(state.font)?.[1] ?? 10);
      const width = String(t).length * px * 0.55;
      return { width, actualBoundingBoxAscent: px * 0.8, actualBoundingBoxDescent: px * 0.2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width, fontBoundingBoxAscent: px * 0.8, fontBoundingBoxDescent: px * 0.2 };
    },
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createConicGradient: () => grad,
    createPattern: () => ({ setTransform: noop }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h) * 4) }),
    createImageData: (w: any, h?: number) => {
      const W = typeof w === 'number' ? w : w.width, H = typeof w === 'number' ? h! : w.height;
      return { width: W, height: H, data: new Uint8ClampedArray(Math.max(1, W * H) * 4) };
    },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    isPointInPath: () => false,
    getLineDash: () => [],
  };
  return new Proxy(state, {
    get(t, k: string) {
      if (k in special) return special[k];
      if (k in t) return t[k];
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

class FakeCanvas {
  width = 1; height = 1; style: any = {};
  private _ctx: any;
  constructor(w = 1, h = 1) { this.width = w; this.height = h; }
  getContext(type: string) { if (type !== '2d') return null; return (this._ctx ??= ctx2d(this)); }
  toDataURL() { return 'data:image/png;base64,'; }
  toBlob(cb: (b: Blob) => void) { cb(new Blob([])); }
  addEventListener = noop; removeEventListener = noop;
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
  transferControlToOffscreen() { return this; }
}

class FakeImage {
  width = 1; height = 1; naturalWidth = 1; naturalHeight = 1; complete = false; crossOrigin = ''; decoding = '';
  onload: any = null; onerror: any = null;
  private ls: Record<string, Function[]> = {};
  private _src = '';
  addEventListener(t: string, f: Function) { (this.ls[t] ??= []).push(f); }
  removeEventListener(t: string, f: Function) { this.ls[t] = (this.ls[t] ?? []).filter((x) => x !== f); }
  get src() { return this._src; }
  set src(v: string) {
    this._src = v;
    // no textures: every image "loads" at once as 1x1
    setTimeout(() => {
      this.complete = true;
      const e = { type: 'load', target: this };
      this.onload?.(e);
      for (const f of this.ls.load ?? []) f.call(this, e);
    }, 0);
  }
  decode() { return Promise.resolve(); }
}

function element(tag: string): any {
  tag = tag.toLowerCase();
  if (tag === 'canvas') return new FakeCanvas();
  if (tag === 'img') return new FakeImage();
  const el: any = {
    tagName: tag.toUpperCase(), style: {}, dataset: {}, children: [], classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    appendChild: (c: any) => c, removeChild: (c: any) => c, append: noop, remove: noop, prepend: noop, insertBefore: (c: any) => c,
    setAttribute: noop, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }), focus: noop, blur: noop, click: noop,
    innerHTML: '', textContent: '', ...listeners,
  };
  return el;
}

if (typeof g.document === 'undefined') {
  const body = element('body');
  g.document = {
    createElement: element,
    createElementNS: (_ns: string, tag: string) => element(tag),
    getElementById: () => element('div'),
    querySelector: () => null, querySelectorAll: () => [],
    body, documentElement: element('html'), head: element('head'),
    hidden: false, visibilityState: 'visible', pointerLockElement: null, exitPointerLock: noop,
    ...listeners,
  };
}
if (typeof g.window === 'undefined') g.window = g;
if (typeof g.self === 'undefined') g.self = g;
Object.assign(g, {
  innerWidth: g.innerWidth ?? 960, innerHeight: g.innerHeight ?? 540, devicePixelRatio: 1,
  addEventListener: g.addEventListener ?? noop, removeEventListener: g.removeEventListener ?? noop,
});
g.location ??= { search: process.env.QA_SEARCH ?? '', href: 'http://localhost/', origin: 'http://localhost', pathname: '/', hash: '', host: 'localhost', protocol: 'http:' };
g.HTMLCanvasElement ??= FakeCanvas;
g.HTMLImageElement ??= FakeImage;
g.Image ??= FakeImage;
g.ImageBitmap ??= class {};
g.ProgressEvent ??= class { type: string; lengthComputable: boolean; loaded: number; total: number; constructor(type: string, o: any = {}) { this.type = type; this.lengthComputable = !!o.lengthComputable; this.loaded = o.loaded ?? 0; this.total = o.total ?? 0; } };
g.HTMLVideoElement ??= class {};
g.OffscreenCanvas ??= FakeCanvas;
g.createImageBitmap ??= async () => ({ width: 1, height: 1, close: noop });
g.requestAnimationFrame ??= (f: Function) => setTimeout(() => f(performance.now()), 16);
g.cancelAnimationFrame ??= (id: any) => clearTimeout(id);
g.requestIdleCallback ??= (f: Function) => setTimeout(() => f({ timeRemaining: () => 10, didTimeout: false }), 0);
g.matchMedia ??= () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
g.getComputedStyle ??= () => ({ getPropertyValue: () => '' });

// ---- storage
class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
try { if (!g.localStorage || typeof g.localStorage.getItem !== 'function') throw 0; } catch { Object.defineProperty(g, 'localStorage', { value: new MemStorage(), configurable: true }); }
try { if (!g.sessionStorage) throw 0; } catch { Object.defineProperty(g, 'sessionStorage', { value: new MemStorage(), configurable: true }); }

// ---- Worker: never runs; messages vanish
// ---- Worker: never runs; every request is answered at once with an error (callers fall back)
g.Worker = class {
  onmessage: any = null; onerror: any = null; terminate = noop; addEventListener = noop; removeEventListener = noop;
  postMessage(data: any) { setTimeout(() => this.onmessage?.({ data: { id: data?.id, error: 'qa shim: no workers (no remote models)' } }), 0); }
};

// ---- fetch: local paths from public/, remote fails fast (or ?models via QA_MODELS=1 still local only)
const realFetch = g.fetch?.bind(g);
// three's FileLoader builds `new Request('/assets/x.glb')`: relative URLs resolve against the page
const RealRequest = g.Request;
g.Request = class extends RealRequest {
  constructor(input: any, init?: any) { super(typeof input === 'string' && !/^[a-z]+:/i.test(input) ? new URL(input, 'http://localhost/').href : input, init); }
};
export const fetchLog: string[] = [];
g.__qaFetchLog = fetchLog;
g.fetch = async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (/^(data|blob):/.test(url) && realFetch) return realFetch(input, init);
  let path = url;
  if (/^https?:\/\/localhost[:/]/.test(path)) path = new URL(path).pathname;
  if (/^[a-z]+:/i.test(path)) {
    fetchLog.push('remote ' + url);
    throw new TypeError(`qa shim: remote fetch blocked (${url})`);
  }
  path = decodeURIComponent(path.split('?')[0]).replace(/^\/+/, '');
  const file = join(PUBLIC, path);
  fetchLog.push('local ' + path);
  // no textures / no models: binary assets 404 unless QA_MODELS=1
  const binary = /\.(glb|gltf|bin|png|jpe?g|webp|ktx2|hdr|exr|usd[az]?|wasm)$/i.test(path);
  if (!file.startsWith(PUBLIC) || !existsSync(file) || (binary && !modelAllowed(path))) return new Response('not found', { status: 404, statusText: 'Not Found' });
  const buf = await readFile(file);
  const type = path.endsWith('.json') ? 'application/json' : 'application/octet-stream';
  return new Response(buf, { status: 200, headers: { 'content-type': type } });
};

g.navigator ??= {};
try { g.navigator.userAgent ??= 'node-qa'; } catch { /* read-only */ }

// Quiet the expected "remote fetch blocked" / 404 noise unless QA_VERBOSE=1
if (process.env.QA_VERBOSE !== '1') {
  const warn = console.warn.bind(console), err = console.error.bind(console);
  const quiet = (a: unknown[]) => a.some((x) => /qa shim|404|Not Found|Failed to load|THREE\.GLTFLoader|Couldn't load texture/i.test(String((x as any)?.message ?? x)));
  console.warn = (...a: unknown[]) => { if (!quiet(a)) warn(...a); };
  console.error = (...a: unknown[]) => { if (!quiet(a)) err(...a); };
}
