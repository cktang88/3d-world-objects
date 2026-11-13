import * as THREE from 'three';
import { rect, type Rect } from '../level';
import { Rng, hashN } from '../rng';
import { AX, SZ, CURB } from './common';
import { lampPost } from './streetprops';
import { addSlot, type SlotSpec } from './district-showcase';
import { grassMat, hexPaverMat, flat, slab } from './district-tex';
import { parkBench } from './district-props';
import { treePlanter } from './district-park';
import { PIER_SHORE } from './districts';
import type { OpenCtx } from './district-open';
import { canvasTex } from './common';
// [nbhd] real-scale waterfront: open river surface, granite bulkhead, esplanade rail, pile grid, fenders, riprap, foam
import { WaterKit, riverCovered, waterRect, graniteBox, plankMat, bikewayMat, stripZ, deckRect } from './waterfront';

/**
 * The Hudson waterfront (docs/research/districts.md): Hudson River Park's lawns, bikeway and
 * esplanade along the bulkhead, and a pier per block running out into the river — Chelsea
 * Piers–style sheds with a marina, open park piers with aircraft on show (as at the Intrepid),
 * and floating-dock marinas full of boats. Offshore, an Essex-class carrier with aircraft on its
 * flight deck. Boats, aircraft, spacecraft, pier gear are sand3d showcase objects (watercraft,
 * aircraft/spacecraft families).
 */

const WATER = -1.25;
const DECK = CURB;
/** hulls sit this far below the water surface */
const DRAFT = 0.3;

