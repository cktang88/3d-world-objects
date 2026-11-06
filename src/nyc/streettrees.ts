import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../rng';
import { FLAGS } from '../flags';
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
 *  - oak:    pin oak (Quercus palustris): strong central leader, many small limbs along it, the
 *            lower ones drooping, pyramidal crown; smooth grey bark; deeply lobed bristle-tipped leaves.
 *  - ginkgo: narrow, irregular upright crown with sparse ascending limbs; fan-shaped leaves.
 */
export type Species = 'plane' | 'locust' | 'pear' | 'oak' | 'ginkgo';
export const SPECIES: Species[] = ['plane', 'locust', 'pear', 'oak', 'ginkgo'];
/**
 * Relative frequency among these five in the NYC street-tree census (2015: London planetree 12.9%,
 * honeylocust 9.9%, Callery pear 9.0%, pin oak 7.6%, ginkgo 3.7% of all street trees).
 */
export const SPECIES_WEIGHT: Record<Species, number> = { plane: 12.9, locust: 9.9, pear: 9.0, oak: 7.6, ginkgo: 3.7 };
export function pickSpecies(r: Rng): Species {
  let x = r.range(0, SPECIES.reduce((a, s) => a + SPECIES_WEIGHT[s], 0));
  for (const s of SPECIES) if ((x -= SPECIES_WEIGHT[s]) <= 0) return s;
  return 'plane';
}

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
  bark: Species;
  leaf: Species;
  leader: number; // how far the central leader continues (fraction of height)
  limbRange?: number; // fraction of the leader along which scaffold limbs start (default 0.3)
  cone?: number; // higher limbs are this much shorter (pyramidal crowns)
  droop?: number; // extra tilt for the lowest limbs (radians)
  limbLen?: number; // scaffold limb length multiplier (default 1)
}

const SPECS: Record<Species, Spec> = {
  plane: { height: 14, clear: 3.0, r0: 0.27, limbs: [3, 5], limbTilt: [0.55, 0.85], depth: 3, childPer: [4, 5], childAngle: [0.6, 1.05], lenRatio: 0.6, upward: 0.06, card: 1.5, cardsPerTip: 10, bark: 'plane', leaf: 'plane', leader: 0.78 },
  locust: { height: 12, clear: 2.7, r0: 0.21, limbs: [4, 5], limbTilt: [0.55, 0.9], depth: 3, childPer: [3, 5], childAngle: [0.6, 1.0], lenRatio: 0.64, upward: 0.05, card: 1.35, cardsPerTip: 8, bark: 'locust', leaf: 'locust', leader: 0.55 },
  pear: { height: 9, clear: 2.3, r0: 0.19, limbs: [5, 6], limbTilt: [0.3, 0.5], depth: 3, childPer: [3, 4], childAngle: [0.45, 0.8], lenRatio: 0.6, upward: 0.12, card: 1.1, cardsPerTip: 10, bark: 'pear', leaf: 'pear', leader: 0.85 },
  oak: { height: 15, clear: 3.2, r0: 0.23, limbs: [9, 11], limbTilt: [0.95, 1.2], depth: 3, childPer: [3, 4], childAngle: [0.5, 0.9], lenRatio: 0.6, upward: 0.05, limbLen: 0.55, card: 1.3, cardsPerTip: 8, bark: 'oak', leaf: 'oak', leader: 0.97, limbRange: 0.8, cone: 0.6, droop: 0.22 },
  ginkgo: { height: 12, clear: 2.4, r0: 0.18, limbs: [5, 7], limbTilt: [0.4, 0.75], depth: 2, childPer: [3, 4], childAngle: [0.5, 0.9], lenRatio: 0.66, upward: 0.1, card: 1.25, cardsPerTip: 13, bark: 'ginkgo', leaf: 'ginkgo', leader: 0.95, limbRange: 0.6, cone: 0.45 },
};

// ---------------------------------------------------------------- textures

