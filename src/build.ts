import * as THREE from 'three';
import { blobTex, glowTex } from './textures';
import type { Rect } from './level';

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitPlane = new THREE.PlaneGeometry(1, 1);
const unitCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
const matCache = new Map<string, THREE.Material>();

export function mat(color: string, opts: { rough?: number; metal?: number; emissive?: string; ei?: number; map?: THREE.Texture } = {}) {
  const key = `${color}|${opts.rough ?? 0.8}|${opts.metal ?? 0}|${opts.emissive ?? ''}|${opts.ei ?? 1}|${opts.map?.uuid ?? ''}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: opts.rough ?? 0.8,
      metalness: opts.metal ?? 0,
      emissive: opts.emissive ? new THREE.Color(opts.emissive) : new THREE.Color(0),
      emissiveIntensity: opts.ei ?? 1,
      map: opts.map ?? null,
    });
    matCache.set(key, m);
  }
  return m;
}

/** Box from min corner y=0 base: centre (x,z), base at y. */
export function box(material: THREE.Material, w: number, h: number, d: number, x = 0, y = 0, z = 0, shadow = true) {
  const m = new THREE.Mesh(unitBox, material);
  m.scale.set(w, h, d);
  m.position.set(x, y + h / 2, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

export function cyl(material: THREE.Material, r: number, h: number, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(unitCyl, material);
  m.scale.set(r * 2, h, r * 2);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function plane(material: THREE.Material, w: number, d: number, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(unitPlane, material);
  m.rotation.x = -Math.PI / 2;
  m.scale.set(w, d, 1);
  m.position.set(x, y, z);
  m.receiveShadow = true;
  return m;
}

let blobMat: THREE.MeshBasicMaterial | null = null;
export function blob(w: number, d: number, x: number, z: number, y = 0.01) {
  blobMat ??= new THREE.MeshBasicMaterial({ map: blobTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const m = new THREE.Mesh(unitPlane, blobMat);
  m.rotation.x = -Math.PI / 2;
  m.scale.set(w * 1.35, d * 1.35, 1);
  m.position.set(x, y, z);
  m.renderOrder = 1;
  return m;
}

const glowMats = new Map<string, THREE.SpriteMaterial>();
export function glow(color: string, size: number, x: number, y: number, z: number, opacity = 0.9) {
  const key = `${color}|${opacity}`;
  let m = glowMats.get(key);
  if (!m) {
    m = new THREE.SpriteMaterial({ map: glowTex(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
    glowMats.set(key, m);
  }
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  s.position.set(x, y, z);
  return s;
}

/** Box geometry whose UVs are in world units / tile size so shared facade materials tile correctly. */
export function worldUVBox(w: number, h: number, d: number, tileW: number, tileH: number, roofTile = 8) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let f = 0; f < 6; f++) {
    let su = 1, sv = 1;
    if (f === 0 || f === 1) { su = d / tileW; sv = h / tileH; }
    else if (f === 4 || f === 5) { su = w / tileW; sv = h / tileH; }
    else { su = w / roofTile; sv = d / roofTile; }
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    }
  }
  uv.needsUpdate = true;
  return g;
}

/** Rotated footprint (rotation must be a multiple of 90 degrees). */
export function footprint(sx: number, sz: number, rotY: number, cx: number, cz: number): Rect {
  const q = Math.round(rotY / (Math.PI / 2)) & 1;
  const w = q ? sz : sx;
  const d = q ? sx : sz;
  return { minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 };
}

export function rectBox3(r: Rect, y0: number, y1: number, pad = 0) {
  return new THREE.Box3(new THREE.Vector3(r.minX - pad, y0, r.minZ - pad), new THREE.Vector3(r.maxX + pad, y1, r.maxZ + pad));
}