export function buildWater(c: OpenCtx) {
  const { d, inner, group, stat, colliders, cx, cz } = c;
  const r = new Rng(hashN(c.seed, 31));
  const kit = new WaterKit(); // [nbhd]
  const slot = (s: Omit<SlotSpec, 'seed'>, col = true) => {
    addSlot(group, c.portals, { ...s, seed: hashN(c.seed, Math.round(s.x * 10), Math.round(s.z * 10)) });
    if (col) {
      const turn = Math.abs(Math.sin(s.rot ?? 0)) > 0.7;
      colliders.push(rect(s.x, s.z, (turn ? s.d : s.w) * 0.8, (turn ? s.w : s.d) * 0.8));
    }
  };
  const water = (x0: number, x1: number, z0: number, z1: number) => {
    if (x1 - x0 < 0.1 || z1 - z0 < 0.1) return;
    // [nbhd] the open river (Waterfront in nyc.ts) draws water beyond the bulkhead; chunks only fill the rest
    if (!riverCovered(cx * AX + x0, cx * AX + x1)) group.add(waterRect(x0, x1, z0, z1, cx * AX, cz * SZ, WATER));
    colliders.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1 });
  };
  // seawall + railing wherever a street sidewalk meets the river
  for (const e of ['+x', '-x', '+z', '-z'] as const) {
    if (!c.open[e]) continue;
    const alongX = e[1] === 'z', s = e[0] === '+' ? 1 : -1;
    const line = alongX ? (s > 0 ? inner.maxZ : inner.minZ) : s > 0 ? inner.maxX : inner.minX;
    if (d.kind === 'pier' && !alongX && s === -(d.waterSide ?? 1)) continue; // the landward avenue: park, not water
    const a0 = alongX ? inner.minX : inner.minZ, a1 = alongX ? inner.maxX : inner.maxZ;
    seawall(kit, stat, alongX ? 'x' : 'z', line, a0, a1, -s); // [nbhd] the river lies inside the chunk
  }

  if (d.kind !== 'pier') {
    water(inner.minX, inner.maxX, inner.minZ, inner.maxZ);
    if (cx === 7 && cz === -1) carrier(c, slot);
    kit.flush(group); // [nbhd]
    return;
  }

  // ---- pier chunk: u = x * s runs from the city (-) to the river (+)
  const s = d.waterSide ?? 1;
  const X = (u: number) => u * s;
  const uLand0 = c.open[s > 0 ? '-x' : '+x'] ? -(AX / 2) + 12.5 : -AX / 2;
  const uMin = Math.min(X(uLand0), X(PIER_SHORE)), uMax = Math.max(X(uLand0), X(PIER_SHORE));
  // Hudson River Park: lawn, bikeway (green-grey), esplanade along the bulkhead
  stat.add(slab(grassMat(), uMin, uMax, inner.minZ, inner.maxZ, CURB + 0.02, 4));
  const band = (u0: number, u1: number, m: THREE.Material, y: number) => stat.add(slab(m, Math.min(X(u0), X(u1)), Math.max(X(u0), X(u1)), inner.minZ, inner.maxZ, y, 3));
  stat.add(stripZ(bikewayMat(), Math.min(X(uLand0 + 6), X(uLand0 + 10)), Math.max(X(uLand0 + 6), X(uLand0 + 10)), inner.minZ, inner.maxZ, CURB + 0.03, 16, s < 0)); // [nbhd] marked bikeway
  band(PIER_SHORE - 7, PIER_SHORE, hexPaverMat(), CURB + 0.03);
  const plant = treePlanter(group);
  for (let z = inner.minZ + 4; z < inner.maxZ - 2; z += 8.5) {
    const tx = X(uLand0 + 14 + r.range(-2, 2));
    plant('locust', 0, tx, CURB, z, r);
    colliders.push(rect(tx, z, 0.7, 0.7));
  }
  for (let z = inner.minZ + 6, k = 0; z < inner.maxZ - 4; z += 12, k++) {
    parkBench(stat, X(PIER_SHORE - 6.2), CURB, z, s > 0 ? Math.PI / 2 : -Math.PI / 2);
    colliders.push(rect(X(PIER_SHORE - 6.2), z, 0.8, 2));
    if (k % 2 === 0) {
      lampPost(stat, group, X(PIER_SHORE - 1.0), z + 6, 'z', -s, 'crook'); // [nbhd] park lamps along the rail
      colliders.push(rect(X(PIER_SHORE - 1.0), z + 6, 0.4, 0.4));
    }
  }
  // a kiosk, a shelter or a little pavilion on the lawn of the riverside park
  for (const zz of [inner.minZ + 14, inner.maxZ - 14]) slot({ kind: ['folly', 'structure', 'smallbuilding'], x: X(uLand0 + 22), y: CURB + 0.02, z: zz, rot: s > 0 ? Math.PI / 2 : -Math.PI / 2, w: 8, d: 6, h: 7, min: 1.8, radius: 110, maxTris: 250_000 });
  // the bulkhead railing, open where the pier starts
  const pz0 = -10, pz1 = 10;
  seawall(kit, stat, 'z', X(PIER_SHORE), inner.minZ, pz0, s, false); // [nbhd] granite bulkhead + rail
  seawall(kit, stat, 'z', X(PIER_SHORE), pz1, inner.maxZ, s, false);
  kit.riprap('z', X(PIER_SHORE), inner.minZ + 1, pz0 - 3, s, hashN(c.seed, 41));
  kit.riprap('z', X(PIER_SHORE), pz1 + 3, inner.maxZ - 1, s, hashN(c.seed, 42));
  // the river around the pier
  const wu0 = PIER_SHORE, wu1 = AX / 2;
  const wx0 = Math.min(X(wu0), X(wu1)), wx1 = Math.max(X(wu0), X(wu1));
  water(wx0, wx1, inner.minZ, pz0);
  water(wx0, wx1, pz1, inner.maxZ);
  const tipU = AX / 2 - 3;
  const tip0 = Math.min(X(tipU), X(AX / 2)), tip1 = Math.max(X(tipU), X(AX / 2));
  water(tip0, tip1, pz0, pz1);
  // ---- the pier deck on pilings
  const px0 = Math.min(X(PIER_SHORE), X(tipU)), px1 = Math.max(X(PIER_SHORE), X(tipU));
  // [nbhd] the deck: timber planks on park and marina piers, concrete on the shed pier; a 0.45 m slab on a pile grid
  const kind0 = ((cz % 3) + 3) % 3;
  stat.add(kind0 === 0 ? slab(flat('#8d877c', 0.9), px0, px1, pz0, pz1, DECK, 3) : deckRect(plankMat(), px0, px1, pz0, pz1, DECK));
  const edge = new THREE.Mesh(new THREE.BoxGeometry(px1 - px0, 0.45, pz1 - pz0), flat('#5a554d', 0.95));
  edge.position.set((px0 + px1) / 2, DECK - 0.225, 0);
  edge.userData.owned = true;
  stat.add(edge);
  for (let u = PIER_SHORE + 1.5; u < tipU; u += 3.2)
    for (let z = pz0 + 0.8; z < pz1; z += 3.1) kit.pile(X(u), z, DECK - 0.45);
  // timber fender piles and whalers along the long sides and the end; foam around them
  for (let u = PIER_SHORE + 1; u <= tipU; u += 2.1) for (const z of [pz0 - 0.22, pz1 + 0.22]) kit.pile(X(u), z, DECK + 0.25, 0.85);
  for (let z = pz0 + 0.5; z < pz1; z += 2.1) kit.pile(X(tipU + 0.22), z, DECK + 0.25, 0.85);
  for (const z of [pz0 - 0.32, pz1 + 0.32]) for (const y of [DECK - 0.35, WATER + 0.45]) stat.add(graniteBox(px1 - px0, 0.22, 0.2, (px0 + px1) / 2, y, z, '#5c4a3a'));
  kit.foam(px0, pz0 - 0.35, px1, pz0 - 0.35, 0, -1);
  kit.foam(px0, pz1 + 0.35, px1, pz1 + 0.35, 0, 1);
  kit.foam(X(tipU + 0.35), pz0, X(tipU + 0.35), pz1, s, 0);
  // bollards and cleats along the edges, inside the rail
  for (let u = PIER_SHORE + 6; u < tipU - 2; u += 14) for (const z of [pz0 + 0.55, pz1 - 0.55]) kit.bollard(X(u), DECK, z);
  // rails along the pier's long sides and its end
  kit.rail('x', pz0 + 0.1, px0, px1, DECK);
  kit.rail('x', pz1 - 0.1, px0, px1, DECK);
  kit.rail('z', X(tipU - 0.1), pz0, pz1, DECK);
  colliders.push({ minX: px0, maxX: px1, minZ: pz0 - 0.3, maxZ: pz0 + 0.2 }, { minX: px0, maxX: px1, minZ: pz1 - 0.2, maxZ: pz1 + 0.3 }, rect(X(tipU), 0, 0.4, pz1 - pz0));

  const kind = ((cz % 3) + 3) % 3;
  if (kind === 0) {
    // Chelsea Piers: a long blue shed with red stairs; a marina of boats along its south side
    const su0 = PIER_SHORE + 8, su1 = tipU - 4;
    const sx0 = Math.min(X(su0), X(su1)), sx1 = Math.max(X(su0), X(su1));
    shed(stat, sx0, sx1, pz0 + 2, pz1 - 2);
    colliders.push({ minX: sx0, maxX: sx1, minZ: pz0 + 2, maxZ: pz1 - 2 });
    for (let u = PIER_SHORE + 8; u < tipU - 8; u += 13) slot({ kind: 'boat', x: X(u), y: WATER - DRAFT, z: pz1 + 5.5, rot: 0, w: 14, d: 5, h: 9, min: 4, radius: 140, maxTris: 300_000 }, false);
    for (let u = PIER_SHORE + 14; u < tipU - 8; u += 22) slot({ kind: 'boat', x: X(u), y: WATER - DRAFT, z: pz0 - 8, rot: 0, w: 22, d: 7, h: 12, min: 8, radius: 160, maxTris: 350_000 }, false);
    for (let u = PIER_SHORE + 4; u < tipU; u += 18) slot({ kind: 'pierprop', x: X(u), y: DECK, z: pz1 - 1.2, rot: 0, w: 1.6, d: 1.2, h: 2, min: 0.4, radius: 60, maxTris: 60_000 });
  } else if (kind === 1) {
    // an open park pier with aircraft and a spacecraft on show, as on the Intrepid's pier
    stat.add(slab(grassMat(), Math.min(X(PIER_SHORE + 4), X(PIER_SHORE + 30)), Math.max(X(PIER_SHORE + 4), X(PIER_SHORE + 30)), pz0 + 2, pz1 - 2, DECK + 0.02, 4));
    slot({ kind: ['deckPlane', 'plane', 'heli'], x: X(PIER_SHORE + 50), y: DECK, z: 0, rot: 0, w: 32, d: 19, h: 12, min: 7, radius: 200, maxTris: 500_000 });
    slot({ kind: 'space', x: X(PIER_SHORE + 22), y: DECK, z: 0, rot: 0, w: 14, d: 14, h: 30, min: 3, radius: 200, maxTris: 400_000 });
    for (let u = PIER_SHORE + 8; u < tipU - 4; u += 10) {
      parkBench(stat, X(u), DECK, pz1 - 1.6, Math.PI);
      colliders.push(rect(X(u), pz1 - 1.6, 2, 0.8));
    }
    // a tug and a ferry tied up alongside
    slot({ kind: 'boat', x: X(PIER_SHORE + 30), y: WATER - DRAFT, z: pz0 - 7, rot: 0, w: 32, d: 9, h: 14, min: 10, radius: 180, maxTris: 400_000 }, false);
  } else {
    // a marina: floating docks with fingers, a boat in each slip
    const fy = WATER + 0.45;
    for (const side of [-1, 1]) {
      const dz = side * 20;
      const fx0 = Math.min(X(PIER_SHORE + 2), X(tipU - 6)), fx1 = Math.max(X(PIER_SHORE + 2), X(tipU - 6));
      stat.add(deckRect(plankMat(), fx0, fx1, dz - 1.2, dz + 1.2, fy)); // [nbhd] timber floats
      for (let u = PIER_SHORE + 8; u < tipU - 8; u += 9) {
        stat.add(deckRect(plankMat(), X(u) - 0.6, X(u) + 0.6, Math.min(dz, dz - side * 7), Math.max(dz, dz - side * 7), fy));
        for (let k = 1; k < 7; k += 2.5) kit.cleat(X(u) + 0.5, fy, dz - side * k, Math.PI / 2); // [nbhd] cleats on the fingers
        kit.pile(X(u), dz - side * 7, fy + 1.2, 0.9);
        slot({ kind: 'boat', x: X(u + 4.5), y: WATER - DRAFT, z: dz - side * 4.5, rot: Math.PI / 2, w: 11, d: 4.2, h: 12, min: 4, radius: 140, maxTris: 250_000 }, false);
      }
    }
    for (let u = PIER_SHORE + 6; u < tipU - 4; u += 16) slot({ kind: 'pierprop', x: X(u), y: DECK, z: pz0 + 1.3, rot: 0, w: 1.6, d: 1.2, h: 2, min: 0.4, radius: 60, maxTris: 60_000 });
  }
  kit.flush(group); // [nbhd]
}

