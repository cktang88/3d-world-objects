import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../rng';
import { normalFrom } from '../textures';

/**
 * NYC street trees: a small procedural tree generator (recursive tapered branches + alpha-tested
 * leaf cards), canvas-painted bark and leaf atlases, and per-chunk instancing with a two-level LOD.
 *
 * Species (see docs/research/nyc-streetscape.md):
 *  - plane:  London plane (Platanus × acerifolia), the most common NYC street tree. Clear trunk to ~3 m,
 *            3–4 ascending scaffold limbs, broad rounded crown, camouflage bark, big palmate leaves.
 *  - locust: thornless honey locust (Gleditsia triacanthos inermis). Vase-shaped, open airy crown,
 *            dark furrowed bark, fine pinnate leaves that cast dappled shade.
 *  - pear:   Callery pear / small ornamental: short trunk, dense upright oval crown.
 */
export type Species = 'plane' | 'locust' | 'pear';
export const SPECIES: Species[] = ['plane', 'locust', 'pear'];

interface Spec {
  height: number;
  clear: number; // first scaffold limb height
  r0: number; // trunk radius at the base (above the flare)
  limbs: [number, number];
  limbTilt: [number, number]; // radians from vertical
  depth: number;
  childPer: [number, number];
  childAngle: [number, number];
  lenRatio: number;
  upward: number; // tropism
  card: number; // leaf card size (m)
  cardsPerTip: number;
  bark: 'plane' | 'locust' | 'pear';
  leaf: 'plane' | 'locust' | 'pear';
  leader: number; // how far the central leader continues (fraction of height)
}

const SPECS: Record<Species, Spec> = {
  plane: { height: 14, clear: 3.0, r0: 0.27, limbs: [3, 5], limbTilt: [0.55, 0.85], depth: 3, childPer: [4, 5], childAngle: [0.6, 1.05], lenRatio: 0.6, upward: 0.06, card: 1.35, cardsPerTip: 9, bark: 'plane', leaf: 'plane', leader: 0.78 },
  locust: { height: 12, clear: 2.7, r0: 0.21, limbs: [4, 5], limbTilt: [0.55, 0.9], depth: 3, childPer: [3, 5], childAngle: [0.6, 1.0], lenRatio: 0.64, upward: 0.05, card: 1.25, cardsPerTip: 7, bark: 'locust', leaf: 'locust', leader: 0.55 },
  pear: { height: 9, clear: 2.3, r0: 0.16, limbs: [5, 6], limbTilt: [0.3, 0.5], depth: 3, childPer: [3, 4], childAngle: [0.45, 0.8], lenRatio: 0.6, upward: 0.12, card: 1.0, cardsPerTip: 9, bark: 'pear', leaf: 'pear', leader: 0.85 },
};

// ---------------------------------------------------------------- textures

