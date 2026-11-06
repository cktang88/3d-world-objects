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

function load(url: string | undefined, srgb: boolean): Promise<THREE.Texture | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    loader.load(
      url,
      (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = maxAniso;
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        resolve(t);
      },
      undefined,
      () => resolve(null),
    );
  });
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
  out.ready = Promise.all([load(pick('diff'), true), load(pick('disp'), false), load(pick('arm'), false), load(pick('nor'), false)]).then(([d, h, a, n]) => {
    out.diff = d;
    out.disp = h;
    out.arm = a;
    out.nor = n;
    if (d) out.mean = meanColor(d);
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
  p.ready.then(() => {
    const rep = (t: THREE.Texture | null) => {
      if (!t) return null;
      const c = t.clone();
      c.repeat.set(size[0] / p.tile[0], size[1] / p.tile[1]);
      c.needsUpdate = true;
      return c;
    };
    m.map = rep(p.diff);
    m.normalMap = rep(p.nor);
    m.normalScale.setScalar(opts.normalScale ?? 1);
    m.roughnessMap = rep(p.arm);
    m.aoMap = m.roughnessMap;
    m.aoMapIntensity = 0.8;
    m.needsUpdate = true;
  });
  return m;
}
