import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../rng';

/**
 * Generic packaged goods: cereal boxes, cans, bottles, jars, chip bags, cartons, blister
 * cards, paint cans, flower pots. Real shelves are mostly packaging, so these fill the rows the
 * sand3d products don't (and keep the shelves full within the triangle budget). One
 * InstancedMesh per kind for the whole shop, per-instance colour over a printed label.
 */
export interface Kind {
  name: string;
  /** width, height, depth in metres */
  w: number;
  h: number;
  d: number;
  geo: 'box' | 'can' | 'bottle' | 'jar' | 'pot' | 'bag';
  colors: string[];
  metal?: number;
  rough?: number;
}

export const KINDS: Record<string, Kind> = {
  cereal: { name: 'cereal', w: 0.19, h: 0.29, d: 0.065, geo: 'box', colors: ['#f2c400', '#d32f2f', '#1565c0', '#ff8f00', '#6a1b9a', '#2e7d32', '#ffffff'] },
  smallbox: { name: 'smallbox', w: 0.11, h: 0.15, d: 0.05, geo: 'box', colors: ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#ffffff', '#8e24aa', '#00897b', '#f4511e'] },
  pillbox: { name: 'pillbox', w: 0.07, h: 0.12, d: 0.04, geo: 'box', colors: ['#ffffff', '#e3f2fd', '#c62828', '#1565c0', '#2e7d32', '#ffb300'] },
  can: { name: 'can', w: 0.066, h: 0.122, d: 0.066, geo: 'can', colors: ['#c62828', '#1565c0', '#2e7d32', '#f9a825', '#e0e0e0', '#212121', '#6a1b9a', '#ef6c00'], metal: 0.55, rough: 0.3 },
  soup: { name: 'soup', w: 0.075, h: 0.1, d: 0.075, geo: 'can', colors: ['#c62828', '#f5f5f5', '#2e7d32', '#ff8f00'], metal: 0.3, rough: 0.4 },
  bottle: { name: 'bottle', w: 0.065, h: 0.22, d: 0.065, geo: 'bottle', colors: ['#2e7d32', '#c62828', '#1565c0', '#e8f4ff', '#f9a825', '#3e2723', '#00acc1', '#ef6c00'], rough: 0.15 },
  twoliter: { name: 'twoliter', w: 0.105, h: 0.33, d: 0.105, geo: 'bottle', colors: ['#3e2723', '#2e7d32', '#e8f4ff', '#f57f17', '#c62828'], rough: 0.12 },
  jar: { name: 'jar', w: 0.08, h: 0.12, d: 0.08, geo: 'jar', colors: ['#c62828', '#6d4c41', '#f9a825', '#7cb342', '#ffffff'] },
  chips: { name: 'chips', w: 0.22, h: 0.3, d: 0.08, geo: 'bag', colors: ['#f9a825', '#c62828', '#1565c0', '#2e7d32', '#6a1b9a', '#ff6f00'], rough: 0.35 },
  carton: { name: 'carton', w: 0.075, h: 0.2, d: 0.075, geo: 'box', colors: ['#ffffff', '#1565c0', '#c62828', '#ff8f00'] },
  blister: { name: 'blister', w: 0.13, h: 0.2, d: 0.03, geo: 'box', colors: ['#f9a825', '#d32f2f', '#1565c0', '#2e7d32', '#212121', '#ffffff'] },
  toolbox: { name: 'toolbox', w: 0.2, h: 0.12, d: 0.14, geo: 'box', colors: ['#f9a825', '#d32f2f', '#1565c0', '#2e7d32', '#424242'] },
  paint: { name: 'paint', w: 0.17, h: 0.19, d: 0.17, geo: 'can', colors: ['#e0e0e0', '#f5f5f5', '#bdbdbd'], metal: 0.6, rough: 0.35 },
  electro: { name: 'electro', w: 0.16, h: 0.2, d: 0.08, geo: 'box', colors: ['#212121', '#fafafa', '#1565c0', '#37474f', '#c62828'] },
  toybox: { name: 'toybox', w: 0.3, h: 0.24, d: 0.1, geo: 'box', colors: ['#e53935', '#fdd835', '#1e88e5', '#43a047', '#ec407a', '#ff7043', '#7e57c2'] },
  book: { name: 'book', w: 0.16, h: 0.23, d: 0.03, geo: 'box', colors: ['#7a1d1d', '#1d3b5c', '#2e5c2e', '#c9b07a', '#3b2a1d', '#f5f0e6', '#212121'] },
  pot: { name: 'pot', w: 0.18, h: 0.16, d: 0.18, geo: 'pot', colors: ['#b5651d', '#a0522d', '#c97d4a', '#e0d8c8', '#4a4a4a'] },
  carton6: { name: 'carton6', w: 0.2, h: 0.13, d: 0.13, geo: 'box', colors: ['#1565c0', '#c62828', '#2e7d32', '#212121', '#f9a825'] },
};

/** which packaging each kind of shop sells */
export const SHOP_KINDS: Record<string, string[]> = {
  deli: ['cereal', 'smallbox', 'can', 'soup', 'jar', 'chips', 'bottle', 'carton', 'twoliter'],
  pharmacy: ['pillbox', 'smallbox', 'bottle', 'jar', 'carton', 'blister', 'cereal'],
  hardware: ['paint', 'toolbox', 'smallbox', 'blister', 'can', 'carton6'],
  electronics: ['electro', 'smallbox', 'blister'],
  toys: ['toybox', 'smallbox', 'blister'],
  music: ['smallbox', 'blister', 'electro'],
  kitchen: ['smallbox', 'jar', 'carton6', 'toolbox', 'electro'],
  lighting: ['smallbox', 'electro'],
  sports: ['smallbox', 'toybox', 'blister', 'bottle'],
  furniture: ['book', 'jar'],
  antiques: [],
  stationery: ['book', 'smallbox', 'blister', 'pillbox'],
  garden: ['pot', 'pot', 'smallbox'],
  models: ['toybox', 'smallbox'],
  machines: ['smallbox', 'carton6', 'toolbox', 'paint'],
};
/** drinks for coolers */
export const COOLER_KINDS = ['bottle', 'can', 'twoliter', 'carton'];

let labelTex: THREE.CanvasTexture | null = null;
/**
 * Generic printed label, as data: red = printed luminance, green = where the brand colour
 * goes (the rest stays white / ink). Lets one texture dress every product in its own colour.
 */
function label() {
  if (labelTex) return labelTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const rng = new Rng(13);
  const px = (lum: number, tint: number) => `rgb(${Math.round(lum * 255)},${Math.round(tint * 255)},0)`;
  g.fillStyle = px(1, 1); // brand colour all over
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = px(0.55, 1); // darker band at the top
  g.fillRect(0, 0, 256, 46);
  g.fillStyle = px(0.96, 0); // white logo oval
  g.beginPath();
  g.ellipse(128, 104, 84, 44, -0.12, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = px(0.12, 0); // brand name type
  for (let i = 0; i < 3; i++) g.fillRect(64 + rng.next() * 12, 86 + i * 13, 104 + rng.next() * 24, 8);
  g.fillStyle = px(0.98, 0); // white flash
  g.beginPath();
  g.arc(206, 168, 26, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = px(0.9, 0); // info panel
  g.fillRect(18, 186, 160, 58);
  g.fillStyle = px(0.35, 0);
  for (let i = 0; i < 5; i++) g.fillRect(26, 194 + i * 9, 90 + rng.next() * 60, 3);
  g.fillStyle = px(0.05, 0); // barcode
  for (let i = 0; i < 18; i++) g.fillRect(190 + i * 3, 214, 1.5, 22);
  g.fillStyle = px(1, 0);
  g.fillRect(186, 210, 60, 2);
  labelTex = new THREE.CanvasTexture(c);
  labelTex.colorSpace = THREE.NoColorSpace;
  labelTex.anisotropy = 4;
  return labelTex;
}
/** material that reads the label as luminance + tint mask (see label()) */
function labelMat(rough: number, metal: number) {
  const m = new THREE.MeshStandardMaterial({ map: label(), roughness: rough, metalness: metal });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_fragment>', `#ifdef USE_MAP
  vec4 lab = texture2D( map, vMapUv );
  float lum = pow( lab.r, 2.2 );
  #ifdef USE_COLOR
  diffuseColor.rgb *= mix( vec3( lum ), lum * vColor, lab.g );
  #else
  diffuseColor.rgb *= lum;
  #endif
#endif`)
      .replace('#include <color_fragment>', '');
  };
  m.customProgramCacheKey = () => 'shop-label';
  return m;
}

const geos = new Map<string, THREE.BufferGeometry>();
/** unit geometry for a kind (1 x 1 x 1 bounding box, base at y = 0) */
function geometry(k: Kind['geo']) {
  let g = geos.get(k);
  if (g) return g;
  if (k === 'box' || k === 'bag') {
    g = new THREE.BoxGeometry(1, 1, 1, 1, k === 'bag' ? 3 : 1, 1);
    if (k === 'bag') {
      // pillow the bag: thinner at the crimped ends
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i);
        p.setZ(i, p.getZ(i) * (1 - Math.abs(y) * 1.4));
      }
      g.computeVertexNormals();
    }
  } else if (k === 'can' || k === 'jar') {
    g = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1);
  } else if (k === 'bottle') {
    const pts = [[0, 0], [0.5, 0], [0.5, 0.03], [0.5, 0.55], [0.42, 0.68], [0.2, 0.82], [0.16, 0.92], [0.18, 0.93], [0.18, 1], [0, 1]].map(([x, y]) => new THREE.Vector2(x, y - 0.5));
    g = new THREE.LatheGeometry(pts, 8);
  } else {
    // flower pot with a leafy plant on top
    const pts = [[0, 0], [0.36, 0], [0.5, 0.6], [0.5, 0.62], [0, 0.62]].map(([x, y]) => new THREE.Vector2(x, y - 0.5));
    const pot = new THREE.LatheGeometry(pts, 12);
    const leaf = new THREE.IcosahedronGeometry(0.62, 1);
    leaf.scale(1.1, 1.0, 1.1);
    leaf.translate(0, 0.35, 0);
    // vertex colours: terracotta tint applies only to the pot; the plant is green
    const pc = new Float32Array(pot.getAttribute('position').count * 3).fill(1);
    const lc = new Float32Array(leaf.getAttribute('position').count * 3);
    for (let i = 0; i < lc.length; i += 3) {
      lc[i] = 0.18;
      lc[i + 1] = 0.42;
      lc[i + 2] = 0.16;
    }
    pot.setAttribute('color', new THREE.BufferAttribute(pc, 3));
    leaf.setAttribute('color', new THREE.BufferAttribute(lc, 3));
    const potNI = pot.index ? pot.toNonIndexed() : pot;
    const leafNI = leaf.index ? leaf.toNonIndexed() : leaf;
    for (const x of [potNI, leafNI]) if (!x.getAttribute('uv')) x.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(x.getAttribute('position').count * 2), 2));
    g = mergeGeometries([potNI, leafNI], false)!;
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const s = 1 / (bb.max.y - bb.min.y);
    g.translate(0, -bb.min.y, 0);
    g.scale(1, s, 1);
    geos.set(k, g);
    return g;
  }
  g.translate(0, 0.5, 0);
  geos.set(k, g);
  return g;
}

