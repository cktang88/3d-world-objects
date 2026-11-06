import * as THREE from 'three';
import { mat } from '../build';
import { surface, pbr, placeholder } from '../pbr';
import { wallpaperTex } from '../textures';
import { marbleTex, subwayTex, hexTex, checkerTex, dropCeilingTex, carpetTileTex, spinesTex, leafTex } from './tex';

/** Interior materials. Tiled ones expect world-metre UVs (see Kit). */

const cache = new Map<string, THREE.Material>();
function memo<T extends THREE.Material>(key: string, make: () => T): T {
  let m = cache.get(key);
  if (!m) cache.set(key, (m = make()));
  return m as T;
}
/** a canvas texture repeating every `metres` */
function tiled(key: string, t: THREE.Texture, metres: number, opts: { rough?: number; color?: string; metal?: number } = {}) {
  return memo(`tiled:${key}:${metres}:${opts.color ?? ''}`, () => {
    const c = t.clone();
    c.repeat.set(1 / metres, 1 / metres);
    c.needsUpdate = true;
    return new THREE.MeshStandardMaterial({ map: c, roughness: opts.rough ?? 0.5, metalness: opts.metal ?? 0, color: opts.color ?? '#ffffff' });
  });
}

/**
 * A PBR floor with its colour and normal maps but a fixed satin roughness: the scanned roughness
 * maps read as wet mirrors under point lights; real oiled or satin-varnished floors do not.
 */
function satin(key: string, color: string, rough: number) {
  return memo(`satin:${key}:${color}:${rough}`, () => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, envMapIntensity: 0.35 });
    const p = pbr(key);
    // compiled once with its maps: 1x1 stand-ins until the photo maps arrive (src/pbr.ts placeholder), so
    // their arrival swaps textures instead of compiling a second shader program
    const ph = p ? placeholder() : null;
    if (ph) {
      m.map = ph.diff;
      m.normalMap = ph.nor;
      m.aoMap = ph.arm;
      m.normalScale.setScalar(0.6);
      m.aoMapIntensity = 0.6;
    }
    p?.ready.then(() => {
      const rep = (t: THREE.Texture | null, fallback: THREE.Texture) => {
        if (!t) return fallback;
        const c = t.clone();
        c.repeat.set(1 / p.tile[0], 1 / p.tile[1]);
        c.needsUpdate = true;
        return c;
      };
      m.map = rep(p.diff, ph!.diff);
      m.normalMap = rep(p.nor, ph!.nor);
      m.aoMap = rep(p.arm, ph!.arm);
    });
    return m;
  });
}

