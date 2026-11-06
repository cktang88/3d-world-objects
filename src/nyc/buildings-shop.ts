import * as THREE from 'three';
import { B, canvasTex } from './common';
import { mat } from '../build';
import { normalFrom } from '../textures';
import { Rng, hashN } from '../rng';
import { roomMaterial, onNight, NIGHT } from './buildings-win';
import type { BCtx, BType, Face } from './buildings';

/** Storefronts: display windows with a shop behind the glass, recessed entries, signs, gates, awnings. */

export const SHOPS: { type: string; names: string[]; pools: string[]; colors: string[] }[] = [
  { type: 'deli', names: ['DELI & GROCERY', 'BODEGA', 'GOURMET DELI', '24HR DELI'], pools: ['food and drink', 'packaging', 'simready:food and drink', 'simready:packaging'], colors: ['#1d5c2e', '#a3201d', '#1e3f8a'] },
  { type: 'hardware', names: ['HARDWARE', 'TOOLS & SUPPLY', 'LOCKSMITH & HARDWARE'], pools: ['hand tool', 'fastener or hardware', 'power tool', 'simready:hand tool'], colors: ['#b5401c', '#2b2b2b'] },
  { type: 'electronics', names: ['ELECTRONICS', 'CAMERAS & PHONES', 'RADIO SHACKLE', 'COMPUTERS'], pools: ['electronics', 'simready:electronics'], colors: ['#14306b', '#111111'] },
  { type: 'toys', names: ['TOYS & GAMES', 'HOBBY SHOP', 'GAME STOP-N-GO'], pools: ['toy or game', 'simready:toy or game'], colors: ['#d6332a', '#1f8a3a', '#f0b400'] },
  { type: 'music', names: ['MUSIC', 'GUITAR CENTER', 'INSTRUMENTS'], pools: ['musical instrument'], colors: ['#3a1f5c', '#111111'] },
  { type: 'kitchen', names: ['KITCHEN SUPPLY', 'HOUSEWARES', 'RESTAURANT SUPPLY'], pools: ['cookware', 'kitchen appliance', 'tableware', 'simready:cookware', 'simready:tableware'], colors: ['#0f5c5c', '#7a1d1d'] },
  { type: 'lighting', names: ['LIGHTING', 'LAMPS', 'LIGHT & DESIGN'], pools: ['lighting', 'simready:lighting'], colors: ['#222222', '#5c4a1d'] },
  { type: 'sports', names: ['SPORTS', 'ATHLETIC', 'BIKES & BOARDS'], pools: ['sports equipment', 'simready:sports equipment'], colors: ['#14306b', '#c4161c'] },
  { type: 'pharmacy', names: ['PHARMACY', 'DRUGS & COSMETICS', 'CHEMIST'], pools: ['medical or personal care', 'simready:medical or personal care'], colors: ['#c4161c', '#0b5ea8'] },
  { type: 'furniture', names: ['FURNITURE', 'HOME & DECOR', 'MODERN HOME'], pools: ['furniture', 'simready:furniture', 'simready:decor'], colors: ['#3b3b3b', '#6b4a2e'] },
  { type: 'antiques', names: ['ANTIQUES', 'CURIOSITIES', 'THRIFT', 'PAWN SHOP'], pools: ['weapon or armour', 'measuring instrument', 'container', 'animal gear'], colors: ['#5c3b1d', '#1d3b2e'] },
  { type: 'stationery', names: ['BOOKS & STATIONERY', 'PAPER & PENS', 'OFFICE SUPPLY'], pools: ['stationery', 'simready:stationery'], colors: ['#1d2f5c', '#5c1d3b'] },
  { type: 'garden', names: ['FLOWERS & GARDEN', 'PLANT SHOP'], pools: ['garden or outdoor'], colors: ['#2e6b2e', '#6b2e5c'] },
  { type: 'models', names: ['MODEL TRAINS & PLANES', 'HOBBY MODELS'], pools: ['vehicle', 'aircraft or spacecraft', 'watercraft'], colors: ['#1d3b5c', '#5c1d1d'] },
  { type: 'machines', names: ['MACHINE PARTS', 'INDUSTRIAL SUPPLY', 'BEARINGS & GEARS'], pools: ['cad', 'machine or industrial', 'automate', 'articraft'], colors: ['#3b3b3b', '#1d4a5c'] },
];
const PREFIX = ['JOE’S', 'LUCKY', 'NEW', 'BIG APPLE', 'EMPIRE', 'MIDTOWN', 'RAY’S', 'GOLDEN', 'ACE', 'METRO', 'PARK', 'CITY', 'BROADWAY', 'LIBERTY', 'STAR', 'UNION'];