function makeCanvas(w: number, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

/** canvas → DataTexture with the colour bled into transparent pixels (no dark fringes when mip-mapped) */
function bleedTexture(c: HTMLCanvasElement) {
  const w = c.width, h = c.height;
  const src = c.getContext('2d')!.getImageData(0, 0, w, h).data;
  const d = new Uint8Array(src.length);
  d.set(src);
  // a few dilation passes of the colour into alpha=0 texels
  let filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = d[i * 4 + 3] > 8 ? 1 : 0;
  for (let pass = 0; pass < 6; pass++) {
    const nf = filled.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (!filled[j]) continue;
          r += d[j * 4]; g += d[j * 4 + 1]; b += d[j * 4 + 2]; n++;
        }
        if (n) {
          d[i * 4] = r / n; d[i * 4 + 1] = g / n; d[i * 4 + 2] = b / n;
          nf[i] = 1;
        }
      }
    filled = nf;
  }
  // remaining holes: average leaf colour
  for (let i = 0; i < w * h; i++) if (!filled[i]) { d[i * 4] = 60; d[i * 4 + 1] = 80; d[i * 4 + 2] = 35; }
  const t = new THREE.DataTexture(d, w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;

/** palmate plane / maple-like leaf, petiole at origin pointing along -y, size ≈ 1 */
function drawPalmate(g: CanvasRenderingContext2D, r: Rng, lobes: number) {
  const angs = lobes === 5 ? [-1.25, -0.62, 0, 0.62, 1.25] : [-0.75, 0, 0.75];
  const lens = lobes === 5 ? [0.55, 0.85, 1, 0.85, 0.55] : [0.75, 1, 0.75];
  g.beginPath();
  angs.forEach((a, i) => {
    const L = lens[i] * r.range(0.9, 1.08);
    const w = 0.34 * L;
    // pointed lobe from the centre
    const ca = Math.cos(a - Math.PI / 2), sa = Math.sin(a - Math.PI / 2);
    const px = (u: number, v: number) => [u * ca - v * sa, u * sa + v * ca] as const;
    const [tx, ty] = px(L, 0);
    const [l1x, l1y] = px(L * 0.45, w);
    const [r1x, r1y] = px(L * 0.45, -w);
    g.moveTo(0, 0);
    g.quadraticCurveTo(l1x, l1y, tx, ty);
    g.quadraticCurveTo(r1x, r1y, 0, 0);
  });
  g.arc(0, -0.12, 0.3, 0, Math.PI * 2);
  g.fill();
}

function leafAtlas(kind: Spec['leaf']) {
  const S = 1024, cell = 512;
  const [c, g] = makeCanvas(S);
  const r = new Rng(kind === 'plane' ? 11 : kind === 'locust' ? 23 : 37);
  for (let cy = 0; cy < 2; cy++)
    for (let cx = 0; cx < 2; cx++) {
      g.save();
      g.beginPath();
      g.rect(cx * cell, cy * cell, cell, cell);
      g.clip();
      g.translate(cx * cell + cell / 2, cy * cell + cell);
      // twig from the bottom centre, curving up
      const twig: [number, number][] = [];
      const bend = r.range(-0.4, 0.4);
      for (let k = 0; k <= 10; k++) {
        const t = k / 10;
        twig.push([Math.sin(t * 2 + bend) * 40 * bend, -t * cell * 0.9]);
      }
      g.strokeStyle = kind === 'locust' ? '#4a3a26' : '#5a4630';
      g.lineWidth = 7;
      g.lineCap = 'round';
      g.beginPath();
      twig.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
      if (kind === 'locust') {
        // pinnately compound leaves: rachis + many small leaflets
        const n = 9;
        for (let i = 0; i < n; i++) {
          const t = 0.15 + (i / n) * 0.85;
          const [bx, by] = twig[Math.round(t * 10)];
          const ang = (i % 2 ? 1 : -1) * r.range(0.5, 1.1) - Math.PI / 2 + r.range(-0.2, 0.2);
          const L = r.range(150, 230);
          const ex = bx + Math.cos(ang) * L, ey = by + Math.sin(ang) * L;
          g.strokeStyle = '#6a7a2a';
          g.lineWidth = 2.5;
          g.beginPath();
          g.moveTo(bx, by);
          g.lineTo(ex, ey);
          g.stroke();
          const pairs = 9;
          for (let p = 1; p <= pairs; p++) {
            const u = p / (pairs + 0.6);
            const lx = bx + (ex - bx) * u, ly = by + (ey - by) * u;
            for (const s of [-1, 1]) {
              const la = ang + s * 1.15;
              const ll = 26 * (1 - u * 0.35);
              g.save();
              g.translate(lx + Math.cos(la) * ll * 0.5, ly + Math.sin(la) * ll * 0.5);
              g.rotate(la);
              g.fillStyle = hsl(r.range(72, 88), r.range(40, 55), r.range(30, 44));
              g.beginPath();
              g.ellipse(0, 0, ll * 0.55, ll * 0.24, 0, 0, Math.PI * 2);
              g.fill();
              g.restore();
            }
          }
        }
      } else {
        const n = kind === 'plane' ? 9 : 16;
        for (let i = 0; i < n; i++) {
          const t = 0.18 + (i / n) * 0.82;
          const [bx, by] = twig[Math.round(t * 10)];
          const side = i % 2 ? 1 : -1;
          const ang = side * r.range(0.4, 1.2) - Math.PI / 2;
          const pet = kind === 'plane' ? r.range(30, 55) : r.range(10, 20);
          const lx = bx + Math.cos(ang) * pet, ly = by + Math.sin(ang) * pet;
          g.strokeStyle = '#6d6a2c';
          g.lineWidth = 3;
          g.beginPath();
          g.moveTo(bx, by);
          g.lineTo(lx, ly);
          g.stroke();
          const size = kind === 'plane' ? r.range(85, 125) : r.range(55, 75);
          g.save();
          g.translate(lx, ly);
          g.rotate(ang + Math.PI / 2 + r.range(-0.3, 0.3));
          g.scale(size, size);
          const hue = kind === 'plane' ? r.range(78, 98) : r.range(95, 115);
          const light = r.range(24, 38);
          const grad = g.createLinearGradient(0, 0, 0, -1);
          grad.addColorStop(0, hsl(hue, 38, light - 4));
          grad.addColorStop(1, hsl(hue - 6, 45, light + 8));
          g.fillStyle = grad;
          if (kind === 'plane') drawPalmate(g, r, r.chance(0.7) ? 5 : 3);
          else {
            g.beginPath();
            g.ellipse(0, -0.5, 0.33, 0.52, 0, 0, Math.PI * 2);
            g.fill();
          }
          // veins
          g.strokeStyle = hsl(hue, 30, light + 14, 0.55);
          g.lineWidth = 0.02;
          g.beginPath();
          const vs = kind === 'plane' ? [-1.25, -0.62, 0, 0.62, 1.25] : [0];
          for (const a of vs) {
            g.moveTo(0, 0);
            g.lineTo(Math.sin(a) * 0.8, -Math.cos(a) * 0.8);
          }
          g.stroke();
          g.restore();
        }
      }
      g.restore();
    }
  return bleedTexture(c);
}

function barkCanvas(kind: Spec['bark']) {
  const S = 512;
  const [c, g] = makeCanvas(S);
  const r = new Rng(kind === 'plane' ? 5 : kind === 'locust' ? 6 : 7);
  const wrapBlob = (x: number, y: number, rx: number, ry: number, rot: number, fill: string) => {
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      g.fillStyle = fill;
      g.beginPath();
      // irregular blob
      const n = 9;
      for (let k = 0; k <= n; k++) {
        const a = (k / n) * Math.PI * 2;
        const rr = 1 + 0.25 * Math.sin(a * 3 + rot * 5) + 0.12 * Math.sin(a * 5 + rot);
        const px = x + ox + Math.cos(a + rot) * rx * rr, py = y + oy + Math.sin(a + rot) * ry * rr;
        k ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.fill();
    }
  };
  if (kind === 'plane') {
    // London plane: exfoliating camouflage of olive, grey-brown and cream patches
    g.fillStyle = '#7a775c';
    g.fillRect(0, 0, S, S);
    const cols = ['#6a6650', '#8f8a6c', '#b3ad8c', '#6d6b52', '#9c9776', '#c4bd9a', '#55523f', '#87896a', '#7a7e5c'];
    for (let i = 0; i < 260; i++) wrapBlob(r.range(0, S), r.range(0, S), r.range(10, 46), r.range(14, 60), r.range(0, 6.28), cols[r.int(0, cols.length - 1)]);
    // fine flecks
    for (let i = 0; i < 4000; i++) {
      g.fillStyle = `rgba(${r.chance(0.5) ? '40,38,30' : '230,226,205'},${r.range(0.05, 0.18)})`;
      g.fillRect(r.range(0, S), r.range(0, S), r.range(1, 3), r.range(1, 4));
    }
  } else {
    // dark grey-brown with vertical furrows and plates
    g.fillStyle = kind === 'locust' ? '#3e3730' : '#4f4b46';
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 70; i++) {
      const x = r.range(0, S);
      g.strokeStyle = `rgba(15,12,10,${r.range(0.4, 0.8)})`;
      g.lineWidth = r.range(2, 6);
      g.beginPath();
      let y = r.range(-60, S);
      let xx = x;
      g.moveTo(xx, y);
      const L = r.range(80, 260);
      for (let s = 0; s < L; s += 12) {
        xx += r.range(-4, 4);
        y += 12;
        g.lineTo(xx, y);
      }
      g.stroke();
    }
    for (let i = 0; i < 160; i++) {
      wrapBlob(r.range(0, S), r.range(0, S), r.range(4, 12), r.range(20, 60), 0, `rgba(${kind === 'locust' ? '110,98,86' : '130,126,120'},${r.range(0.15, 0.4)})`);
    }
    for (let i = 0; i < 3000; i++) {
      g.fillStyle = `rgba(${r.chance(0.5) ? '0,0,0' : '160,150,140'},${r.range(0.05, 0.2)})`;
      g.fillRect(r.range(0, S), r.range(0, S), r.range(1, 2), r.range(1, 5));
    }
  }
  return c;
}