/**
 * [nbhd] the bulkhead (Hudson River Park / East River esplanade): a granite ashlar face from below the water up
 * to a projecting granite coping, the esplanade railing on it, foam at its foot. wd: the side the water is on.
 */
function seawall(kit: WaterKit, stat: THREE.Object3D, ax: 'x' | 'z', c: number, a0: number, a1: number, wd: number, railOnly = false) {
  const len = a1 - a0;
  if (len < 0.5) return;
  if (!railOnly) {
    const mid = (a0 + a1) / 2, h = CURB - 0.2 - (WATER - 0.8);
    const face = ax === 'x' ? graniteBox(len, h, 0.6, mid, WATER - 0.8 + h / 2, c - wd * 0.2) : graniteBox(0.6, h, len, c - wd * 0.2, WATER - 0.8 + h / 2, mid);
    stat.add(face);
    // the coping: 0.7 m granite, 0.3 m high, overhanging the face by 8 cm
    const cap = ax === 'x' ? graniteBox(len, 0.3, 0.7, mid, CURB - 0.12, c - wd * 0.17, '#cfcac0') : graniteBox(0.7, 0.3, len, c - wd * 0.17, CURB - 0.12, mid, '#cfcac0');
    stat.add(cap);
    if (ax === 'x') kit.foam(a0, c + wd * 0.1, a1, c + wd * 0.1, 0, wd);
    else kit.foam(c + wd * 0.1, a0, c + wd * 0.1, a1, wd, 0);
  }
  kit.rail(ax, c - wd * 0.25, a0, a1, CURB + 0.03);
}