// ---------------------------------------------------------------- shop interiors atlas

/** 8 x 2 cells of 512 px: the back wall of each kind of shop, seen through the glass */
let atlasTex: THREE.Texture | null = null;
function shopAtlas() {
  if (atlasTex) return atlasTex;
  const C = 512;
  atlasTex = canvasTex(C * 8, C * 2, (g) => {
    SHOPS.forEach((s, i) => {
      const r = new Rng(hashN(i, 991));
      // row 0 is the bottom of the texture (v = 0): draw it in the lower half of the canvas
      const x0 = (i % 8) * C, y0 = (1 - Math.floor(i / 8)) * C;
      g.save();
      g.translate(x0, y0);
      g.beginPath();
      g.rect(0, 0, C, C);
      g.clip();
      drawShopWall(g, C, s.type, r);
      g.restore();
    });
    // cell 15: an office lobby (marble, a reception desk)
    g.save();
    g.translate(7 * C, 0);
    const gr = g.createLinearGradient(0, 0, 0, C);
    gr.addColorStop(0, '#efe9dc');
    gr.addColorStop(1, '#bdb3a0');
    g.fillStyle = gr;
    g.fillRect(0, 0, C, C);
    g.fillStyle = '#5a4a3a';
    g.fillRect(C * 0.3, C * 0.68, C * 0.4, C * 0.32);
    g.fillStyle = '#c9a65a';
    g.fillRect(C * 0.3, C * 0.68, C * 0.4, 6);
    g.fillStyle = '#3a3a3a';
    g.font = 'bold 40px serif';
    g.textAlign = 'center';
    g.fillText('LOBBY', C / 2, C * 0.3);
    g.restore();
  });
  atlasTex.wrapS = atlasTex.wrapT = THREE.ClampToEdgeWrapping;
  return atlasTex;
}

function drawShopWall(g: CanvasRenderingContext2D, C: number, type: string, r: Rng) {
  const wallCol = r.pick(['#f1ece0', '#e6e0d2', '#dfe6e8', '#efe4cc']);
  g.fillStyle = wallCol;
  g.fillRect(0, 0, C, C);
  const palettes: Record<string, string[]> = {
    deli: ['#c0392b', '#f1c40f', '#27ae60', '#e67e22', '#2980b9', '#ecf0f1'],
    pharmacy: ['#ffffff', '#2980b9', '#e74c3c', '#ecf0f1', '#9b59b6', '#1abc9c'],
    toys: ['#e74c3c', '#f1c40f', '#3498db', '#2ecc71', '#9b59b6', '#e67e22'],
    hardware: ['#d35400', '#7f8c8d', '#c0392b', '#f39c12', '#2c3e50'],
    garden: ['#27ae60', '#2ecc71', '#16a085', '#8e6d3a', '#e84393'],
    default: ['#c0392b', '#27ae60', '#2980b9', '#f1c40f', '#e67e22', '#8e44ad', '#ecf0f1', '#2c3e50', '#16a085'],
  };
  const pal = palettes[type] ?? palettes.default;
  if (type === 'deli') {
    // drinks fridges with glass doors along the back
    for (let x = 0; x < C; x += C / 4) {
      g.fillStyle = '#2a2d30';
      g.fillRect(x + 4, C * 0.12, C / 4 - 8, C * 0.8);
      g.fillStyle = '#e8f4ff';
      g.fillRect(x + 12, C * 0.15, C / 4 - 24, C * 0.74);
      for (let y = C * 0.2; y < C * 0.85; y += C * 0.12) {
        for (let bx = x + 16; bx < x + C / 4 - 24; bx += 12) {
          g.fillStyle = r.pick(pal);
          g.fillRect(bx, y, 9, C * 0.09);
        }
        g.fillStyle = '#9aa';
        g.fillRect(x + 12, y + C * 0.09, C / 4 - 24, 3);
      }
    }
    g.fillStyle = '#c9302c';
    g.fillRect(0, C * 0.04, C, C * 0.06);
    return;
  }
  if (type === 'electronics') {
    for (let y = C * 0.15; y < C * 0.8; y += C * 0.2)
      for (let x = 12; x < C - 60; x += 90 + r.int(0, 20)) {
        g.fillStyle = '#111';
        g.fillRect(x, y, 80, 52);
        const gr = g.createLinearGradient(x, y, x + 80, y + 52);
        gr.addColorStop(0, `hsl(${r.int(0, 360)},70%,55%)`);
        gr.addColorStop(1, `hsl(${r.int(0, 360)},70%,35%)`);
        g.fillStyle = gr;
        g.fillRect(x + 4, y + 4, 72, 44);
      }
  }
  if (type === 'garden') {
    for (let k = 0; k < 40; k++) {
      g.fillStyle = r.pick(pal);
      g.beginPath();
      g.arc(r.range(0, C), r.range(C * 0.3, C), r.range(20, 60), 0, Math.PI * 2);
      g.fill();
    }
  }
  if (type === 'furniture' || type === 'lighting' || type === 'antiques') {
    for (let k = 0; k < 6; k++) {
      g.fillStyle = r.pick(['#6b4a2e', '#3b3b3b', '#a08060', '#2c3e50', '#7f8c8d']);
      const w = r.range(60, 160), h = r.range(50, 140);
      const x = r.range(0, C - w);
      g.fillRect(x, C - h - 20, w, h);
      if (type === 'lighting') {
        g.fillStyle = '#fff3c4';
        g.beginPath();
        g.arc(r.range(40, C - 40), r.range(40, C * 0.4), 18, 0, Math.PI * 2);
        g.fill();
      }
    }
    return;
  }
  // gondola shelving packed with goods
  for (let y = C * 0.18; y < C * 0.95; y += C * 0.16) {
    g.fillStyle = '#9a9a96';
    g.fillRect(0, y, C, 6);
    let x = 4;
    while (x < C - 10) {
      const w = r.int(10, 30), h = r.int(25, Math.floor(C * 0.13));
      g.fillStyle = r.pick(pal);
      g.fillRect(x, y - h, w, h);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(x + 2, y - h + 4, w - 4, 4);
      x += w + r.int(1, 4);
    }
  }
  if (type === 'hardware') {
    g.fillStyle = 'rgba(120,90,60,0.25)';
    g.fillRect(0, 0, C, C * 0.16);
  }
}

