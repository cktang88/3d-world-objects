import * as THREE from 'three';
import type { Portal, Rect } from '../level';
import { Kit } from './kit';
import { M } from './mats';
import * as F from './furniture';
import { Rng, hashN } from '../rng';
import { mat } from '../build';
import { paintingTex } from '../textures';
import { photoTex } from './tex';
import { addSlot } from '../nyc/district-showcase';

/**
 * Building lobbies by era and type (docs/research/lobbies.md): the same building is always the same
 * lobby, its neighbours differ. Each style sets the plan (depth, width, height, mezzanine), the
 * palette, the security desk or doorman's podium, the art (mural, colour-field canvas, tapestry,
 * framed photographs, oil paintings), sculpture on plinths (the showcase 'statue' pool at real
 * size), seating, plants, light fittings (cove, pin lights, drums, pendants, chandelier, bare bulbs)
 * and the staff (doorman, guard, a visitor waiting). Fittings are emissive: the light rig stays the
 * same (src/rooms/vertical.ts, LIGHT_BUDGET).
 */

export type LobbyStyleId = 'deco' | 'midcentury' | 'postmodern' | 'atrium' | 'coop' | 'loft';

export interface LobbyStyle {
  id: LobbyStyleId;
  label: string;
  /** plan: lobby depth and width factors on the building's spec, ceiling height (m) */
  depth: number;
  width: number;
  H: number;
  mezzanine: boolean;
  floor: () => THREE.Material;
  wall: () => THREE.Material;
  ceiling: () => THREE.Material;
  /** a wainscot band (height, material) */
  dado: (() => THREE.Material) | null;
  desk: 'deco' | 'slab' | 'granite' | 'long' | 'podium' | 'trestle';
  art: 'mural' | 'colourfield' | 'tapestry' | 'photos' | 'paintings';
  sculptures: number;
  light: 'cove' | 'pins' | 'drums' | 'pendants' | 'chandelier' | 'bulbs';
  seating: 'bench' | 'barcelona' | 'armchairs' | 'sofa' | 'industrial';
  plants: number;
  residential: boolean;
}

const travertine = () => M.marble('#d8c8a8');
export const LOBBY_STYLES: Record<LobbyStyleId, LobbyStyle> = {
  // Chrysler / Empire State: red-brown marble, travertine floor, gold leaf, a radiant mural, coves
  deco: { id: 'deco', label: 'Art Deco', depth: 1.25, width: 1.05, H: 5.4, mezzanine: false, floor: travertine, wall: () => M.marble('#8a4a32'), ceiling: () => mat('#b8925a', { rough: 0.35, metal: 0.6 }), dado: null, desk: 'deco', art: 'mural', sculptures: 0, light: 'cove', seating: 'bench', plants: 0, residential: false },
  // Lever House / Seagram: white terrazzo, travertine or green marble, low ceiling of pin lights, a colour field
  midcentury: { id: 'midcentury', label: 'International Style', depth: 0.9, width: 1.2, H: 3.7, mezzanine: false, floor: () => M.marble('#ece8e0'), wall: () => M.marble('#c9c2ae'), ceiling: () => M.paint('#f2f1ee'), dado: null, desk: 'slab', art: 'colourfield', sculptures: 1, light: 'pins', seating: 'barcelona', plants: 2, residential: false },
  // 1980s granite: pink and grey polished granite bands, drum pendants, a tapestry, big planters
  postmodern: { id: 'postmodern', label: 'Postmodern granite', depth: 1.1, width: 1.0, H: 4.6, mezzanine: false, floor: () => M.marble('#7a6a66'), wall: () => M.marble('#b8948a'), ceiling: () => M.paint('#e8e2da'), dado: () => M.marble('#4a4446'), desk: 'granite', art: 'tapestry', sculptures: 2, light: 'drums', seating: 'armchairs', plants: 3, residential: false },
  // a glass atrium: tall, white, a mezzanine, trees, a big sculpture, framed photographs
  atrium: { id: 'atrium', label: 'Glass atrium', depth: 1.5, width: 1.25, H: 8.5, mezzanine: true, floor: () => M.marble('#d8d6d2'), wall: () => M.paint('#f4f4f2'), ceiling: () => mat('#f8f8f6', { emissive: '#f4f8ff', ei: 0.35, rough: 0.8 }), dado: null, desk: 'long', art: 'photos', sculptures: 1, light: 'pendants', seating: 'bench', plants: 4, residential: false },
  // a pre-war co-op: walnut panelling, black and white marble, a chandelier, oils, a doorman
  coop: { id: 'coop', label: 'Pre-war co-op', depth: 1.0, width: 0.95, H: 3.9, mezzanine: false, floor: () => M.checker(), wall: () => M.paint('#e8dcc4'), ceiling: () => M.paint('#f4efe4'), dado: () => M.walnut('#6a4a30'), desk: 'podium', art: 'paintings', sculptures: 0, light: 'chandelier', seating: 'sofa', plants: 2, residential: true },
  // a converted loft: whitewashed brick, concrete, steel columns, bare bulbs, big photographs
  loft: { id: 'loft', label: 'Converted loft', depth: 1.2, width: 1.1, H: 4.4, mezzanine: false, floor: () => mat('#8e8a84', { rough: 0.6 }), wall: () => M.paint('#e4ded4'), ceiling: () => mat('#5a5652', { rough: 0.9 }), dado: null, desk: 'trestle', art: 'photos', sculptures: 1, light: 'bulbs', seating: 'industrial', plants: 2, residential: false },
};