const barkMats = new Map<string, THREE.MeshStandardMaterial>();
function barkMat(kind: Spec['bark']) {
  let m = barkMats.get(kind);
  if (!m) {
    const c = barkCanvas(kind);
    const map = new THREE.CanvasTexture(c);
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.anisotropy = 8;
    const nor = normalFrom(c, kind === 'plane' ? 1.2 : 3);
    nor.wrapS = nor.wrapT = THREE.RepeatWrapping;
    m = new THREE.MeshStandardMaterial({ map, normalMap: nor, roughness: 0.92, metalness: 0 });
    m.normalScale.setScalar(kind === 'plane' ? 0.6 : 1.2);
    barkMats.set(kind, m);
  }
  return m;
}

const leafMats = new Map<string, THREE.MeshStandardMaterial>();
export function leafMat(kind: Spec['leaf']) {
  let m = leafMats.get(kind);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: leafAtlas(kind), alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.78, metalness: 0 });
    // the cards carry crown-shaped normals: keep them on the back faces too (soft, volumetric shading)
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('normal *= faceDirection;', '');
      // a little transmitted light: lift the shadowed side
      sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * 0.06;');
    };
    m.customProgramCacheKey = () => 'nyc-leaf';
    leafMats.set(kind, m);
  }
  return m;
}