// ---------------------------------------------------------------- shop glass batch

/** shop windows of a block, merged into one mesh drawing the shop behind the glass */
export class ShopGlass {
  pos: number[] = [];
  nor: number[] = [];
  anc: number[] = [];
  size: number[] = [];
  info: number[] = [];
  room: number[] = [];
  /** a pane in face space (bottom-left at u,y; z offset), facing out */
  add(m: THREE.Matrix4, w: number, h: number, cell: number, depth: number, seed: number, lit = 1, blind = 0) {
    const n = new THREE.Vector3(0, 0, 1).transformDirection(m);
    const c = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
    for (const [a, b] of c) {
      const p = new THREE.Vector3(a * w, b * h, 0).applyMatrix4(m);
      this.pos.push(p.x, p.y, p.z);
      this.nor.push(n.x, n.y, n.z);
      this.anc.push(a, b);
      this.size.push(w, h);
      this.info.push(seed, lit, blind, 0);
      this.room.push(depth, cell, 0.95, 0);
    }
  }
  build(parent: THREE.Object3D) {
    if (!this.pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aAnchor', new THREE.Float32BufferAttribute(this.anc, 2));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.anc, 2));
    g.setAttribute('aSizeV', new THREE.Float32BufferAttribute(this.size, 2));
    g.setAttribute('aInfoV', new THREE.Float32BufferAttribute(this.info, 4));
    g.setAttribute('aRoomV', new THREE.Float32BufferAttribute(this.room, 4));
    const o = new THREE.Mesh(g, shopGlassMat());
    o.receiveShadow = true;
    o.userData.owned = true;
    parent.add(o);
  }
}
let sgm: THREE.MeshStandardMaterial | null = null;
const shopGlassMat = () => (sgm ??= roomMaterial(true, shopAtlas()));

// ---------------------------------------------------------------- lettering

/**
 * Sign lettering from one shared glyph atlas: every letter is a quad, so all the signs, awnings
 * and window lettering of a block draw in one call. Colours ride on vertex colours; signs glow
 * at night (setNight).
 */
const FONTS = ['bold 76px Helvetica, Arial, sans-serif', 'bold 76px Georgia, "Times New Roman", serif', 'italic bold 76px Georgia, serif', 'bold 76px "Arial Narrow", Arial, sans-serif'];
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789&’\'.-!$#@:/,abcdefghijklmnopqrstuvwxyz ';
const CW = 64, CH = 96;
let glyphs: { tex: THREE.Texture; adv: Map<string, number>; cols: number } | null = null;
function glyphAtlas() {
  if (glyphs) return glyphs;
  const cols = 16;
  const per = GLYPHS.length;
  const rows = Math.ceil((per * FONTS.length) / cols);
  const adv = new Map<string, number>();
  const tex = canvasTex(cols * CW, rows * CH, (g) => {
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#ffffff';
    FONTS.forEach((f, fi) => {
      g.font = f;
      for (let i = 0; i < per; i++) {
        const k = fi * per + i;
        const x = (k % cols) * CW, y = Math.floor(k / cols) * CH;
        const ch = GLYPHS[i];
        const w = g.measureText(ch).width;
        const sx = fi === 3 ? 0.72 : 1;
        const fit = Math.min(1, (CW - 4) / (w * sx));
        adv.set(fi + ch, Math.max(0.25, ((w * sx * fit) / CW)));
        g.save();
        g.translate(x + CW / 2, y + CH * 0.8);
        g.scale(sx * fit, 1);
        g.textAlign = 'center';
        g.fillText(ch, 0, 0);
        g.restore();
      }
    });
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  glyphs = { tex, adv, cols };
  return glyphs;
}

let textMats: { sign: THREE.MeshStandardMaterial; neon: THREE.MeshStandardMaterial } | null = null;
function vcEmissive(m: THREE.MeshStandardMaterial, key: string) {
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance *= vColor;');
  };
  m.customProgramCacheKey = () => 'vcEmissive:' + key;
  return m;
}
function textMaterials() {
  if (textMats) return textMats;
  const t = glyphAtlas().tex;
  textMats = {
    sign: vcEmissive(new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.45, vertexColors: true, roughness: 0.5, emissive: '#ffffff', emissiveMap: t, emissiveIntensity: 0.15 }), 'sign'),
    neon: vcEmissive(new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.3, vertexColors: true, roughness: 0.3, emissive: '#ffffff', emissiveMap: t, emissiveIntensity: 2.2, toneMapped: false }), 'neon'),
  };
  onNight((f) => {
    textMats!.sign.emissiveIntensity = 0.15 + f * 1.6;
    textMats!.neon.emissiveIntensity = 2.0 + f * 2.5;
  });
  return textMats;
}