/** a Chelsea Piers shed: blue steel panels, red roll-up doors and stairs, clerestory */
function shed(stat: THREE.Object3D, x0: number, x1: number, z0: number, z1: number) {
  const H = 10, W = x1 - x0, D = z1 - z0;
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), flat('#3f6fa8', 0.6, 0.3));
  body.position.set((x0 + x1) / 2, CURB + H / 2, (z0 + z1) / 2);
  body.castShadow = true;
  body.userData.owned = true;
  stat.add(body);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(W + 0.6, 0.5, D + 0.6), flat('#d9d6cf', 0.7));
  roof.position.set((x0 + x1) / 2, CURB + H + 0.25, (z0 + z1) / 2);
  roof.userData.owned = true;
  stat.add(roof);
  for (const s of [-1, 1]) {
    const z = s > 0 ? z1 + 0.05 : z0 - 0.05;
    for (let x = x0 + 3; x < x1 - 3; x += 7) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(4.2, 4.6, 0.1), flat('#c8ccd0', 0.5, 0.6));
      door.position.set(x, CURB + 2.3, z);
      door.userData.owned = true;
      stat.add(door);
      const band = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.5, 0.15), flat('#c4262e', 0.6));
      band.position.set(x, CURB + 4.9, z);
      band.userData.owned = true;
      stat.add(band);
      const win = new THREE.Mesh(new THREE.BoxGeometry(5, 1.4, 0.1), flat('#22303a', 0.15, 0.4));
      win.position.set(x, CURB + 7.4, z);
      win.userData.owned = true;
      stat.add(win);
    }
    // red stair towers
    for (const x of [x0 + 10, x1 - 10]) {
      const st = new THREE.Mesh(new THREE.BoxGeometry(2.2, 9, 1.2), flat('#c4262e', 0.6));
      st.position.set(x, CURB + 4.5, z + s * 0.6);
      st.userData.owned = true;
      stat.add(st);
    }
  }
}