/** which lobby a building has: by type and era, picked by its seed (stable on revisits, neighbours differ) */
export function lobbyStyleFor(type: string, seed: number): LobbyStyle {
  const pool: LobbyStyleId[] =
    type === 'office' ? ['deco', 'midcentury', 'postmodern', 'atrium'] :
    type === 'prewar' ? ['coop', 'coop', 'deco', 'postmodern'] :
    type === 'loft' ? ['loft', 'loft', 'atrium'] : ['coop'];
  return LOBBY_STYLES[new Rng(hashN(seed, 9091)).pick(pool)];
}

export interface LobbyCtx {
  k: Kit;
  group: THREE.Group;
  cols: Rect[];
  ports: Portal[];
  /** lobby room: z from z0 (hall end) to z1 (street door), x within ±lw/2; the hall is ±hw/2 */
  z0: number;
  z1: number;
  lw: number;
  hw: number;
  H: number;
  seed: number;
  name: string;
  office: boolean;
}

export interface StaffPost {
  role: 'doorman' | 'guard' | 'visitor';
  x: number;
  z: number;
  yaw: number;
}
export interface LobbyBuilt {
  staff: StaffPost[];
  /** plinths (their tops) and the showcase slots on them */
  plinths: { x: number; z: number; top: number; w: number }[];
  /** the aisle kept clear from the street door to the hall */
  aisle: Rect;
}

const canvasTex = (w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
};

/** a radiant Art Deco mural: metal-leaf rays behind a stepped tower, gilt lines */
function muralMat(seed: number) {
  const r = new Rng(seed);
  return new THREE.MeshStandardMaterial({
    roughness: 0.35, metalness: 0.5,
    map: canvasTex(512, 768, (g) => {
      const gr = g.createLinearGradient(0, 0, 0, 768);
      gr.addColorStop(0, '#c8a46a');
      gr.addColorStop(1, '#8a6a42');
      g.fillStyle = gr;
      g.fillRect(0, 0, 512, 768);
      g.strokeStyle = '#efe0b8';
      g.lineWidth = 3;
      for (let i = 0; i < 48; i++) {
        const a = Math.PI + (i / 47) * Math.PI;
        g.beginPath();
        g.moveTo(256, 140);
        g.lineTo(256 + Math.cos(a) * 520, 140 - Math.sin(a) * 520 * -1);
        g.stroke();
      }
      g.fillStyle = '#5a4a3a';
      const steps = [[200, 140, 112], [216, 110, 80], [232, 80, 48], [246, 40, 20]];
      for (const [x, y, w] of steps) g.fillRect(x, y, w, 640 - y);
      g.fillStyle = '#e8d8b0';
      for (let y = 160; y < 620; y += 14) for (let x = 206; x < 306; x += 10) if (r.chance(0.7)) g.fillRect(x, y, 4, 7);
      g.fillStyle = '#3a2a1a';
      g.font = 'bold 54px Georgia, serif';
      g.textAlign = 'center';
      g.fillText('EXCELSIOR', 256, 710);
    }),
  });
}
/** a colour-field canvas: soft-edged stacked blocks */
function colourFieldMat(seed: number) {
  const r = new Rng(seed);
  const pal = r.pick([['#8a1a1a', '#d86a1a', '#2a0a0a'], ['#1a2a5a', '#3a6a8a', '#0a0a1a'], ['#d8b030', '#c85a1a', '#5a1a0a']]);
  return new THREE.MeshStandardMaterial({
    roughness: 0.9,
    map: canvasTex(512, 640, (g) => {
      g.fillStyle = pal[2];
      g.fillRect(0, 0, 512, 640);
      g.filter = 'blur(8px)';
      g.fillStyle = pal[0];
      g.fillRect(40, 40, 432, 300);
      g.fillStyle = pal[1];
      g.fillRect(40, 380, 432, 220);
      g.filter = 'none';
    }),
  });
}
/** a woven tapestry: a geometric pattern in wool colours */
function tapestryMat(seed: number) {
  const r = new Rng(seed);
  const cols = ['#7a2a2a', '#c8a050', '#2a4a5a', '#e8dcc0', '#3a5a3a', '#5a3a5a'];
  return new THREE.MeshStandardMaterial({
    roughness: 1,
    map: canvasTex(384, 512, (g) => {
      g.fillStyle = '#e8dcc0';
      g.fillRect(0, 0, 384, 512);
      for (let y = 0; y < 512; y += 32)
        for (let x = 0; x < 384; x += 32) {
          g.fillStyle = r.pick(cols);
          if ((x / 32 + y / 32) % 3 === 0) {
            g.beginPath();
            g.moveTo(x, y + 32);
            g.lineTo(x + 16, y);
            g.lineTo(x + 32, y + 32);
            g.fill();
          } else if (r.chance(0.4)) g.fillRect(x + 4, y + 4, 24, 24);
        }
      g.fillStyle = 'rgba(0,0,0,0.08)';
      for (let y = 0; y < 512; y += 2) g.fillRect(0, y, 384, 1);
    }),
  });
}