// ---------------------------------------------------------------- skeleton → geometry

interface Branch {
  pts: THREE.Vector3[];
  rad: number[];
  level: number;
}

const UP = new THREE.Vector3(0, 1, 0);
function perp(v: THREE.Vector3) {
  const a = Math.abs(v.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0);
  return new THREE.Vector3().crossVectors(v, a).normalize();
}

function grow(spec: Spec, r: Rng, out: Branch[], tips: { p: THREE.Vector3; d: THREE.Vector3; s: number }[], start: THREE.Vector3, dir: THREE.Vector3, len: number, rad: number, level: number) {
  const segs = level === 0 ? 8 : level === 1 ? 6 : level === 2 ? 4 : 3;
  const pts = [start.clone()];
  const rads = [rad];
  const d = dir.clone().normalize();
  const p = start.clone();
  const step = len / segs;
  const tipR = level >= spec.depth ? rad * 0.25 : rad * 0.45;
  for (let i = 1; i <= segs; i++) {
    // tropism + wander
    d.addScaledVector(UP, spec.upward * (level > 0 ? 1 : 0.2));
    d.add(new THREE.Vector3(r.range(-1, 1), r.range(-0.6, 0.6), r.range(-1, 1)).multiplyScalar(level === 0 ? 0.04 : 0.14));
    if (level > 0) d.y -= 0.02 * level; // limbs droop a little with length
    d.normalize();
    p.addScaledVector(d, step);
    pts.push(p.clone());
    rads.push(THREE.MathUtils.lerp(rad, tipR, i / segs));
  }
  out.push({ pts, rad: rads, level });
  if (level >= spec.depth) {
    tips.push({ p: p.clone(), d: d.clone(), s: 1 });
    // also leaves along the outer half of the twig
    tips.push({ p: pts[Math.floor(segs * 0.5)].clone(), d: d.clone(), s: 0.8 });
    return;
  }
  const n = r.int(spec.childPer[0], spec.childPer[1]);
  let az = r.range(0, Math.PI * 2);
  for (let k = 0; k < n; k++) {
    const t = r.range(0.35, 0.95);
    const idx = Math.min(segs - 1, Math.max(1, Math.round(t * segs)));
    const bp = pts[idx];
    const bd = pts[idx + 1].clone().sub(pts[idx]).normalize();
    az += 2.4 + r.range(-0.3, 0.3); // phyllotaxis
    const ax = perp(bd).applyAxisAngle(bd, az);
    const cd = bd.clone().applyAxisAngle(ax, r.range(spec.childAngle[0], spec.childAngle[1]));
    const cl = len * spec.lenRatio * r.range(0.8, 1.15) * (1 - t * 0.3);
    grow(spec, r, out, tips, bp, cd, cl, rads[idx] * 0.72, level + 1);
  }
  // continue the axis
  if (level < spec.depth) {
    grow(spec, r, out, tips, p, d, len * spec.lenRatio * 0.9, tipR * 1.05, level + 1);
  }
}