let deckTex: THREE.Texture | null = null;
function deckMat() {
  if (!deckTex) {
    deckTex = canvasTex(256, 1024, (g) => {
      g.fillStyle = '#4b4e50';
      g.fillRect(0, 0, 256, 1024);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      for (let y = 20; y < 1024; y += 60) g.fillRect(126, y, 4, 34); // centreline dashes
      g.fillStyle = 'rgba(240,200,40,0.9)';
      g.fillRect(40, 0, 3, 1024);
      for (let y = 120; y < 1000; y += 160) g.fillRect(60, y, 120, 3);
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.font = 'bold 120px sans-serif';
      g.save();
      g.translate(128, 930);
      g.fillText('11', -64, 0);
      g.restore();
    });
  }
  return new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.8 });
}

/** an Essex-class carrier moored offshore (266 m, 45 m flight deck), aircraft on deck */
function carrier(c: OpenCtx, slot: (s: Omit<SlotSpec, 'seed'>, col?: boolean) => void) {
  const { stat, colliders } = c;
  const L = 266, B = 30, deckY = 15, x = -30;
  // hull: a box with a pointed bow (towards -z) and a sloped stern
  const sh = new THREE.Shape();
  sh.moveTo(-B / 2, L / 2);
  sh.lineTo(B / 2, L / 2);
  sh.lineTo(B / 2, -L / 2 + 40);
  sh.quadraticCurveTo(B / 2, -L / 2 + 8, 0, -L / 2);
  sh.quadraticCurveTo(-B / 2, -L / 2 + 8, -B / 2, -L / 2 + 40);
  sh.closePath();
  const hullG = new THREE.ExtrudeGeometry(sh, { depth: deckY - WATER + 3, bevelEnabled: false });
  hullG.rotateX(-Math.PI / 2);
  hullG.translate(x, WATER - 3, 0);
  const hull = new THREE.Mesh(hullG, flat('#6c7378', 0.7, 0.2));
  hull.castShadow = true;
  hull.userData.owned = true;
  stat.add(hull);
  // flight deck overhanging the hull, angled-deck sponson to port
  const deck = new THREE.Mesh(new THREE.BoxGeometry(44, 1.2, L - 6), deckMat());
  deck.position.set(x - 4, deckY + 0.6, 3);
  deck.castShadow = true;
  deck.userData.owned = true;
  c.group.add(deck);
  // the island: stacked blocks, funnel, mast with radars, on the starboard (+x) edge
  const grey = flat('#7b8288', 0.7, 0.2);
  const isl: [number, number, number, number][] = [[8, 9, 40, 0], [6, 6, 26, 9], [4, 5, 14, 15]];
  for (const [w, h, d, y] of isl) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), grey);
    m.position.set(x + 14, deckY + 1.2 + y + h / 2, 10);
    m.castShadow = true;
    m.userData.owned = true;
    stat.add(m);
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 18, 8), grey);
  mast.position.set(x + 14, deckY + 30, 6);
  mast.userData.owned = true;
  stat.add(mast);
  for (const [y, w] of [[34, 7], [28, 5]]) {
    const yard = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, 0.3), grey);
    yard.position.set(x + 14, deckY + y, 6);
    yard.userData.owned = true;
    stat.add(yard);
  }
  colliders.push(rect(x, 0, B, L));
  // aircraft parked along the deck edges, a helicopter by the island
  for (let i = 0; i < 7; i++) {
    const z = -100 + i * 30;
    slot({ kind: ['deckPlane', 'plane'], x: x - 10 + (i % 2) * 3, y: deckY + 1.2, z, rot: Math.PI / 2 + 0.5, w: 22, d: 16, h: 7, min: 8, radius: 240, maxTris: 350_000 }, false);
  }
  slot({ kind: 'heli', x: x + 6, y: deckY + 1.2, z: 60, rot: 0, w: 18, d: 16, h: 6, min: 7, radius: 240, maxTris: 300_000 }, false);
  slot({ kind: 'space', x: x + 8, y: deckY + 1.2, z: 100, rot: 0, w: 38, d: 26, h: 20, min: 8, radius: 260, maxTris: 400_000 }, false);
  void (null as unknown as Rect);
}