/** the furnishing of a lobby room (walls, floor and street door are drawn by FloorLevel) */
export function furnishLobby(st: LobbyStyle, c: LobbyCtx): LobbyBuilt {
  const { k, z0, z1, lw, H } = c;
  const r = new Rng(hashN(c.seed, 5150));
  const zc = (z0 + z1) / 2, L = z1 - z0;
  const aisle: Rect = { minX: -1.2, maxX: 1.2, minZ: z0, maxZ: z1 };
  const staff: StaffPost[] = [];
  const plinths: LobbyBuilt['plinths'] = [];
  const solid = (x0: number, x1: number, zA: number, zB: number) => c.cols.push({ minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minZ: Math.min(zA, zB), maxZ: Math.max(zA, zB) });
  const face = (fx: number, fz: number, tx: number, tz: number) => Math.atan2(tx - fx, tz - fz);

  // ---- wainscot / dado on both side walls
  if (st.dado) {
    const dm = st.dado();
    for (const sx of [-1, 1]) k.box(dm, 0.03, 1.2, L, sx * (lw / 2 - 0.015), 0, zc);
  }
  // ---- art on the left wall (facing +x), centred in the room
  const artW = Math.min(L * 0.55, st.art === 'mural' ? 3.2 : 2.8), artH = st.art === 'mural' ? Math.min(H - 1.4, artW * 1.5) : Math.min(H - 1.6, artW * 0.8);
  const ax = -lw / 2 + 0.02, ay = st.art === 'mural' ? 0.9 : 1.2;
  if (st.art === 'photos' || st.art === 'paintings') {
    const n = Math.max(2, Math.floor(L / 2.2));
    for (let i = 0; i < n; i++) {
      const z = z0 + (L * (i + 0.5)) / n, w = st.art === 'photos' ? 1.1 : 0.9, h = st.art === 'photos' ? 1.4 : 0.75;
      const tex = st.art === 'photos' ? photoTex(hashN(c.seed, i)) : paintingTex(hashN(c.seed, i));
      const frame = st.art === 'photos' ? M.black() : M.brass();
      k.at(ax, 0, z, Math.PI / 2, () => {
        k.box(frame, w + 0.08, h + 0.08, 0.04, 0, 1.4, 0.02);
        k.quad(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }), w, h, 0, 1.44 + h / 2, 0.045);
      });
    }
  } else {
    const am = st.art === 'mural' ? muralMat(c.seed) : st.art === 'colourfield' ? colourFieldMat(c.seed) : tapestryMat(c.seed);
    k.at(ax, 0, zc, Math.PI / 2, () => {
      if (st.art !== 'tapestry') k.box(st.art === 'mural' ? M.brass() : M.black(), artW + 0.12, artH + 0.12, 0.04, 0, ay - 0.06, 0.02);
      k.quad(am, artW, artH, 0, ay + artH / 2, 0.05);
      if (st.art === 'tapestry') {
        k.rod(M.walnut('#5a3a20'), 0.03, artW + 0.3, 0, ay + artH + 0.05, 0.08, 'x');
        for (let i = 0; i < 24; i++) k.box(mat('#c8b080', { rough: 1 }), 0.01, 0.12, 0.01, -artW / 2 + (i + 0.5) * (artW / 24), ay - 0.12, 0.06);
      }
    });
  }
  // ---- the security desk / doorman's podium on the right, by the door
  const dx = lw / 2 - 1.3, dz = z1 - Math.min(3.5, L * 0.35);
  const deskM = st.desk === 'deco' ? M.marble('#3a1e14') : st.desk === 'slab' ? M.walnut('#6a4a30') : st.desk === 'granite' ? M.marble('#4a4446') : st.desk === 'long' ? mat('#f4f4f2', { rough: 0.3 }) : st.desk === 'trestle' ? M.oak('#9a7a5a') : M.walnut('#5a3a20');
  if (st.desk === 'podium') {
    k.at(dx + 0.4, 0, z1 - 1.6, -Math.PI / 2, () => {
      k.box(deskM, 0.7, 1.1, 0.5, 0, 0, 0);
      k.boxM(deskM, 0.75, 0.04, 0.55, 0, 1.12, 0, new THREE.Euler(-0.25, 0, 0));
      k.box(M.brass(), 0.72, 0.04, 0.02, 0, 0.9, 0.26);
    });
    solid(dx + 0.15, dx + 0.65, z1 - 1.95, z1 - 1.25);
    staff.push({ role: 'doorman', x: dx + 0.4, z: z1 - 1.0, yaw: face(dx, z1 - 1.0, 0, z1 - 1.0) });
  } else {
    const dw = st.desk === 'long' ? 4.2 : 2.6, dd = 0.75;
    k.at(dx, 0, dz, -Math.PI / 2, () => {
      if (st.desk === 'slab' || st.desk === 'trestle') {
        k.box(deskM, dw, 0.05, dd, 0, 0.95, 0);
        for (const sx of [-1, 1]) k.box(st.desk === 'slab' ? M.chrome() : M.iron(), 0.05, 0.95, dd * 0.8, sx * (dw / 2 - 0.15), 0, 0);
        k.box(deskM, dw - 0.3, 0.7, 0.03, 0, 0.25, dd / 2 - 0.05);
      } else {
        k.box(deskM, dw, 1.05, dd, 0, 0, 0);
        k.box(st.desk === 'deco' ? M.brass() : st.desk === 'long' ? M.glass() : M.marble('#d8d2c8'), dw + 0.1, 0.05, dd + 0.1, 0, 1.05, 0);
        if (st.desk === 'deco') for (let i = 0; i < 5; i++) k.box(M.brass(), 0.04, 0.9, 0.02, -dw / 2 + (i + 0.5) * (dw / 5), 0.08, dd / 2 + 0.01);
        if (st.desk === 'granite') k.box(M.marble('#b8948a'), dw - 0.2, 0.2, dd + 0.02, 0, 0.6, 0);
      }
      F.monitor(k, 0.4, 1.09, -0.1, true, 0.5);
    });
    solid(dx - dd / 2 - 0.05, dx + dd / 2 + 0.05, dz - dw / 2, dz + dw / 2);
    if (c.office) staff.push({ role: 'guard', x: dx + 0.85, z: dz, yaw: face(dx + 0.85, dz, 0, dz) });
    else staff.push({ role: 'doorman', x: dx, z: z1 - 1.0, yaw: face(dx, z1 - 1.0, 0, z1 - 1.0) });
  }
  // ---- seating on the left, in front of the art, and a visitor waiting by it
  const sx0 = -lw / 2 + 1.0, sz = zc + Math.min(1.5, L * 0.2);
  const fabric = M.fabric(r.pick(['#2a2a2e', '#5a1d1d', '#1d3b2e', '#c8b89a', '#3a4a5a']));
  k.at(sx0, 0, sz, Math.PI / 2, () => {
    if (st.seating === 'sofa') F.sofa(k, r, 2.0, fabric, M.walnut('#5a3a20'), [fabric]);
    else if (st.seating === 'armchairs') {
      k.at(-0.6, 0, 0, 0, () => F.armchair(k, fabric, M.black()));
      k.at(0.6, 0, 0, 0, () => F.armchair(k, fabric, M.black()));
    } else if (st.seating === 'barcelona') {
      for (const ox of [-0.5, 0.5]) {
        k.box(M.leather('#2a2420'), 0.75, 0.12, 0.72, ox, 0.32, 0);
        k.boxM(M.leather('#2a2420'), 0.75, 0.6, 0.1, ox, 0.62, -0.3, new THREE.Euler(-0.2, 0, 0));
        for (const lx of [-0.33, 0.33]) k.box(M.chrome(), 0.02, 0.32, 0.6, ox + lx, 0, 0);
      }
    } else {
      const bm = st.seating === 'industrial' ? M.oak('#8a6a4a') : M.marble('#e0d8c8');
      k.box(bm, 2.2, 0.08, 0.5, 0, 0.42, 0);
      for (const lx of [-0.95, 0.95]) k.box(st.seating === 'industrial' ? M.iron() : bm, 0.12, 0.42, 0.45, lx, 0, 0);
    }
  });
  solid(sx0 - 0.5, sx0 + 0.55, sz - 1.2, sz + 1.2);
  if (r.chance(0.7)) staff.push({ role: 'visitor', x: sx0 + 1.0, z: sz + 1.5, yaw: face(sx0 + 1.0, sz + 1.5, 0, z1) });
  // ---- plants in the corners
  const corners: [number, number][] = [[lw / 2 - 0.6, z0 + 0.6], [-lw / 2 + 0.6, z0 + 0.6], [-lw / 2 + 0.6, z1 - 0.7], [lw / 2 - 0.6, z0 + 2.2]];
  for (let i = 0; i < st.plants && i < corners.length; i++) {
    const [px, pz] = corners[i];
    k.at(px, 0, pz, 0, () => F.plant(k, r, st.id === 'atrium' ? 3.2 : r.range(1.4, 1.9)));
    solid(px - 0.3, px + 0.3, pz - 0.3, pz + 0.3);
  }
  // ---- sculpture on plinths, at the sides of the room (the showcase statue pool: real size, inspectable)
  const spots: [number, number][] = st.id === 'atrium' ? [[-lw / 2 + 2.4, z0 + L * 0.35], [lw / 2 - 2.6, z0 + L * 0.3]] : [[lw / 2 - 1.2, z0 + L * 0.3], [-lw / 2 + 1.2, z0 + L * 0.22]];
  for (let i = 0; i < st.sculptures && i < spots.length; i++) {
    const [px, pz] = spots[i];
    if (Math.abs(px) < 2.0) continue;
    const pw = st.id === 'atrium' ? 1.8 : 1.1, ph = st.id === 'atrium' ? 0.45 : 0.9;
    const stone = st.id === 'loft' ? M.iron() : st.id === 'postmodern' ? M.marble('#4a4446') : M.marble('#ece8e0');
    k.box(stone, pw, ph, pw, px, 0, pz);
    k.box(stone, pw + 0.08, 0.04, pw + 0.08, px, ph, pz);
    solid(px - pw / 2, px + pw / 2, pz - pw / 2, pz + pw / 2);
    addSlot(c.group, c.ports, { kind: ['statue', 'statueShow'], x: px, y: ph + 0.04, z: pz, rot: Math.atan2(-px, 0), w: pw * 1.1, d: pw * 1.1, h: Math.min(H - ph - 0.5, st.id === 'atrium' ? 4.5 : 2.4), min: 0.5, radius: 40, maxTris: 150_000, seed: hashN(c.seed, i, 77) });
    plinths.push({ x: px, z: pz, top: ph + 0.04, w: pw });
  }
  // ---- light fittings (emissive; the room's point lights are the building's rig)
  k.unshadowed(() => {
    if (st.light === 'cove') {
      for (const sx of [-1, 1]) k.box(mat('#ffe2a8', { emissive: '#ffd890', ei: 1.6 }), 0.06, 0.08, L - 0.4, sx * (lw / 2 - 0.25), H - 0.35, zc);
      for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) {
        const z = z0 + (L * (i + 0.5)) / 3;
        k.box(M.brass(), 0.08, 0.5, 0.2, sx * (lw / 2 - 0.06), 2.2, z);
        k.box(mat('#fff0d0', { emissive: '#ffe2b0', ei: 1.4 }), 0.06, 0.35, 0.14, sx * (lw / 2 - 0.1), 2.27, z);
      }
    } else if (st.light === 'pins') {
      for (let x = -lw / 2 + 0.8; x < lw / 2 - 0.5; x += 1.2) for (let z = z0 + 0.6; z < z1 - 0.4; z += 1.2) k.cyl(mat('#ffffff', { emissive: '#fff6e8', ei: 2 }), 0.06, 0.06, 0.01, x, H - 0.015, z, 10);
    } else if (st.light === 'drums') {
      for (let i = 0; i < 3; i++) {
        const z = z0 + (L * (i + 0.5)) / 3;
        k.cyl(M.black(), 0.008, 0.008, 1.2, 0, H - 1.2, z, 6);
        k.cyl(M.shade('#efe2c8'), 0.45, 0.45, 0.35, 0, H - 1.55, z, 24, true);
        k.cyl(mat('#fff4dc', { emissive: '#ffe8c0', ei: 1.4 }), 0.43, 0.43, 0.01, 0, H - 1.55, z, 24);
      }
    } else if (st.light === 'pendants') {
      for (let i = 0; i < 7; i++) {
        const x = r.range(-lw / 2 + 1.5, lw / 2 - 1.5), z = r.range(z0 + 1, z1 - 1), drop = r.range(2, H - 3.2);
        k.cyl(M.black(), 0.006, 0.006, drop, x, H - drop, z, 6);
        k.sphere(mat('#fffaf0', { emissive: '#fff4e0', ei: 1.8 }), 0.28, x, H - drop - 0.25, z);
      }
    } else if (st.light === 'chandelier') {
      k.cyl(M.brass(), 0.01, 0.01, 0.6, 0, H - 0.6, zc, 6);
      k.cyl(M.brass(), 0.45, 0.15, 0.1, 0, H - 0.75, zc, 16);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        k.sphere(M.shade('#f6e2b8'), 0.08, Math.cos(a) * 0.42, H - 0.6, zc + Math.sin(a) * 0.42);
      }
      for (let i = 0; i < 12; i++) k.sphere(M.glass(), 0.03, r.range(-0.4, 0.4), H - 0.9 - r.range(0, 0.3), zc + r.range(-0.4, 0.4));
    } else {
      for (let x = -lw / 2 + 1.5; x < lw / 2 - 1; x += 1.8)
        for (let z = z0 + 1.2; z < z1 - 0.8; z += 2.4) {
          const drop = r.range(1.2, 1.8);
          k.cyl(M.black(), 0.005, 0.005, drop, x, H - drop, z, 4);
          k.sphere(mat('#ffc870', { emissive: '#ffb050', ei: 2.4 }), 0.06, x, H - drop - 0.06, z, 1.4);
        }
      // steel columns down the room
      if (lw > 6) for (const sx of [-1, 1]) for (let z = z0 + 2; z < z1 - 1.5; z += 3.5) {
        k.box(M.iron(), 0.25, H, 0.25, sx * (lw / 2 - 1.6), 0, z);
        solid(sx * (lw / 2 - 1.6) - 0.13, sx * (lw / 2 - 1.6) + 0.13, z - 0.13, z + 0.13);
      }
    }
  });
  // ---- the atrium's mezzanine along the hall end, a glass balustrade, two columns
  if (st.mezzanine) {
    const my = H * 0.5, md = Math.min(3.2, L * 0.25), mz = z0 + md / 2;
    k.box(mat('#f2f2f0', { rough: 0.5 }), lw, 0.35, md, 0, my - 0.35, mz);
    k.box(M.glass(), lw, 1.05, 0.03, 0, my, z0 + md);
    k.box(M.chrome(), lw, 0.05, 0.06, 0, my + 1.05, z0 + md);
    for (const sx of [-1, 1]) {
      k.cyl(mat('#f2f2f0', { rough: 0.4 }), 0.25, 0.25, my - 0.35, sx * (lw / 2 - 2.2), 0, z0 + md - 0.3, 20);
      solid(sx * (lw / 2 - 2.2) - 0.26, sx * (lw / 2 - 2.2) + 0.26, z0 + md - 0.56, z0 + md - 0.04);
    }
  }
  return { staff, plinths, aisle };
}