function skeleton(spec: Spec, seed: number) {
  const r = new Rng(seed);
  const out: Branch[] = [];
  const tips: { p: THREE.Vector3; d: THREE.Vector3; s: number }[] = [];
  const H = spec.height * r.range(0.92, 1.08);
  // trunk to the first limbs, with a slight lean
  const lean = new THREE.Vector3(r.range(-0.05, 0.05), 1, r.range(-0.05, 0.05)).normalize();
  const trunkTop = lean.clone().multiplyScalar(spec.clear);
  const tp: THREE.Vector3[] = [], tr: number[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    tp.push(new THREE.Vector3(trunkTop.x * t + Math.sin(t * 3) * 0.03, spec.clear * t, trunkTop.z * t));
    // root flare at the base
    tr.push(spec.r0 * (1 + 0.55 * Math.exp(-t * 14)) * (1 - 0.18 * t));
  }
  out.push({ pts: tp, rad: tr, level: 0 });
  const rTop = tr[tr.length - 1];
  // central leader
  const leaderLen = H * spec.leader - spec.clear;
  const limbs = r.int(spec.limbs[0], spec.limbs[1]);
  let az = r.range(0, 6.28);
  for (let i = 0; i < limbs; i++) {
    az += (Math.PI * 2) / limbs + r.range(-0.35, 0.35);
    const tilt = r.range(spec.limbTilt[0], spec.limbTilt[1]);
    const dir = new THREE.Vector3(Math.cos(az) * Math.sin(tilt), Math.cos(tilt), Math.sin(az) * Math.sin(tilt));
    const y0 = r.range(0, 0.35) * leaderLen * 0.4;
    const start = trunkTop.clone().add(new THREE.Vector3(0, y0, 0));
    grow(spec, r, out, tips, start, dir, (H - spec.clear) * r.range(0.6, 0.72), rTop * r.range(0.6, 0.75), 1);
  }
  grow(spec, r, out, tips, trunkTop, lean, leaderLen, rTop * 0.8, 1);
  return { branches: out, tips, H };
}

