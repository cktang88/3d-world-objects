import * as THREE from 'three';

/**
 * CC0 PBR textures from Poly Haven and ambientCG (catalogue: public/pbr.json, built by
 * scripts/fetch_pbr.py). Each set knows its real-world size, so it tiles at physical scale.
 */

interface SetInfo {
  dim: [number, number];
  maps: Partial<Record<'diff' | 'disp' | 'arm' | 'nor', Record<string, string>>>;
  /** mean of the roughness channel */
  rough?: number;
}
let catalogue: { kinds: Record<string, string>; sets: Record<string, SetInfo> } | null = null;
let res: '1k' | '2k' = '2k';
let maxAniso = 8;

export async function loadPbr(renderer: THREE.WebGLRenderer) {
  maxAniso = renderer.capabilities.getMaxAnisotropy();
  try {
    catalogue = await (await fetch(`${import.meta.env.BASE_URL}pbr.json`)).json();
  } catch {
    catalogue = null;
  }
}
export function setPbrResolution(r: '1k' | '2k') {
  res = r;
}

export interface PbrMaps {
  key: string;
  /** metres covered by one repeat of the texture */
  tile: [number, number];
  diff: THREE.Texture | null;
  disp: THREE.Texture | null;
  arm: THREE.Texture | null;
  nor: THREE.Texture | null;
  /** linear mean colour of the diffuse map, filled when it loads */
  mean: THREE.Color;
  /** mean roughness of the ARM map's green channel */
  rough: number;
  ready: Promise<void>;
}

const loader = new THREE.TextureLoader();
loader.setCrossOrigin('anonymous');
const sets = new Map<string, PbrMaps>();
/**
 * Images are decoded off the main thread (createImageBitmap) where the browser can: an <img> is decoded
 * synchronously inside the first texImage2D upload (a 1k map cost ~0.7 s on the main thread headless).
 */
/** ?texq=0: the old loading (img decode, displacement maps, maps assigned on arrival) for A/B timing */
const OLD = typeof location !== 'undefined' && /[?&]texq=0(&|$)/.test(location.search);
const bitmaps = !OLD && typeof createImageBitmap !== 'undefined' && typeof fetch !== 'undefined' && !/^((?!chrome|android).)*safari/i.test(typeof navigator !== 'undefined' ? navigator.userAgent : '');
const bitmapLoader = bitmaps ? new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }) : null;
bitmapLoader?.setCrossOrigin('anonymous');

/** load timings (ms since page start) per texture set: requested, images in, applied (window.__texTimings) */
export const texTimings: Record<string, { req: number; loaded?: number; applied?: number; images?: number }> = {};
if (typeof window !== 'undefined') (window as unknown as { __texTimings: typeof texTimings }).__texTimings = texTimings;

function load(url: string | undefined, srgb: boolean): Promise<THREE.Texture | null> {
  if (!url) return Promise.resolve(null);
  const done = (t: THREE.Texture) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = maxAniso;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
  };
  return new Promise((resolve) => {
    if (bitmapLoader)
      bitmapLoader.load(
        url,
        (bmp) => {
          const t = new THREE.Texture(bmp as unknown as HTMLImageElement);
          t.flipY = false; // flipped while decoding (imageOrientation)
          t.needsUpdate = true;
          resolve(done(t));
        },
        undefined,
        () => resolve(null),
      );
    else loader.load(url, (t) => resolve(done(t)), undefined, () => resolve(null));
  });
}

// ---------------------------------------------------------------- applying maps: placeholders, then a queue

/**
 * 1x1 stand-ins for a surface's maps until the real ones arrive: the material is compiled once with all
 * its maps (a material compiled without maps and given them later compiles a second shader program, a
 * stall each time a set arrives), and the photo maps simply replace these textures.
 */
const placeholder = (() => {
  const mk = (r: number, g: number, b: number, srgb: boolean) => {
    const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  let c: { diff: THREE.Texture; nor: THREE.Texture; arm: THREE.Texture } | null = null;
  return () => (c ??= { diff: mk(255, 255, 255, true), nor: mk(128, 128, 255, false), arm: mk(255, 255, 0, false) });
})();

/**
 * Arrived sets are applied in small slices (6 ms, then the next task; the upload itself happens at the
 * next render — forcing it here with renderer.initTexture made each set wait for a whole GPU frame),
 * in the order they were asked for — what the first frames need was asked for first — so a flood of sets
 * landing together does not upload all their images inside one frame.
 */
const applyQueue: (() => void)[] = [];
let pumping = false;
function enqueue(job: () => void) {
  applyQueue.push(job);
  if (pumping) return;
  pumping = true;
  // tasks between frames (not rAF: a slow frame would hold every waiting set back by a whole frame)
  const pump = () => {
    const t0 = performance.now();
    while (applyQueue.length && performance.now() - t0 < 6) applyQueue.shift()!();
    if (applyQueue.length) setTimeout(pump, 0);
    else pumping = false;
  };
  setTimeout(pump, 0);
}


function meanColor(t: THREE.Texture): THREE.Color {
  const img = t.image as CanvasImageSource & { width: number; height: number };
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, 8, 8);
  const d = g.getImageData(0, 0, 8, 8).data;
  let r = 0, gg = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    gg += d[i + 1];
    b += d[i + 2];
  }
  const n = d.length / 4;
  return new THREE.Color().setRGB(r / n / 255, gg / n / 255, b / n / 255, THREE.SRGBColorSpace);
}