/** Collects filler slots for the whole shop, then builds one InstancedMesh per kind. */
export class Filler {
  private slots = new Map<string, { m: THREE.Matrix4; c: THREE.Color }[]>();
  count = 0;
  add(kind: Kind, p: THREE.Vector3, rot: number, color: string, jitterScale = 1) {
    let list = this.slots.get(kind.name);
    if (!list) this.slots.set(kind.name, (list = []));
    const m = new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(kind.w, kind.h * jitterScale, kind.d));
    const c = new THREE.Color(color);
    // slight variation so a row of the same product doesn't look stamped
    c.multiplyScalar(0.94 + Math.random() * 0.08);
    list.push({ m, c });
    this.count++;
  }
  build(group: THREE.Group) {
    const out: THREE.InstancedMesh[] = [];
    for (const [name, list] of this.slots) {
      const k = KINDS[name];
      const mat = k.geo === 'pot' ? new THREE.MeshStandardMaterial({ roughness: 0.9, vertexColors: true }) : labelMat(k.rough ?? 0.55, k.metal ?? 0);
      const im = new THREE.InstancedMesh(geometry(k.geo), mat, list.length);
      list.forEach((s, i) => {
        im.setMatrixAt(i, s.m);
        im.setColorAt(i, s.c);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.receiveShadow = true;
      group.add(im);
      out.push(im);
    }
    return out;
  }
  tris() {
    let t = 0;
    for (const [name, list] of this.slots) {
      const g = geometry(KINDS[name].geo);
      t += ((g.index ? g.index.count : g.getAttribute('position').count) / 3) * list.length;
    }
    return t;
  }
}