/** lit sign panels (lightboxes): emissive takes the vertex colour, brighter at night */
let litPanel: THREE.MeshStandardMaterial | null = null;
export function litPanelMat() {
  if (litPanel) return litPanel;
  litPanel = vcEmissive(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, emissive: '#ffffff', emissiveIntensity: 0.2 }), 'panel');
  onNight((f) => (litPanel!.emissiveIntensity = 0.2 + f * 1.4));
  return litPanel;
}

export class TextBatch {
  sets = { sign: { p: [] as number[], u: [] as number[], c: [] as number[] }, neon: { p: [] as number[], u: [] as number[], c: [] as number[] } };
  /** text centred at (x, y) in the frame `m`, glyph height h, squeezed to fit maxW */
  add(m: THREE.Matrix4, text: string, x: number, y: number, z: number, h: number, maxW: number, color: string, font = 0, kind: 'sign' | 'neon' = 'sign') {
    const G = glyphAtlas();
    const set = this.sets[kind];
    const col = new THREE.Color(color);
    const chars = [...text].filter((ch) => GLYPHS.includes(ch));
    const gw = h * (CW / CH);
    let total = 0;
    for (const ch of chars) total += (G.adv.get(font + ch) ?? 0.5) * gw * 1.05;
    const sx = total > maxW ? maxW / total : 1;
    let cx = x - (total * sx) / 2;
    const v = new THREE.Vector3();
    for (const ch of chars) {
      const a = (G.adv.get(font + ch) ?? 0.5) * gw * 1.05 * sx;
      if (ch !== ' ') {
        const k = font * GLYPHS.length + GLYPHS.indexOf(ch);
        const rows = Math.ceil((GLYPHS.length * FONTS.length) / G.cols);
        const u0 = (k % G.cols) / G.cols, u1 = u0 + 1 / G.cols;
        const v1 = 1 - Math.floor(k / G.cols) / rows, v0 = v1 - 1 / rows;
        const mid = cx + a / 2, hw = (gw / 2) * sx;
        const quad = [[mid - hw, y - h / 2, u0, v0], [mid + hw, y - h / 2, u1, v0], [mid + hw, y + h / 2, u1, v1], [mid - hw, y - h / 2, u0, v0], [mid + hw, y + h / 2, u1, v1], [mid - hw, y + h / 2, u0, v1]];
        for (const [qx, qy, qu, qv] of quad) {
          v.set(qx, qy, z).applyMatrix4(m);
          set.p.push(v.x, v.y, v.z);
          set.u.push(qu, qv);
          set.c.push(col.r, col.g, col.b);
        }
      }
      cx += a;
    }
  }
  build(parent: THREE.Object3D) {
    const M = textMaterials();
    for (const k of ['sign', 'neon'] as const) {
      const s = this.sets[k];
      if (!s.p.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(s.p, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(s.u, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(s.c, 3));
      g.computeVertexNormals();
      const o = new THREE.Mesh(g, M[k]);
      o.userData.owned = true;
      parent.add(o);
    }
  }
}

// ---------------------------------------------------------------- roll-down gates

const gateMats: THREE.MeshStandardMaterial[] = [];
function gateMat(i: number) {
  if (gateMats[i]) return gateMats[i];
  const r = new Rng(77 + i);
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  // corrugated slats: a light crest and a dark groove every 10 cm
  for (let y = 0; y < 256; y += 16) {
    const gr = g.createLinearGradient(0, y, 0, y + 16);
    gr.addColorStop(0, '#5c5f62');
    gr.addColorStop(0.35, '#b9bcbe');
    gr.addColorStop(0.7, '#8c8f92');
    gr.addColorStop(1, '#3a3c3e');
    g.fillStyle = gr;
    g.fillRect(0, y, 256, 16);
  }
  const nrm = normalFrom(c, 3);
  if (i > 0) {
    // graffiti tags and painted murals over the slats
    for (let k = 0; k < 6; k++) {
      g.strokeStyle = `hsl(${r.int(0, 360)},80%,${r.int(35, 60)}%)`;
      g.lineWidth = r.range(4, 12);
      g.lineCap = 'round';
      g.beginPath();
      let x = r.range(20, 200), y = r.range(40, 220);
      g.moveTo(x, y);
      for (let s = 0; s < 6; s++) g.quadraticCurveTo(x + r.range(-40, 40), y + r.range(-40, 40), (x += r.range(-10, 40)), (y += r.range(-30, 30)));
      g.stroke();
    }
    if (i === 2) {
      g.fillStyle = 'rgba(30,30,30,0.85)';
      g.font = 'bold 44px sans-serif';
      g.fillText(r.pick(['NO PARKING', 'OPEN 7AM', 'KEEP CLEAR', 'ESTD 1978']), 10, 140);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  gateMats[i] = new THREE.MeshStandardMaterial({ map: t, normalMap: nrm, roughness: 0.55, metalness: 0.55 });
  return gateMats[i];
}

function gatePlane(parent: THREE.Object3D, w: number, h: number, x: number, y: number, z: number, variant: number) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / 1.6, (uv.getY(i) * h) / 1.6);
  const o = new THREE.Mesh(g, gateMat(variant));
  o.position.set(x, y + h / 2, z);
  o.castShadow = true;
  parent.add(o);
}

// ---------------------------------------------------------------- the storefront

function titleCaseName(s: string) {
  return s.toLowerCase().replace(/(^|[\s&-])(\w)/g, (_, a, b) => a + b.toUpperCase());
}
function shade(hex: string, f: number) {
  return `#${new THREE.Color(hex).multiplyScalar(f).getHexString()}`;
}

/**
 * One shopfront between u0 and u1 of a face, from the pavement up to `top`:
 * pilasters, a sign band, display windows over a bulkhead, a recessed glass door, and
 * sometimes a roll-down gate (open or shut), an awning, a projecting blade sign and neon.
 */
export function storefront(ctx: BCtx, F: Face, u0: number, u1: number, top: number, addr: string, btype: BType) {
  const { rng } = ctx;
  const shopIdx = rng.int(0, SHOPS.length - 1);
  const shop = SHOPS[shopIdx];
  const name = `${rng.chance(0.5) ? rng.pick(PREFIX) + ' ' : ''}${rng.pick(shop.names)}`;
  const color = rng.pick(shop.colors);
  const W = u1 - u0, uc = (u0 + u1) / 2;
  const G = F.g, Fi = F.f;
  const frameC = rng.pick(['#1c1c1c', '#2e3b2e', '#4a2a1e', '#d8d2c4', '#3a3f44', color, '#7a7d80']);
  const frameM = mat(frameC, { rough: 0.45, metal: 0.35 });
  const alu = mat('#9ea3a8', { rough: 0.35, metal: 0.85 });
  const T = ctx.text;
  const font = rng.int(0, 3);
  const gate = rng.chance(btype === 'castiron' ? 0.25 : 0.45);
  const closed = gate && rng.chance(0.3);
  const halfShut = gate && !closed && rng.chance(0.15);
  const signKind = rng.pick(['board', 'board', 'lightbox', 'letters'] as const);
  const awningKind = rng.chance(0.5) ? rng.pick(['slope', 'slope', 'box'] as const) : 'none';

  // ---- pilasters framing the shop
  for (const s of [-1, 1]) {
    B(G, frameM, 0.22, top, 0.14, uc + s * (W / 2 - 0.11), 0, 0.07);
    B(Fi, frameM, 0.3, 0.12, 0.2, uc + s * (W / 2 - 0.11), top - 1.0, 0.1, false);
  }
  // ---- sign band
  const sb0 = top - 0.95;
  B(G, frameM, W, 0.95, 0.16, uc, sb0, 0.08);
  B(G, mat(shade(frameC, 1.3), { rough: 0.5 }), W + 0.06, 0.07, 0.24, uc, top - 0.05, 0.12, false);
  const signW = W - 0.6;
  if (signKind === 'lightbox') {
    // internally lit box sign, white face with coloured letters
    const p = B(G, litPanelMat(), signW, 0.72, 0.22, uc, sb0 + 0.12, 0.27);
    p.userData.tint = rng.pick(['#f4f1ea', '#fff8e0', color]);
    const face = p.userData.tint === color ? '#ffffff' : color;
    T.add(F.m, name, uc, sb0 + 0.48, 0.385, 0.48, signW - 0.4, face, font);
  } else if (signKind === 'letters') {
    // individual letters on the fascia
    T.add(F.m, name, uc, sb0 + 0.48, 0.17, 0.56, signW, rng.pick(['#f4efe2', '#d9b25a', '#ffffff', '#e8d9b0']), font);
  } else {
    const p = B(G, mat(color, { rough: 0.6 }), signW, 0.76, 0.04, uc, sb0 + 0.1, 0.18);
    void p;
    T.add(F.m, name, uc, sb0 + 0.48, 0.205, 0.46, signW - 0.3, rng.pick(['#f7f1e3', '#ffffff', '#f2d27a']), font);
  }
  // street number on the transom
  // ---- below the sign: gate housing or a transom
  let dispTop = sb0;
  if (gate) {
    B(G, mat('#7c7f82', { rough: 0.5, metal: 0.6 }), W - 0.44, 0.38, 0.36, uc, sb0 - 0.38, 0.18);
    dispTop = sb0 - 0.38;
  }
  // ---- entry layout
  const doorW = 1.05, bayW = doorW + 0.5;
  const doorAt = W < 3.5 ? 0 : rng.pick([0, -1, 1]) * (W / 2 - 0.22 - bayW / 2 - 0.05);
  const du = uc + doorAt;
  const recess = rng.chance(0.75) ? rng.range(0.6, 1.3) : 0.12;
  const bulk = rng.range(0.35, 0.6);
  const glassZ = -0.1;
  const transom = dispTop - 0.55;
  // display windows either side of the entry bay
  const segs: [number, number][] = [[u0 + 0.22, du - bayW / 2], [du + bayW / 2, u1 - 0.22]];
  const cell = shopIdx;
  const seed = rng.next();
  const lit = rng.chance(0.85) ? 1 : 0;
  for (const [a, b] of segs) {
    if (b - a < 0.3) continue;
    const pw = b - a;
    // bulkhead with a sunk panel
    B(G, frameM, pw, bulk, 0.2, (a + b) / 2, 0, 0.0);
    B(Fi, mat(shade(frameC, 0.8), { rough: 0.6 }), pw - 0.2, bulk - 0.16, 0.02, (a + b) / 2, 0.08, 0.105, false);
    B(G, frameM, pw, 0.06, 0.26, (a + b) / 2, bulk, 0.0, false);
    // the glass, with a room behind it
    ctx.shop.add(F.m.clone().multiply(new THREE.Matrix4().makeTranslation(a, bulk + 0.06, glassZ)), pw, transom - bulk - 0.06, cell, rng.range(4.5, 7), seed, lit);
    ctx.shop.add(F.m.clone().multiply(new THREE.Matrix4().makeTranslation(a, transom + 0.06, glassZ)), pw, dispTop - transom - 0.06, cell, rng.range(4.5, 7), seed, lit, 0.0);
    // mullions
    B(G, frameM, pw, 0.07, 0.12, (a + b) / 2, transom, glassZ + 0.04, false);
    const nm = Math.max(0, Math.round(pw / 1.8) - 1);
    for (let k = 1; k <= nm; k++) B(Fi, frameM, 0.05, transom - bulk, 0.08, a + (pw * k) / (nm + 1), bulk, glassZ + 0.04, false);
    for (let k = 1; k <= nm + 1; k++) B(Fi, frameM, 0.04, dispTop - transom, 0.06, a + (pw * k) / (nm + 2), transom, glassZ + 0.04, false);
    // window lettering and neon
    if (rng.chance(0.35)) T.add(F.m, rng.pick(['OPEN', 'OPEN', 'ATM', 'LOTTO', 'COLD BEER', 'SALE', 'WE DELIVER']), a + pw * rng.range(0.3, 0.7), transom - 0.45, glassZ + 0.02, 0.26, pw * 0.6, rng.pick(['#ff3a2a', '#ff5ad1', '#4ad8ff', '#ffd23a']), 0, 'neon');
    if (rng.chance(0.3)) T.add(F.m, rng.pick(['EST. 1962', 'SINCE 1987', 'FREE DELIVERY', 'OPEN 7 DAYS', 'CASH ONLY']), a + pw / 2, transom - 0.12, glassZ + 0.02, 0.1, pw * 0.7, '#e8d9a8', 1);
  }
  // recessed entry: return walls, ceiling, mosaic floor, glass door at the back
  if (recess > 0.2) {
    const doorZ = -recess;
    for (const s of [-1, 1]) {
      const wu = du + (s * bayW) / 2;
      // glazed returns above a bulkhead
      const rm = new THREE.Matrix4().makeRotationY((-s * Math.PI) / 2); // glass faces into the recess
      const base = F.m.clone().multiply(new THREE.Matrix4().makeTranslation(wu, 0, 0)).multiply(rm);
      B(G, frameM, 0.08, bulk, recess, wu, 0, -recess / 2, false);
      ctx.shop.add(base.clone().multiply(new THREE.Matrix4().makeTranslation(s > 0 ? -recess : 0, bulk, 0)), recess, transom - bulk, cell, 3, seed, lit);
      B(G, frameM, 0.08, dispTop - transom, recess, wu, transom, -recess / 2, false);
    }
    B(G, mat(rng.pick(['#e8e2d4', '#c9c2b0', '#b8b0a0']), { rough: 0.6 }), bayW, 0.02, recess + 0.12, du, 0, -recess / 2);
    B(G, frameM, bayW, 0.06, recess, du, transom, -recess / 2, false);
    // door frame and glass door
    B(G, alu, doorW + 0.12, 0.08, 0.1, du, 2.25, doorZ);
    for (const s of [-1, 1]) B(G, alu, 0.08, 2.3, 0.1, du + (s * (doorW + 0.04)) / 2, 0, doorZ);
    ctx.shop.add(F.m.clone().multiply(new THREE.Matrix4().makeTranslation(du - doorW / 2, 0.15, doorZ - 0.02)), doorW, 2.1, cell, 5, seed, lit);
    B(Fi, alu, 0.04, 0.5, 0.06, du + doorW / 2 - 0.12, 0.9, doorZ + 0.06, false);
    B(G, alu, doorW, 0.15, 0.06, du, 0, doorZ + 0.02, false);
    ctx.shop.add(F.m.clone().multiply(new THREE.Matrix4().makeTranslation(du - bayW / 2, 2.31, doorZ)), bayW, transom - 2.31, cell, 5, seed, lit);
  } else {
    B(G, alu, doorW + 0.12, 0.08, 0.1, du, 2.25, glassZ);
    ctx.shop.add(F.m.clone().multiply(new THREE.Matrix4().makeTranslation(du - doorW / 2, 0.1, glassZ - 0.02)), doorW, 2.15, cell, 5, seed, lit);
    ctx.shop.add(F.m.clone().multiply(new THREE.Matrix4().makeTranslation(du - bayW / 2, 2.33, glassZ)), bayW, dispTop - 2.33, cell, 5, seed, lit);
    for (const s of [-1, 1]) B(G, alu, 0.06, 2.3, 0.08, du + (s * (doorW + 0.03)) / 2, 0, glassZ);
  }
  // ---- roll-down gate: guides, and the curtain when shut
  if (gate) {
    for (const s of [-1, 1]) B(Fi, mat('#6c6f72', { metal: 0.6, rough: 0.5 }), 0.07, dispTop, 0.1, uc + s * (W / 2 - 0.26), 0, 0.2, false);
    if (closed || halfShut) {
      const hgt = closed ? dispTop : dispTop * rng.range(0.25, 0.5);
      gatePlane(G, W - 0.52, hgt, uc, dispTop - hgt, 0.22, rng.int(0, 2));
      B(G, mat('#5c5f62', { metal: 0.6, rough: 0.5 }), W - 0.52, 0.06, 0.08, uc, dispTop - hgt, 0.22, false);
    }
  }
  // ---- awning
  if (awningKind !== 'none') {
    const am = mat(rng.chance(0.7) ? color : rng.pick(['#1d3b2e', '#7a1d1d', '#1d2a4a', '#2a2a2a', '#c4161c']), { rough: 0.9 });
    const ay = sb0 + 0.05, out = rng.range(1.0, 1.5), drop = awningKind === 'box' ? 0.7 : out * 0.6;
    const len = Math.hypot(out, drop);
    const aw = B(G, am, W - 0.3, 0.04, len, uc, 0, 0);
    aw.position.set(uc, ay - drop / 2, out / 2 + 0.05);
    aw.rotation.x = Math.atan2(drop, out);
    // valance with lettering
    B(G, am, W - 0.3, 0.3, 0.03, uc, ay - drop - 0.3, out + 0.05);
    T.add(F.m, awningKind === 'box' ? name : addr.split(' ')[0], uc, ay - drop - 0.15, out + 0.07, 0.17, W - 0.8, '#f4efe2', font);
    // side cheeks
    for (const s of [-1, 1]) {
      const sh = new THREE.Shape();
      sh.moveTo(0, 0);
      sh.lineTo(out, -drop);
      sh.lineTo(out, -drop - 0.3);
      sh.lineTo(0, -0.05);
      const cg = new THREE.ShapeGeometry(sh);
      cg.rotateY(-Math.PI / 2);
      const cm = new THREE.Mesh(cg, am);
      cm.position.set(uc + s * (W / 2 - 0.15), ay, 0.05);
      cm.castShadow = true;
      G.add(cm);
    }
    // iron frame arms
    for (const s of [-1, 1]) {
      const arm = B(Fi, mat('#2a2a2a', { metal: 0.6, rough: 0.5 }), 0.03, 0.03, len, uc + s * (W / 2 - 0.2), 0, 0, false);
      arm.position.set(uc + s * (W / 2 - 0.2), ay - drop / 2 - 0.25, out / 2);
      arm.rotation.x = -Math.atan2(drop, out) * 0.6;
    }
  }
  // ---- projecting blade sign
  if (rng.chance(0.25)) {
    const bu = rng.chance(0.5) ? u0 + 0.3 : u1 - 0.3;
    const by = top + 0.4;
    B(Fi, mat('#2a2a2a', { metal: 0.6 }), 0.04, 0.04, 1.2, bu, by + 1.05, 0.6, false);
    const panel = B(G, litPanelMat(), 0.1, 0.9, 0.85, bu, by, 0.8);
    panel.userData.tint = color;
    const short = name.split(' ').slice(-1)[0];
    for (const s of [-1, 1]) {
      const m = F.m.clone().multiply(new THREE.Matrix4().makeTranslation(bu + s * 0.052, by + 0.45, 0.8)).multiply(new THREE.Matrix4().makeRotationY((s * Math.PI) / 2));
      T.add(m, short, 0, 0, 0, 0.22, 0.75, '#ffffff', font);
    }
  }
  // ---- address number on the pier
  T.add(F.m, addr.split(' ')[0], u0 + 0.11, 2.5, 0.145, 0.12, 0.2, '#e8e2d0', 0);

  // ---- portal into the shop
  const alongX = F.side === 'N' || F.side === 'S';
  const ent = F.at(du, 0, 0.7);
  if (!closed) {
    ctx.portals.push({
      box: new THREE.Box3().setFromCenterAndSize(ent.clone().setY(1.4), new THREE.Vector3(alongX ? 1.8 : 1.6, 2.8, alongX ? 1.6 : 1.8)),
      label: `Enter ${titleCaseName(name)}`,
      sub: `${addr} · stocked with sand3d ${shop.type === 'machines' ? 'machine parts' : shop.pools[0]}`,
      target: { kind: 'interior', seed: hashN(ctx.seed, Math.round(ent.x * 10), Math.round(ent.z * 10), 11), name: titleCaseName(name), style: 'store', floor: 0, floors: 1, biome: 'metropolis', shop: shop.type },
    });
  }
  ctx.doors.push(F.at(du, 0, 4.5));
  void NIGHT;
}