/** A texture set by key: a sand3d material kind ("oak") or a surface ("nyc_brick"). */
export function pbr(key: string, resolution = res): PbrMaps | null {
  if (!catalogue) return null;
  const slug = catalogue.kinds[key] ?? key;
  const info = catalogue.sets[slug];
  if (!info) return null;
  const id = `${slug}@${resolution}`;
  let s = sets.get(id);
  if (s) return s;
  // Poly Haven maps stream from its CDN; ambientCG ones are served with the app (relative paths)
  const abs = (u: string | undefined) => (u && !/^https?:/.test(u) ? `${import.meta.env.BASE_URL}${u}` : u);
  const pick = (m: keyof SetInfo['maps']) => abs(info.maps[m]?.[resolution] ?? info.maps[m]?.['1k']);
  const out: PbrMaps = { key, tile: info.dim, diff: null, disp: null, arm: null, nor: null, mean: new THREE.Color(0.5, 0.5, 0.5), rough: info.rough ?? 0.5, ready: Promise.resolve() };
  const tm = (texTimings[id] = { req: Math.round(performance.now()) } as (typeof texTimings)[string]);
  // (displacement maps are not used by anything: not downloaded — a quarter of the boot's images)
  if (OLD) void load(pick('disp'), false);
  out.ready = Promise.all([load(pick('diff'), true), load(pick('arm'), false), load(pick('nor'), false)]).then(([d, a, n]) => {
    out.diff = d;
    out.arm = a;
    out.nor = n;
    if (d) out.mean = meanColor(d);
    tm.loaded = Math.round(performance.now());
    tm.images = [d, a, n].filter(Boolean).length;
  });
  sets.set(id, out);
  return out;
}

/**
 * A standard material for a flat architectural surface whose UVs span `size` metres
 * (u along width, v along height). Maps fill in when they arrive.
 */
const surfCache = new Map<string, THREE.MeshStandardMaterial>();
export function surface(key: string, size: [number, number], opts: { color?: THREE.ColorRepresentation; normalScale?: number; vertexColors?: boolean; envMapIntensity?: number; roughness?: number } = {}) {
  const ck = `${key}|${size[0].toFixed(3)}|${size[1].toFixed(3)}|${opts.color ?? ''}|${opts.vertexColors ?? false}`;
  const hit = surfCache.get(ck);
  if (hit) return hit;
  const m = new THREE.MeshStandardMaterial({ color: opts.color ?? '#ffffff', roughness: opts.roughness ?? 1, metalness: 0, vertexColors: opts.vertexColors ?? false, envMapIntensity: opts.envMapIntensity ?? 0.6 });
  m.userData.pbr = true;
  surfCache.set(ck, m);
  const p = pbr(key);
  if (!p) return m;
  // compiled once, with its maps: 1x1 stand-ins now, the photo maps replace them (no second program)
  const ph = placeholder();
  if (!OLD) {
    m.map = ph.diff;
    m.normalMap = ph.nor;
    m.roughnessMap = ph.arm;
    m.aoMap = ph.arm;
  }
  m.normalScale.setScalar(opts.normalScale ?? 1);
  m.aoMapIntensity = 0.8;
  p.ready.then(() =>
    (OLD ? (f: () => void) => f() : enqueue)(() => {
      const rep = (t: THREE.Texture | null, fallback: THREE.Texture) => {
        if (!t) return fallback;
        const c = t.clone();
        c.repeat.set(size[0] / p.tile[0], size[1] / p.tile[1]);
        c.needsUpdate = true;
        return c;
      };
      m.map = rep(p.diff, ph.diff);
      m.normalMap = rep(p.nor, ph.nor);
      m.roughnessMap = rep(p.arm, ph.arm);
      m.aoMap = m.roughnessMap;
      if (OLD) m.needsUpdate = true;
      const tm = texTimings[`${catalogue?.kinds[key] ?? key}@${res}`];
      if (tm && !tm.applied) tm.applied = Math.round(performance.now());
    }),
  );
  return m;
}