function makeCanvas(w: number, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

/** canvas → DataTexture with the colour bled into transparent pixels (no dark fringes when mip-mapped) */
function bleedTexture(c: HTMLCanvasElement): THREE.Texture {
  if (FLAGS.notex) { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; } // maps are stripped anyway
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

/** pin oak: deep sinuses, bristle-tipped lobes; petiole at origin, leaf along -y, length 1 */
function drawOak(g: CanvasRenderingContext2D, r: Rng) {
  const lobes = [[0.1, 0.22, 0.3, 0.3], [0.07, 0.48, 0.42, 0.5], [0.07, 0.72, 0.3, 0.76]];
  const right: [number, number][] = [[0.04, 0]];
  for (const [sx, sy, tx, ty] of lobes) {
    const j = r.range(0.9, 1.1);
    right.push([sx, -sy], [tx * j * 0.8, -(ty - 0.05)], [tx * j, -ty], [tx * j * 0.75, -(ty + 0.06)]);
  }
  right.push([0.05, -0.9], [0, -1.02]);
  g.beginPath();
  g.moveTo(0, 0);
  for (const [x, y] of right) g.lineTo(x, y);
  for (let i = right.length - 2; i >= 0; i--) g.lineTo(-right[i][0], right[i][1] - 0.02);
  g.closePath();
  g.fill();
}
/** ginkgo: a fan on a long petiole, notched in the middle */
function drawGinkgo(g: CanvasRenderingContext2D) {
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(-0.48, -0.62);
  g.quadraticCurveTo(-0.3, -0.92, -0.04, -0.86);
  g.lineTo(0, -0.74);
  g.lineTo(0.04, -0.86);
  g.quadraticCurveTo(0.3, -0.92, 0.48, -0.62);
  g.closePath();
  g.fill();
}

function leafCanvas(kind: Spec['leaf']) {
  const S = 1024, cell = 512;
  const [c, g] = makeCanvas(S);
  const r = new Rng(kind === 'plane' ? 11 : kind === 'locust' ? 23 : kind === 'oak' ? 41 : kind === 'ginkgo' ? 53 : 37);
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
        const n = kind === 'plane' ? 13 : kind === 'oak' ? 14 : kind === 'ginkgo' ? 22 : 18;
        for (let i = 0; i < n; i++) {
          const t = 0.18 + (i / n) * 0.82;
          const [bx, by] = twig[Math.round(t * 10)];
          const side = i % 2 ? 1 : -1;
          const ang = side * r.range(0.4, 1.2) - Math.PI / 2;
          const pet = kind === 'plane' ? r.range(30, 55) : kind === 'ginkgo' ? r.range(25, 45) : r.range(10, 20);
          const lx = bx + Math.cos(ang) * pet, ly = by + Math.sin(ang) * pet;
          g.strokeStyle = '#6d6a2c';
          g.lineWidth = 3;
          g.beginPath();
          g.moveTo(bx, by);
          g.lineTo(lx, ly);
          g.stroke();
          const size = kind === 'plane' ? r.range(95, 135) : kind === 'oak' ? r.range(85, 115) : kind === 'ginkgo' ? r.range(55, 75) : r.range(60, 80);
          g.save();
          g.translate(lx, ly);
          g.rotate(ang + Math.PI / 2 + r.range(-0.3, 0.3));
          g.scale(size, size);
          const hue = kind === 'plane' ? r.range(78, 98) : kind === 'oak' ? r.range(95, 112) : kind === 'ginkgo' ? r.range(70, 84) : r.range(95, 115);
          const light = kind === 'oak' ? r.range(20, 30) : kind === 'ginkgo' ? r.range(34, 46) : r.range(24, 38);
          const grad = g.createLinearGradient(0, 0, 0, -1);
          grad.addColorStop(0, hsl(hue, 38, light - 4));
          grad.addColorStop(1, hsl(hue - 6, 45, light + 8));
          g.fillStyle = grad;
          if (kind === 'plane') drawPalmate(g, r, r.chance(0.7) ? 5 : 3);
          else if (kind === 'oak') drawOak(g, r);
          else if (kind === 'ginkgo') drawGinkgo(g);
          else {
            g.beginPath();
            g.ellipse(0, -0.5, 0.33, 0.52, 0, 0, Math.PI * 2);
            g.fill();
          }
          // veins
          g.strokeStyle = hsl(hue, 30, light + 14, 0.55);
          g.lineWidth = 0.02;
          g.beginPath();
          const vs = kind === 'plane' ? [-1.25, -0.62, 0, 0.62, 1.25] : kind === 'ginkgo' ? [-0.5, -0.25, 0, 0.25, 0.5] : [0];
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
  return c;
}

function barkCanvas(kind: Spec['bark']) {
  const S = 512;
  const [c, g] = makeCanvas(S);
  const r = new Rng(kind === 'plane' ? 5 : kind === 'locust' ? 6 : kind === 'oak' ? 8 : kind === 'ginkgo' ? 9 : 7);
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
    g.fillStyle = '#66654c';
    g.fillRect(0, 0, S, S);
    const cols = ['#5e5b47', '#7f7b60', '#a19b7b', '#615f49', '#8a8669', '#ada789', '#4b4938', '#76785c', '#6b6f50'];
    for (let i = 0; i < 260; i++) wrapBlob(r.range(0, S), r.range(0, S), r.range(10, 46), r.range(14, 60), r.range(0, 6.28), cols[r.int(0, cols.length - 1)]);
    // fine flecks
    for (let i = 0; i < 4000; i++) {
      g.fillStyle = `rgba(${r.chance(0.5) ? '40,38,30' : '230,226,205'},${r.range(0.05, 0.18)})`;
      g.fillRect(r.range(0, S), r.range(0, S), r.range(1, 3), r.range(1, 4));
    }
  } else {
    // dark grey-brown with vertical furrows and plates
    g.fillStyle = kind === 'locust' ? '#3e3730' : kind === 'oak' ? '#5d5b56' : kind === 'ginkgo' ? '#4a4239' : '#4f4b46';
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

// ---------------------------------------------------------------- wind

/** shared wind clock for every tree material (advanced from onBeforeRender, so it costs nothing when no tree is drawn) */
export const windTime = { value: 0 };
export const wind = { strength: 1 };
const windStrength = { value: 1 };
export function tickWind() {
  windTime.value = performance.now() * 0.001;
  windStrength.value = wind.strength;
}
/**
 * Vertex sway: the whole crown leans with a slow two-frequency gust whose phase comes from the
 * instance's world position (neighbouring trees move out of step); weight grows with height above
 * the trunk so the trunk stays still and twigs move most. Leaves add a fast per-card flutter.
 */
function windShader(sh: THREE.WebGLProgramParametersWithUniforms, leaves: boolean) {
  // (the depth shader has no objectNormal: no flutter there)
  leaves = leaves && sh.vertexShader.includes('beginnormal_vertex>\n\t#include <morphnormal');
  sh.uniforms.uWindTime = windTime;
  sh.uniforms.uWind = windStrength;
  sh.vertexShader = 'uniform float uWindTime;\nuniform float uWind;\n' + sh.vertexShader.replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>
    {
      #if defined( USE_BATCHING )
        vec2 ip = batchingMatrix[3].xz;
      #elif defined( USE_INSTANCING )
        vec2 ip = instanceMatrix[3].xz;
      #else
        vec2 ip = vec2(0.0);
      #endif
      float ph = dot(ip, vec2(0.21, 0.37));
      float h = max(transformed.y - 2.4, 0.0);
      float w = h * h * 0.0011 * uWind;
      float t = uWindTime;
      float gust = 0.6 + 0.4 * sin(t * 0.23 + ph * 0.5);
      vec2 sway = vec2(sin(t * 1.1 + ph) + 0.35 * sin(t * 2.7 + ph * 1.9), 0.6 * sin(t * 0.83 + ph * 1.3) + 0.3 * sin(t * 2.2 + ph)) * w * gust;
      transformed.xz += sway;
      transformed.y -= dot(sway, sway) * 0.5;
      ${leaves ? `float fl = sin(t * 7.3 + dot(transformed, vec3(2.3, 1.7, 3.1)) + ph) * min(h, 4.0) * 0.012 * uWind * gust;
      transformed += objectNormal * fl;` : ''}
    }`,
  );
}

/** species → tile index in the shared atlases */
export const TILE: Record<Species, number> = { plane: 0, locust: 1, pear: 2, oak: 3, ginkgo: 4 };
const NT = SPECIES.length;

/**
 * Bark for every species in ONE material: the bark canvases sit side by side in a strip and the
 * shader wraps each branch's repeating uv inside its species tile (attribute aTile), using the
 * unwrapped uv's derivatives so mip selection has no seams.
 */
let barkShared: THREE.MeshStandardMaterial | null = null;
export function barkMat() {
  if (barkShared) return barkShared;
  const S = 512;
  const [strip, g] = makeCanvas(S * NT, S);
  const [nstrip, ng] = makeCanvas(S * NT, S);
  SPECIES.forEach((sp, i) => {
    const c = barkCanvas(SPECS[sp].bark);
    g.drawImage(c, i * S, 0);
    // normal strength baked per species (plane bark is smoother)
    ng.drawImage(normalFrom(c, sp === 'plane' ? 0.75 : 3.6).image as HTMLCanvasElement, i * S, 0);
  });
  const map = new THREE.CanvasTexture(strip);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const nor = new THREE.CanvasTexture(nstrip);
  const m = new THREE.MeshStandardMaterial({ map, normalMap: nor, roughness: 0.92, metalness: 0 });
  const tile = `vec2 barkTile(vec2 uv) { return vec2((vTile + fract(uv.x)) / ${NT}.0, fract(uv.y)); }\n`;
  m.onBeforeCompile = (sh) => {
    windShader(sh, false);
    sh.vertexShader = 'attribute float aTile;\nvarying float vTile;\n' + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n vTile = aTile;');
    sh.fragmentShader = 'varying float vTile;\n' + sh.fragmentShader
      .replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\n' + tile)
      .replace('texture2D( map, vMapUv )', `textureGrad( map, barkTile( vMapUv ), dFdx( vMapUv ) / vec2(${NT}.0, 1.0), dFdy( vMapUv ) / vec2(${NT}.0, 1.0) )`)
      .replace('texture2D( normalMap, vNormalMapUv )', `textureGrad( normalMap, barkTile( vNormalMapUv ), dFdx( vNormalMapUv ) / vec2(${NT}.0, 1.0), dFdy( vNormalMapUv ) / vec2(${NT}.0, 1.0) )`);
  };
  m.customProgramCacheKey = () => 'nyc-bark';
  return (barkShared = m);
}

/** leaves for every species in ONE alpha-tested atlas (2 × 3 blocks of 2 × 2 cards) */
const LEAF_BLOCK = 768;
let leafShared: THREE.MeshStandardMaterial | null = null;
export function leafMat() {
  if (leafShared) return leafShared;
  const [c, g] = makeCanvas(LEAF_BLOCK * 2, LEAF_BLOCK * 3);
  SPECIES.forEach((sp, i) => g.drawImage(leafCanvas(SPECS[sp].leaf), (i % 2) * LEAF_BLOCK, Math.floor(i / 2) * LEAF_BLOCK, LEAF_BLOCK, LEAF_BLOCK));
  const m = new THREE.MeshStandardMaterial({ map: bleedTexture(c), alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.78, metalness: 0 });
  // the cards carry crown-shaped normals: keep them on the back faces too (soft, volumetric shading)
  m.onBeforeCompile = (sh) => {
    windShader(sh, true);
    sh.fragmentShader = sh.fragmentShader.replace('normal *= faceDirection;', '');
    // a little transmitted light: lift the shadowed side
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * 0.06;');
  };
  m.customProgramCacheKey = () => 'nyc-leaf';
  return (leafShared = m);
}
/**
 * Shadow-pass materials with the same wind sway as the visible trees (the leaves keep their
 * alpha-tested card shapes), so shadows move with the crowns instead of standing still.
 */
const depthMats: Partial<Record<'bark' | 'leaves', THREE.MeshDepthMaterial>> = {};
function treeDepthMat(part: 'bark' | 'leaves') {
  let m = depthMats[part];
  if (!m) {
    m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    if (part === 'leaves') {
      m.map = leafMat().map;
      m.alphaTest = 0.42;
      m.side = THREE.DoubleSide;
    }
    m.onBeforeCompile = (sh) => windShader(sh, false);
    m.customProgramCacheKey = () => `nyc-tree-depth-${part}`;
    depthMats[part] = m;
  }
  return m;
}

/** remap a card geometry's per-species 0..1 uvs into the species' block of the shared leaf atlas */
function toLeafBlock(g: THREE.BufferGeometry, sp: Species) {
  const i = TILE[sp];
  const u0 = (i % 2) / 2, v0 = Math.floor(i / 2) / 3;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) / 2, v0 + uv.getY(k) / 3);
  return g;
}
function withTile(g: THREE.BufferGeometry, sp: Species) {
  g.setAttribute('aTile', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(TILE[sp]), 1));
  return g;
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
  // inner foliage on the last structural branches too
  if (level === spec.depth - 1) tips.push({ p: p.clone(), d: d.clone(), s: 0.7 });
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
  // central leader first, then scaffold limbs starting along it
  const leaderLen = H * spec.leader - spec.clear;
  const li = out.length;
  grow(spec, r, out, tips, trunkTop, lean, leaderLen, rTop * 0.8, 1);
  const leader = out[li];
  const limbs = r.int(spec.limbs[0], spec.limbs[1]);
  const range = spec.limbRange ?? 0.3;
  let az = r.range(0, 6.28);
  for (let i = 0; i < limbs; i++) {
    const f = i / limbs;
    az += 2.4 + r.range(-0.35, 0.35);
    const tilt = r.range(spec.limbTilt[0], spec.limbTilt[1]) + (spec.droop ?? 0) * (1 - f);
    const dir = new THREE.Vector3(Math.cos(az) * Math.sin(tilt), Math.cos(tilt), Math.sin(az) * Math.sin(tilt));
    // point on the leader polyline
    const u = Math.min(0.999, f * range + r.range(0, 0.06)) * (leader.pts.length - 1);
    const k = Math.floor(u);
    const start = leader.pts[k].clone().lerp(leader.pts[k + 1], u - k);
    const rr = THREE.MathUtils.lerp(leader.rad[k], leader.rad[k + 1], u - k);
    const len = (H - spec.clear) * r.range(0.6, 0.72) * (spec.limbLen ?? 1) * (1 - (spec.cone ?? 0) * f);
    grow(spec, r, out, tips, start, dir, len, Math.min(rTop * r.range(0.6, 0.75), rr * 0.85), 1);
  }
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
  withTile(hiBark, species);
  withTile(loBark, species);
  toLeafBlock(hiLeaves, species);
  toLeafBlock(loLeaves, species);
  m = { hi: { bark: hiBark, leaves: hiLeaves }, lo: { bark: loBark, leaves: loLeaves }, bark: barkMat(), leaf: leafMat(), height: H };
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
  b.onBeforeRender = l.onBeforeRender = tickWind;
  b.customDepthMaterial = treeDepthMat('bark');
  l.customDepthMaterial = treeDepthMat('leaves');
  b.receiveShadow = l.receiveShadow = true;
  g.add(b, l);
  return g;
}
void mergeGeometries;

// ---------------------------------------------------------------- impostors

/**
 * Far trees are camera-facing cards cut from an atlas baked at runtime: every species × variant
 * rendered from 8 azimuths (ortho, ambient-lit so the result is ~albedo) into one render target.
 * The card shader picks the two views nearest the camera's angle around the tree and blends them,
 * relights the card with a soft normal, and dithers in over the switch distance.
 */
const IMP_VIEWS = 8, IMP_FRAME = 128, IMP_COLS = 16;
const IMP_MODELS = SPECIES.length * TREE_VARIANTS;
let impRT: THREE.WebGLRenderTarget | null = null;
let impReady = false, impScheduled = false;
const impSize = new Float32Array(IMP_MODELS); // card size (m) per model
const modelIndex = (sp: Species, v: number) => TILE[sp] * TREE_VARIANTS + v;

function bakeImpostors(renderer: THREE.WebGLRenderer) {
  const rows = Math.ceil((IMP_MODELS * IMP_VIEWS) / IMP_COLS);
  const rt = new THREE.WebGLRenderTarget(IMP_COLS * IMP_FRAME, rows * IMP_FRAME, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight('#ffffff', Math.PI)); // radiance = albedo: the card relights it
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const prevRT = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  const prevShadow = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(rt);
  renderer.clear();
  for (const sp of SPECIES)
    for (let v = 0; v < TREE_VARIANTS; v++) {
      const mi = modelIndex(sp, v);
      const tree = treeMesh(sp, v, 'hi');
      tree.traverse((o) => { (o as THREE.Mesh).castShadow = false; });
      scene.add(tree);
      const box = new THREE.Box3().setFromObject(tree);
      const half = Math.max(box.max.x, -box.min.x, box.max.z, -box.min.z);
      const S = Math.max(half * 2, box.max.y) * 1.04;
      impSize[mi] = S;
      cam.left = -S / 2; cam.right = S / 2; cam.top = S; cam.bottom = 0;
      cam.updateProjectionMatrix();
      for (let k = 0; k < IMP_VIEWS; k++) {
        const a = (k / IMP_VIEWS) * Math.PI * 2;
        cam.position.set(Math.sin(a) * 60, 0, Math.cos(a) * 60);
        cam.lookAt(0, 0, 0);
        const f = mi * IMP_VIEWS + k;
        const x = (f % IMP_COLS) * IMP_FRAME, y = Math.floor(f / IMP_COLS) * IMP_FRAME;
        rt.viewport.set(x, y, IMP_FRAME, IMP_FRAME);
        rt.scissor.set(x, y, IMP_FRAME, IMP_FRAME);
        rt.scissorTest = true;
        renderer.setRenderTarget(rt);
        renderer.render(scene, cam);
      }
      scene.remove(tree);
    }
  rt.scissorTest = false;
  rt.viewport.set(0, 0, rt.width, rt.height);
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.autoClear = prevAuto;
  renderer.shadowMap.autoUpdate = prevShadow;
  impRT = rt;
  impReady = true;
  if (impMat) impMat.uniforms.uImp.value = rt.texture;
}
/** bake once, outside any render call, the first time a tree batch is drawn */
function scheduleImpostors(renderer: THREE.WebGLRenderer) {
  if (impScheduled) return;
  impScheduled = true;
  setTimeout(() => bakeImpostors(renderer), 0);
}

let impMat: THREE.ShaderMaterial | null = null;
function impostorMat() {
  if (impMat) return impMat;
  const rows = Math.ceil((IMP_MODELS * IMP_VIEWS) / IMP_COLS);
  impMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, THREE.UniformsLib.lights, { uImp: { value: null }, uSize: { value: impSize } }]),
    lights: true,
    fog: true,
    vertexShader: `
      #include <common>
      #include <fog_pars_vertex>
      attribute vec4 aImp; // model index, yaw, fade, size scale
      uniform float uSize[${IMP_MODELS}];
      varying vec2 vUv;
      varying vec3 vNrm;
      varying float vModel, vView, vFade;
      void main() {
        vec3 origin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec2 toCam = cameraPosition.xz - origin.xz;
        float len = max(length(toCam), 1e-3);
        vec2 dir = toCam / len;
        vec3 right = vec3(dir.y, 0.0, -dir.x);
        float S = uSize[int(aImp.x + 0.5)] * aImp.w;
        vec3 world = origin + right * position.x * S + vec3(0.0, position.y * S, 0.0);
        // view index: camera azimuth in the tree's own frame (bake views look from +z rotating to +x)
        float az = atan(dir.x, dir.y) - aImp.y;
        vView = fract(az / 6.2831853) * ${IMP_VIEWS}.0;
        vModel = aImp.x;
        vFade = aImp.z;
        vUv = uv;
        vNrm = normalize((viewMatrix * vec4(normalize(vec3(dir.x, 0.8, dir.y)), 0.0)).xyz);
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <fog_pars_fragment>
      #include <lights_pars_begin>
      uniform sampler2D uImp;
      varying vec2 vUv;
      varying vec3 vNrm;
      varying float vModel, vView, vFade;
      vec4 frame(float f) {
        float id = vModel * ${IMP_VIEWS}.0 + mod(f, ${IMP_VIEWS}.0);
        vec2 cell = vec2(mod(id, ${IMP_COLS}.0), floor(id / ${IMP_COLS}.0));
        return texture2D(uImp, (cell + vUv) / vec2(${IMP_COLS}.0, ${rows}.0));
      }
      void main() {
        if (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) > vFade) discard;
        float v0 = floor(vView);
        vec4 c = mix(frame(v0), frame(v0 + 1.0), vView - v0);
        if (c.a < 0.45) discard;
        vec3 albedo = c.rgb / max(c.a, 1e-3);
        // simple relighting: hemisphere/ambient + directional lights
        vec3 irr = ambientLightColor;
        #if NUM_HEMI_LIGHTS > 0
          for (int i = 0; i < NUM_HEMI_LIGHTS; i++) irr += getHemisphereLightIrradiance(hemisphereLights[i], vNrm);
        #endif
        #if NUM_DIR_LIGHTS > 0
          for (int i = 0; i < NUM_DIR_LIGHTS; i++) irr += directionalLights[i].color * (0.35 + 0.65 * max(dot(vNrm, directionalLights[i].direction), 0.0));
        #endif
        // 0.58: the bake has no self-shadowing inside the crown (matched by eye to the meshes)
        gl_FragColor = vec4(albedo * irr * RECIPROCAL_PI * 0.58, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  impMat.uniforms.uSize.value = impSize;
  if (impRT) impMat.uniforms.uImp.value = impRT.texture;
  return impMat;
}
const impQuad = (() => {
  const g = new THREE.PlaneGeometry(1, 1);
  g.translate(0, 0.5, 0);
  return g;
})();

// ---------------------------------------------------------------- per-chunk batching

/** per-tree distance (m) where a tree switches to its far model; hysteresis avoids flicker */
export const TREE_LOD_DIST = 75;
const LOD_IN = (TREE_LOD_DIST - 4) ** 2, LOD_OUT = (TREE_LOD_DIST + 4) ** 2;
/** impostors fade in over [IMP_NEAR, IMP_FAR]; beyond IMP_FAR the mesh is hidden */
const impParam = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('impnear') ?? NaN) : NaN; // labs: ?impnear=<m>
export const IMP_NEAR = Number.isFinite(impParam) ? impParam : 118, IMP_FAR = IMP_NEAR + 14;

interface ChunkTrees {
  bark: THREE.BatchedMesh;
  leaves: THREE.BatchedMesh;
  /** geometry ids per model key + lod, in each batched mesh */
  geo: Map<string, { bark: number; leaves: number }>;
  verts: { bark: number; leaves: number; barkI: number; leavesI: number };
  trees: { bark: number; leaves: number; key: string; far: boolean; imp: number; model: number; yaw: number; scale: number; meshOn: boolean; pos: THREE.Vector3; world: THREE.Vector3 | null }[];
  impostors: THREE.InstancedMesh | null;
}

const geoCount = (g: THREE.BufferGeometry) => [g.getAttribute('position').count, g.index ? g.index.count : 0] as const;

function chunkTrees(group: THREE.Object3D): ChunkTrees {
  let ct = group.userData.trees as ChunkTrees | undefined;
  if (ct) return ct;
  const mk = (m: THREE.Material, v: number, i: number, part: 'bark' | 'leaves') => {
    const bm = new THREE.BatchedMesh(32, v, i, m);
    bm.userData.capV = v;
    bm.userData.capI = i;
    bm.customDepthMaterial = treeDepthMat(part);
    bm.castShadow = true;
    bm.receiveShadow = true;
    bm.sortObjects = false;
    bm.userData.owned = true;
    watchDispose(bm);
    group.add(bm);
    return bm;
  };
  ct = {
    bark: mk(barkMat(), 24000, 72000, 'bark'),
    leaves: mk(leafMat(), 32000, 48000, 'leaves'),
    geo: new Map(),
    verts: { bark: 0, leaves: 0, barkI: 0, leavesI: 0 },
    trees: [],
    impostors: null,
  };
  const c = ct;
  // per-tree LOD from the main camera. A draw-less driver mesh (empty draw range, so no draw call)
  // runs first every frame, even when the batches themselves are hidden.
  const camPos = new THREE.Vector3();
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  const lodUpdate = (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => {
    tickWind();
    if (!impReady) scheduleImpostors(renderer);
    camPos.setFromMatrixPosition(camera.matrixWorld);
    let anyMesh = false, anyImp = false, impDirty = false;
    const im = c.impostors;
    for (const t of c.trees) {
      if (!t.world) t.world = t.pos.clone().applyMatrix4(c.leaves.matrixWorld);
      const d = t.world.distanceToSquared(camPos);
      const far = t.far ? d > LOD_IN : d > LOD_OUT;
      if (far !== t.far) {
        t.far = far;
        const g = c.geo.get(`${t.key}|${far ? 'lo' : 'hi'}`)!;
        c.bark.setGeometryIdAt(t.bark, g.bark);
        c.leaves.setGeometryIdAt(t.leaves, g.leaves);
      }
      // impostor band: fade the card in, then drop the mesh
      const dist = Math.sqrt(d);
      const fade = impReady && im ? THREE.MathUtils.clamp((dist - IMP_NEAR) / (IMP_FAR - IMP_NEAR), 0, 1) : 0;
      const meshOn = fade < 1;
      if (meshOn !== t.meshOn) {
        t.meshOn = meshOn;
        c.bark.setVisibleAt(t.bark, meshOn);
        c.leaves.setVisibleAt(t.leaves, meshOn);
      }
      if (meshOn) anyMesh = true;
      if (im && fade > 0) anyImp = true;
      if (im) {
        const attr = im.geometry.getAttribute('aImp') as THREE.InstancedBufferAttribute;
        if (attr.getZ(t.imp) !== fade) {
          attr.setZ(t.imp, fade);
          impDirty = true;
        }
      }
    }
    c.bark.visible = c.leaves.visible = anyMesh;
    if (im) {
      im.visible = anyImp;
      if (impDirty) im.geometry.getAttribute('aImp').needsUpdate = true;
    }
    void mtx; void q; void sc;
  };
  const driver = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  driver.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  driver.geometry.setDrawRange(0, 0);
  driver.frustumCulled = false;
  driver.renderOrder = -1e6;
  driver.userData.owned = true;
  (driver.material as THREE.Material).userData.owned = true;
  driver.onBeforeRender = (renderer, _scene, camera) => lodUpdate(renderer, camera);
  group.add(driver);
  group.userData.trees = c;
  return c;
}

/** one card per tree in the chunk's impostor InstancedMesh (grown by copying) */
function addImpostor(ct: ChunkTrees, group: THREE.Object3D, x: number, y: number, z: number, model: number, yaw: number, scale: number) {
  let im = ct.impostors;
  const n = ct.trees.length;
  if (!im || n >= im.instanceMatrix.count) {
    const cap = im ? im.instanceMatrix.count * 2 : 32;
    const g = impQuad.clone();
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    g.setAttribute('aImp', attr);
    const nim = new THREE.InstancedMesh(g, impostorMat(), cap);
    nim.castShadow = false;
    nim.receiveShadow = false;
    nim.userData.owned = true;
    nim.frustumCulled = true;
    if (im) {
      nim.instanceMatrix.array.set(im.instanceMatrix.array);
      attr.array.set((im.geometry.getAttribute('aImp') as THREE.InstancedBufferAttribute).array);
      im.removeFromParent();
      im.geometry.dispose();
      im.dispose();
    }
    group.add(nim);
    ct.impostors = im = nim;
  }
  im.setMatrixAt(n, new THREE.Matrix4().makeTranslation(x, y, z));
  (im.geometry.getAttribute('aImp') as THREE.InstancedBufferAttribute).setXYZW(n, model, yaw, 0, scale);
  im.count = n + 1;
  im.instanceMatrix.needsUpdate = true;
  im.geometry.getAttribute('aImp').needsUpdate = true;
  // bounds: pad the quad's size (cards up to ~16 m) around the instance positions
  im.boundingSphere = null;
  im.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 8, 0), 12);
  return n;
}

/**
 * disposeTree() disposes the (owned) geometry of a chunk's batches: free the batch's textures with
 * it. BatchedMesh.setGeometrySize() also disposes (and replaces) its geometry while growing, so
 * that case is flagged and the listener moves to the new geometry.
 */
function watchDispose(bm: THREE.BatchedMesh) {
  const g = bm.geometry;
  const onDispose = () => {
    g.removeEventListener('dispose', onDispose);
    if (bm.userData.growing || bm.userData.gone) return;
    bm.userData.gone = true;
    bm.dispose();
  };
  g.addEventListener('dispose', onDispose);
}
function growBatch(bm: THREE.BatchedMesh, v: number, i: number) {
  bm.userData.growing = true;
  try {
    bm.setGeometrySize(v, i);
    bm.userData.capV = v;
    bm.userData.capI = i;
  } finally {
    bm.userData.growing = false;
  }
  watchDispose(bm);
}

/** add both LODs of a model to the chunk's batched meshes (growing them if needed) */
function ensureModel(ct: ChunkTrees, key: string, model: TreeModel) {
  if (ct.geo.has(`${key}|hi`)) return;
  for (const lod of ['hi', 'lo'] as const) {
    const ids = { bark: 0, leaves: 0 };
    for (const part of ['bark', 'leaves'] as const) {
      const bm = ct[part];
      const g = model[lod][part];
      const [v, i] = geoCount(g);
      const vk = part, ik = part === 'bark' ? 'barkI' : 'leavesI';
      const needV = ct.verts[vk] + v, needI = ct.verts[ik] + i;
      const curV = bm.userData.capV as number, curI = bm.userData.capI as number;
      if (needV > curV || needI > curI) growBatch(bm, Math.max(needV, curV * 2), Math.max(needI, curI * 2));
      ids[part] = bm.addGeometry(g);
      ct.verts[vk] = needV;
      ct.verts[ik] = needI;
    }
    ct.geo.set(`${key}|${lod}`, ids);
  }
}

/**
 * Add one tree to a chunk at local (x, y, z). Every species and LOD of the chunk lives in two
 * THREE.BatchedMesh (bark + leaves, both with shared atlases) = 2 draw calls per chunk; each tree
 * switches between its near and far geometry by its own distance to the camera.
 */
export function addTree(group: THREE.Object3D, species: Species, variant: number, x: number, y: number, z: number, rng: Rng) {
  const ct = chunkTrees(group);
  const model = treeModel(species, variant);
  const key = `${species}|${variant}`;
  ensureModel(ct, key, model);
  const s = rng.range(0.82, 1.12);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(UP, rng.range(0, Math.PI * 2)),
    new THREE.Vector3(s * rng.range(0.9, 1.1), s * rng.range(0.92, 1.1), s * rng.range(0.9, 1.1)),
  );
  // individual tint of the foliage
  const tint = new THREE.Color(rng.range(0.85, 1.08), rng.range(0.9, 1.08), rng.range(0.8, 1.0));
  for (const bm of [ct.bark, ct.leaves]) {
    if (bm.instanceCount >= bm.maxInstanceCount) bm.setInstanceCount(bm.maxInstanceCount * 2);
  }
  const g = ct.geo.get(`${key}|hi`)!;
  const ib = ct.bark.addInstance(g.bark);
  const il = ct.leaves.addInstance(g.leaves);
  ct.bark.setMatrixAt(ib, m);
  ct.leaves.setMatrixAt(il, m);
  ct.leaves.setColorAt(il, tint);
  const yaw = Math.atan2(m.elements[8], m.elements[10]);
  const mi = modelIndex(species, variant);
  const imp = addImpostor(ct, group, x, y, z, mi, yaw, s);
  ct.trees.push({ bark: ib, leaves: il, key, far: false, imp, model: mi, yaw, scale: s, meshOn: true, pos: new THREE.Vector3(x, y + model.height * 0.4, z), world: null });
  ct.bark.boundingSphere = ct.leaves.boundingSphere = null;
  ct.bark.boundingBox = ct.leaves.boundingBox = null;
}