export const M = {
  paint: (color: string) => mat(color, { rough: 0.88 }),
  trim: () => mat('#f5f2ea', { rough: 0.38 }),
  trimDark: () => mat('#3a2a20', { rough: 0.45 }),
  ceiling: () => mat('#f4f2ec', { rough: 0.95 }),
  parquet: () => satin('floor_parquet', '#c8b6a2', 0.52),
  plank: () => satin('floor_laminate', '#ffffff', 0.55),
  oak: (color = '#ffffff') => surface('oak', [1, 1], { color, roughness: 0.55 }),
  walnut: (color = '#ffffff') => surface('walnut', [1, 1], { color, roughness: 0.5 }),
  pine: (color = '#ffffff') => surface('pine', [1, 1], { color, roughness: 0.6 }),
  /** veined marble (procedural, so it never reads as flat white); a dark tint gives Nero Marquina */
  marble: (color = '#ffffff') => {
    const dark = new THREE.Color(color).getHSL({ h: 0, s: 0, l: 0 }).l < 0.5;
    return tiled(`marble${dark}`, marbleTex(dark), 1.2, { rough: 0.18 });
  },
  fabric: (color: string) => surface('fabric', [1, 1], { color, roughness: 0.95 }),
  drape: (color: string) => memo(`drape${color}`, () => new THREE.MeshStandardMaterial({ color, roughness: 0.92, side: THREE.DoubleSide })),
  velvet: (color: string) => surface('velvet', [1, 1], { color, roughness: 0.85 }),
  leather: (color: string) => surface('leather', [1, 1], { color, roughness: 0.55 }),
  carpet: (color: string) => surface('floor_carpet', [1, 1], { color, roughness: 1 }),
  painted: (color: string) => mat(color, { rough: 0.45 }),
  wallpaper: (seed: number, color: string) => tiled(`wp${seed % 4}${color}`, wallpaperTex(color, seed % 4), 0.53, { rough: 0.85 }),
  matte: (color: string) => mat(color, { rough: 0.85 }),
  brass: () => mat('#b8925a', { metal: 1, rough: 0.32 }),
  chrome: () => mat('#dfe2e5', { metal: 1, rough: 0.12 }),
  steel: () => mat('#c3c6c9', { metal: 1, rough: 0.35 }),
  iron: () => mat('#26262a', { metal: 0.6, rough: 0.5 }),
  radiator: () => mat('#cfd0cc', { metal: 0.55, rough: 0.45 }),
  porcelain: () => mat('#f8f8f5', { rough: 0.12 }),
  enamel: (color: string) => mat(color, { rough: 0.2 }),
  black: () => mat('#141416', { rough: 0.5 }),
  screen: () => mat('#07090c', { rough: 0.08, metal: 0.3 }),
  screenOn: () => mat('#20324a', { rough: 0.1, emissive: '#3b5f8c', ei: 0.35 }),
  mirror: () => mat('#e9eef2', { metal: 1, rough: 0.03 }),
  shade: (color = '#f1e4c8') => mat(color, { rough: 0.9, emissive: '#ffcf8f', ei: 0.75 }),
  bulb: () => mat('#fff3dc', { emissive: '#ffe2b0', ei: 2.2 }),
  diffuser: () => mat('#fbf7ee', { emissive: '#fff0d6', ei: 1.6, rough: 0.6 }),
  troffer: () => mat('#f7fbff', { emissive: '#f4f8ff', ei: 1.8, rough: 0.6 }),
  fire: () => mat('#ff8a2a', { emissive: '#ff7a1a', ei: 2.5 }),
  soil: () => mat('#3a2a1e', { rough: 1 }),
  terracotta: () => mat('#b5643f', { rough: 0.85 }),
  glass: () =>
    memo('glass', () => new THREE.MeshStandardMaterial({ color: '#dfeef2', roughness: 0.04, metalness: 0, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide })),
  frosted: () => memo('frosted', () => new THREE.MeshStandardMaterial({ color: '#f4f7f8', roughness: 0.6, transparent: true, opacity: 0.55, depthWrite: false })),
  subway: (color = '#f4f2ec') => tiled(`subway${color}`, subwayTex(color), 0.3, { rough: 0.12 }),
  hex: () => tiled('hex', hexTex(), 0.3, { rough: 0.35 }),
  checker: () => tiled('checker', checkerTex(), 0.6, { rough: 0.3 }),
  dropCeiling: () => tiled('drop', dropCeilingTex(), 1.2, { rough: 0.95 }),
  carpetTile: (color = '#4a4d52') => tiled(`ctile${color}`, carpetTileTex(color), 1, { rough: 1 }),
  spines: (seed: number) =>
    memo(`spines${seed % 6}`, () => new THREE.MeshStandardMaterial({ map: spinesTex(seed % 6), roughness: 0.8, alphaTest: 0.5, side: THREE.DoubleSide })),
  leaf: () => memo('leaf', () => new THREE.MeshStandardMaterial({ map: leafTex(), roughness: 0.6, alphaTest: 0.5, side: THREE.DoubleSide })),
  mapped: (key: string, t: THREE.Texture, rough = 0.9) => memo(`mapped:${key}`, () => new THREE.MeshStandardMaterial({ map: t, roughness: rough })),
  emissiveMap: (key: string, t: THREE.Texture, ei = 1) =>
    memo(`emap:${key}`, () => new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: new THREE.Color('#ffffff'), emissiveIntensity: ei, roughness: 0.9 })),
};