function tubeGeometry(branches: Branch[], maxLevel: number, radial: (level: number) => number) {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const t = new THREE.Vector3(), n = new THREE.Vector3(), b = new THREE.Vector3(), v = new THREE.Vector3();
  for (const br of branches) {
    if (br.level > maxLevel) continue;
    const R = radial(br.level);
    const base = pos.length / 3;
    let normal = perp(br.pts[1].clone().sub(br.pts[0]).normalize());
    let along = 0;
    const circ = Math.PI * 2 * br.rad[0];
    const uRep = Math.max(1, Math.round(circ / 0.6));
    for (let i = 0; i < br.pts.length; i++) {
      const p = br.pts[i];
      if (i < br.pts.length - 1) t.subVectors(br.pts[i + 1], p).normalize();
      else t.subVectors(p, br.pts[i - 1]).normalize();
      if (i > 0) along += p.distanceTo(br.pts[i - 1]);
      // parallel transport
      normal = normal.sub(t.clone().multiplyScalar(normal.dot(t))).normalize();
      b.crossVectors(t, normal);
      for (let j = 0; j <= R; j++) {
        const a = (j / R) * Math.PI * 2;
        n.copy(normal).multiplyScalar(Math.cos(a)).addScaledVector(b, Math.sin(a));
        v.copy(p).addScaledVector(n, br.rad[i]);
        pos.push(v.x, v.y, v.z);
        nor.push(n.x, n.y, n.z);
        uv.push((j / R) * uRep, along / 1.2);
      }
    }
    for (let i = 0; i < br.pts.length - 1; i++)
      for (let j = 0; j < R; j++) {
        const a = base + i * (R + 1) + j, c = a + R + 1;
        idx.push(a, c, a + 1, a + 1, c, c + 1);
      }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function cardGeometry(spec: Spec, tips: { p: THREE.Vector3; d: THREE.Vector3; s: number }[], seed: number, density: number, scale: number, H: number) {
  const r = new Rng(seed);
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  // crown centre for the spherical normals
  const c = new THREE.Vector3();
  for (const t of tips) c.add(t.p);
  c.divideScalar(Math.max(1, tips.length));
  c.y -= H * 0.08;
  const ext = new THREE.Vector3();
  for (const t of tips) ext.max(t.p.clone().sub(c).set(Math.abs(t.p.x - c.x), Math.abs(t.p.y - c.y), Math.abs(t.p.z - c.z)));
  const right = new THREE.Vector3(), up = new THREE.Vector3(), nn = new THREE.Vector3(), q = new THREE.Vector3();
  for (const tip of tips) {
    const count = Math.max(1, Math.round(spec.cardsPerTip * density * tip.s));
    for (let k = 0; k < count; k++) {
      const s = spec.card * scale * r.range(0.75, 1.2);
      const p = tip.p.clone().add(new THREE.Vector3(r.range(-0.5, 0.5), r.range(-0.4, 0.4), r.range(-0.5, 0.5)).multiplyScalar(spec.card * scale * 0.9));
      // card "up" roughly along the twig, with a random roll; hanging a bit
      up.copy(tip.d).add(new THREE.Vector3(r.range(-0.8, 0.8), r.range(-0.6, 0.4), r.range(-0.8, 0.8))).normalize();
      right.crossVectors(up, new THREE.Vector3(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize()).normalize();
      if (right.lengthSq() < 0.01) right.copy(perp(up));
      // crown-shaped normal (ellipsoidal), blended with the true card normal a little
      const off = p.clone().sub(c);
      nn.set(off.x / Math.max(1, ext.x), off.y / Math.max(1, ext.y), off.z / Math.max(1, ext.z)).normalize();
      const fn = new THREE.Vector3().crossVectors(right, up).normalize();
      if (fn.dot(nn) < 0) fn.negate();
      nn.multiplyScalar(0.8).addScaledVector(fn, 0.2).normalize();
      const cell = r.int(0, 3);
      const u0 = (cell % 2) * 0.5, v0 = Math.floor(cell / 2) * 0.5;
      const base = pos.length / 3;
      // the card's base sits on the twig: texture bottom (v=1 in the flipped data texture) at p
      const corners: [number, number, number, number][] = [
        [-0.5, 0, u0, v0 + 0.5],
        [0.5, 0, u0 + 0.5, v0 + 0.5],
        [0.5, 1, u0 + 0.5, v0],
        [-0.5, 1, u0, v0],
      ];
      for (const [cx, cy, cu, cv] of corners) {
        q.copy(p).addScaledVector(right, cx * s).addScaledVector(up, (cy - 0.15) * s);
        pos.push(q.x, q.y, q.z);
        nor.push(nn.x, nn.y, nn.z);
        uv.push(cu, cv);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export interface TreeModel {
  hi: { bark: THREE.BufferGeometry; leaves: THREE.BufferGeometry };
  lo: { bark: THREE.BufferGeometry; leaves: THREE.BufferGeometry };
  bark: THREE.MeshStandardMaterial;
  leaf: THREE.MeshStandardMaterial;
  height: number;
}

const models = new Map<string, TreeModel>();
export const TREE_VARIANTS = 3;
export function treeModel(species: Species, variant: number): TreeModel {
  const key = `${species}|${variant}`;
  let m = models.get(key);
  if (m) return m;
  const spec = SPECS[species];
  const seed = 1000 + variant * 77 + species.length * 13;
  const { branches, tips, H } = skeleton(spec, seed);
  const hiBark = tubeGeometry(branches, 99, (l) => (l === 0 ? 12 : l === 1 ? 8 : l === 2 ? 5 : 4));
  const hiLeaves = cardGeometry(spec, tips, seed + 1, 1, 1, H);
  const loBark = tubeGeometry(branches, 1, (l) => (l === 0 ? 6 : 4));
  // far: fewer, larger cards on a subset of the tips
  const loTips = tips.filter((_, i) => i % 3 === 0);
  const loLeaves = cardGeometry(spec, loTips, seed + 2, 0.5, 2.1, H);
  m = { hi: { bark: hiBark, leaves: hiLeaves }, lo: { bark: loBark, leaves: loLeaves }, bark: barkMat(spec.bark), leaf: leafMat(spec.leaf), height: H };
  for (const g of [hiBark, hiLeaves, loBark, loLeaves]) g.computeBoundingSphere();
  models.set(key, m);
  return m;
}

/** merged (non-instanced) mesh of one tree, for previews */
export function treeMesh(species: Species, variant: number, lod: 'hi' | 'lo' = 'hi') {
  const m = treeModel(species, variant);
  const g = new THREE.Group();
  const b = new THREE.Mesh(m[lod].bark, m.bark);
  const l = new THREE.Mesh(m[lod].leaves, m.leaf);
  b.castShadow = l.castShadow = true;
  b.receiveShadow = l.receiveShadow = true;
  g.add(b, l);
  return g;
}
void mergeGeometries;

// ---------------------------------------------------------------- per-chunk instancing

/** distance (from the chunk's centre) where trees switch to the far model */
export const TREE_LOD_DIST = 95;

interface Batch {
  hiB: THREE.InstancedMesh;
  hiL: THREE.InstancedMesh;
  loB: THREE.InstancedMesh;
  loL: THREE.InstancedMesh;
  n: number;
}

function makeBatch(model: TreeModel, cap: number, lod: THREE.LOD): Batch {
  const mk = (g: THREE.BufferGeometry, m: THREE.Material, level: THREE.Object3D, colors: boolean) => {
    const im = new THREE.InstancedMesh(g, m, cap);
    im.count = 0;
    im.castShadow = true;
    im.receiveShadow = true;
    if (colors) im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    level.add(im);
    return im;
  };
  const [hi, lo] = [lod.levels[0].object, lod.levels[1].object];
  return { hiB: mk(model.hi.bark, model.bark, hi, false), hiL: mk(model.hi.leaves, model.leaf, hi, true), loB: mk(model.lo.bark, model.bark, lo, false), loL: mk(model.lo.leaves, model.leaf, lo, true), n: 0 };
}

function chunkLod(group: THREE.Object3D): THREE.LOD {
  let lod = group.userData.treeLod as THREE.LOD | undefined;
  if (!lod) {
    lod = new THREE.LOD();
    lod.addLevel(new THREE.Group(), 0);
    lod.addLevel(new THREE.Group(), TREE_LOD_DIST);
    group.add(lod);
    group.userData.treeLod = lod;
    group.userData.treeBatches = new Map<string, Batch>();
  }
  return lod;
}

const tmpColor = new THREE.Color();
/**
 * Add one instanced tree to a chunk group at local (x, y, z). Instanced meshes grow as needed;
 * bounding spheres recompute lazily for frustum culling.
 */
export function addTree(group: THREE.Object3D, species: Species, variant: number, x: number, y: number, z: number, rng: Rng) {
  const lod = chunkLod(group);
  const batches = group.userData.treeBatches as Map<string, Batch>;
  const model = treeModel(species, variant);
  const key = `${species}|${variant}`;
  let b = batches.get(key);
  if (!b || b.n >= b.hiB.instanceMatrix.count) {
    const cap = b ? b.n * 2 : 16;
    const nb = makeBatch(model, cap, lod);
    if (b) {
      for (const k of ['hiB', 'hiL', 'loB', 'loL'] as const) {
        nb[k].instanceMatrix.array.set(b[k].instanceMatrix.array);
        if (b[k].instanceColor) nb[k].instanceColor!.array.set(b[k].instanceColor!.array);
        nb[k].count = b.n;
        b[k].removeFromParent();
        b[k].dispose();
      }
      nb.n = b.n;
    }
    b = nb;
    batches.set(key, b);
  }
  const s = rng.range(0.82, 1.12);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(UP, rng.range(0, Math.PI * 2)),
    new THREE.Vector3(s * rng.range(0.9, 1.1), s * rng.range(0.92, 1.1), s * rng.range(0.9, 1.1)),
  );
  // seasonal/individual tint of the foliage
  tmpColor.setHSL(rng.range(-0.02, 0.03), 0, 0);
  const tint = new THREE.Color(rng.range(0.85, 1.08), rng.range(0.9, 1.08), rng.range(0.8, 1.0));
  for (const k of ['hiB', 'hiL', 'loB', 'loL'] as const) {
    b[k].setMatrixAt(b.n, m);
    if (k === 'hiL' || k === 'loL') b[k].setColorAt(b.n, tint);
    b[k].count = b.n + 1;
    b[k].instanceMatrix.needsUpdate = true;
    if (b[k].instanceColor) b[k].instanceColor!.needsUpdate = true;
    b[k].boundingSphere = null;
    b[k].boundingBox = null;
  }
  b.n++;
}
