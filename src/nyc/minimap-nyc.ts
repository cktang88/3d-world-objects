import { AX, SZ, AVE, ST, BX, BZ, LX, LZ } from './common';
import { districtAt, roadOpen, walkable, PIER_SHORE, type DKind } from './districts';
import { parkFeature } from './district-park';
import type { Ctx2D, MapLabel, MinimapSource } from '../minimap';

/**
 * The NYC minimap source (src/minimap.ts): tiles painted from the district map and the street grid
 * (roads only where they remain, sidewalks, block interiors tinted by district, parks, piers,
 * the river, the airport apron) and, once a block has been built, its building footprints.
 * Labels name each district once and mark the showcase blocks (auto row lots, flea market,
 * armory, salvage yard, community gardens, the park's features...).
 */

const TINT: Record<DKind, string> = {
  midtown: '#8e8a84', timesq: '#a0605a', music: '#8a7698', garment: '#a08a6a', bowery: '#a49470', canal: '#7f8ea0', market: '#86a07a', brownstone: '#9c7a64',
  industrial: '#7c7a76', construction: '#b0965a', museum: '#c4baa4', autorow: '#7aa0a0', park: '#5b8a45', airport: '#b8b6ae', pier: '#2f5568', river: '#2f5568',
};
const ROAD = '#3a3c40', WALK = '#a8a59e', WATER = '#2f5568', LAWN = '#5b8a45', PATH = '#c9c0a8', APRON = '#b8b6ae';

/** footprints of built blocks (world rects), set when a block is placed */
const hulls = new Map<string, { minX: number; maxX: number; minZ: number; maxZ: number }[]>();
const MAX_BLOCKS = 4000;
function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

/** the name of a block's showcase, if it has one (matches district-custom/yards/park) */
export function showcaseName(cx: number, cz: number): string | null {
  const d = districtAt(cx, cz);
  const even = (((cx + cz) % 2) + 2) % 2 === 0;
  switch (d.kind) {
    case 'autorow': return 'Showroom & car lots';
    case 'garment': return even ? 'Flea market' : null;
    case 'industrial': return even ? 'Salvage & tool rental' : 'Rail & container yard';
    case 'museum': return even ? 'Museum' : 'The Armory';
    case 'brownstone': return even ? 'Community garden' : null;
    case 'market': return even ? 'Greenmarket' : null;
    case 'construction': return 'Construction site';
    case 'park': return ({ playground: 'Playground', pond: 'Boat pond', fountain: 'Fountain terrace', ballfield: 'Ballfields', dogrun: 'Dog run', garden: 'Formal garden', meadow: 'Meadow', kiosk: 'Kiosk' } as Record<string, string>)[parkFeature(cx, cz)];
    case 'pier': return ['Chelsea Piers', 'Aircraft pier', 'Marina'][((cz % 3) + 3) % 3];
    case 'airport': return 'Airport apron';
    case 'river': return cx === 7 && cz === -1 ? 'Aircraft carrier' : null;
    case 'timesq': return 'Billboards';
    case 'bowery': return 'Appliance row';
  }
  return null;
}

function drawBlock(g: Ctx2D, cx: number, cz: number) {
  const d = districtAt(cx, cz);
  const ox = cx * AX, oz = cz * SZ;
  const R = (x0: number, z0: number, x1: number, z1: number, c: string) => {
    g.fillStyle = c;
    g.fillRect(ox + Math.min(x0, x1), oz + Math.min(z0, z1), Math.abs(x1 - x0), Math.abs(z1 - z0));
  };
  if (!d.open) {
    R(-AX / 2, -SZ / 2, AX / 2, SZ / 2, ROAD);
    R(-BX, -BZ, BX, BZ, WALK);
    R(-LX, -LZ, LX, LZ, TINT[d.kind]);
    const hs = hulls.get(`${cx},${cz}`);
    if (hs) {
      g.fillStyle = shade(TINT[d.kind], 0.72);
      g.strokeStyle = shade(TINT[d.kind], 0.5);
      g.lineWidth = 0.6;
      for (const h of hs) {
        g.fillRect(h.minX, h.minZ, h.maxX - h.minX, h.maxZ - h.minZ);
        g.strokeRect(h.minX, h.minZ, h.maxX - h.minX, h.maxZ - h.minZ);
      }
    }
    return;
  }
  // open: the ground, then the roads that remain along its edges
  if (d.open === 'park') {
    R(-AX / 2, -SZ / 2, AX / 2, SZ / 2, LAWN);
    // the Mall / walks where the roads used to be
    if (!roadOpen(cx, cz, '+x')) R(AX / 2 - 6.5, -SZ / 2, AX / 2, SZ / 2, PATH);
    if (!roadOpen(cx, cz, '-x')) R(-AX / 2, -SZ / 2, -AX / 2 + 6.5, SZ / 2, PATH);
    if (!roadOpen(cx, cz, '+z')) R(-AX / 2, SZ / 2 - 3, AX / 2, SZ / 2, PATH);
    if (!roadOpen(cx, cz, '-z')) R(-AX / 2, -SZ / 2, AX / 2, -SZ / 2 + 3, PATH);
    const f = parkFeature(cx, cz);
    // the block's feature in the middle
    if (f === 'pond') {
      g.fillStyle = WATER;
      g.beginPath();
      g.arc(ox, oz, 15, 0, Math.PI * 2);
      g.fill();
    } else if (f !== 'meadow') R(-17, -12, 17, 12, f === 'playground' ? '#3f6e8a' : f === 'ballfield' ? '#a9825a' : f === 'dogrun' ? '#a49a85' : '#b5a98f');
  } else if (d.open === 'airport') {
    R(-AX / 2, -SZ / 2, AX / 2, SZ / 2, APRON);
    R(-AX / 2, -SZ / 2 + 2, AX / 2, -SZ / 2 + 22, '#6a6c6f');
  } else {
    R(-AX / 2, -SZ / 2, AX / 2, SZ / 2, WATER);
    if (d.kind === 'pier') {
      const s = d.waterSide ?? 1;
      R(-AX / 2 * s, -SZ / 2, PIER_SHORE * s, SZ / 2, LAWN);
      R(PIER_SHORE * s, -10, (AX / 2 - 3) * s, 10, '#8d877c');
    }
    if (cx === 7 && cz === -1) {
      // the carrier's flight deck
      g.fillStyle = '#4b4e50';
      g.fillRect(ox - 52, oz - 130, 44, 260);
    }
  }
  const ha = AVE / 2, hs = ST / 2, sw = 4.5;
  if (roadOpen(cx, cz, '+x')) (R(AX / 2 - ha, -SZ / 2, AX / 2, SZ / 2, ROAD), R(LX, -BZ, BX, BZ, WALK));
  if (roadOpen(cx, cz, '-x')) (R(-AX / 2, -SZ / 2, -AX / 2 + ha, SZ / 2, ROAD), R(-BX, -BZ, -LX, BZ, WALK));
  if (roadOpen(cx, cz, '+z')) (R(-AX / 2, SZ / 2 - hs, AX / 2, SZ / 2, ROAD), R(-BX, LZ, BX, BZ, WALK));
  if (roadOpen(cx, cz, '-z')) (R(-AX / 2, -SZ / 2, AX / 2, -SZ / 2 + hs, ROAD), R(-BX, -BZ, BX, -LZ, WALK));
  void sw;
}

/**
 * The nearest walkable outdoor spot to a clicked point: the middle of a sidewalk (2.2 m out from the
 * shopfronts, clear of kerb furniture), a park walk or the Mall, the riverside esplanade. Faces along
 * the street, or toward `face` (a showcase) when given.
 */
export function snapToWalk(x: number, z: number, face?: { x: number; z: number }): { x: number; z: number; yaw: number } {
  let best: { x: number; z: number; yaw: number; d: number } | null = null;
  const consider = (px: number, pz: number, yaw: number) => {
    if (!walkable(px, pz)) return;
    const d = Math.hypot(px - x, pz - z);
    if (!best || d < best.d) best = { x: px, z: pz, yaw, d };
  };
  const ccx = Math.round(x / AX), ccz = Math.round(z / SZ);
  for (let cz = ccz - 1; cz <= ccz + 1; cz++)
    for (let cx = ccx - 1; cx <= ccx + 1; cx++) {
      const d = districtAt(cx, cz), ox = cx * AX, oz = cz * SZ;
      const lx = Math.max(-BX + 1, Math.min(BX - 1, x - ox)), lz = Math.max(-BZ + 1, Math.min(BZ - 1, z - oz));
      const mid = LX + 2.2, midZ = LZ + 2.2; // the sidewalk line, as at the spawn
      const sideOk = (e: '+x' | '-x' | '+z' | '-z') => !d.open || roadOpen(cx, cz, e);
      if (sideOk('+x')) consider(ox + mid, oz + lz, 0);
      if (sideOk('-x')) consider(ox - mid, oz + lz, 0);
      if (sideOk('+z')) consider(ox + lx, oz + midZ, Math.PI / 2);
      if (sideOk('-z')) consider(ox + lx, oz - midZ, Math.PI / 2);
      if (d.open === 'park') {
        // the Mall and the walks on the old road lines
        if (!roadOpen(cx, cz, '+x')) consider(ox + AX / 2 - 3, oz + lz, 0);
        if (!roadOpen(cx, cz, '-x')) consider(ox - AX / 2 + 3, oz + lz, 0);
        if (!roadOpen(cx, cz, '+z')) consider(ox + lx, oz + SZ / 2 - 1.5, Math.PI / 2);
        if (!roadOpen(cx, cz, '-z')) consider(ox + lx, oz - SZ / 2 + 1.5, Math.PI / 2);
      }
      if (d.kind === 'pier') consider(ox + (PIER_SHORE - 3.5) * (d.waterSide ?? 1), oz + lz, 0);
    }
  const b = best as { x: number; z: number; yaw: number } | null;
  const out = b ?? { x: 49.8, z: 9, yaw: 0 };
  // face the showcase when given (yaw 0 looks -z)
  if (face) out.yaw = Math.atan2(-(face.x - out.x), -(face.z - out.z));
  return { x: out.x, z: out.z, yaw: out.yaw };
}

export const nycMinimapSource: MinimapSource & { addChunk(cx: number, cz: number, hs: { rect: { minX: number; maxX: number; minZ: number; maxZ: number } }[] | undefined): void } = {
  tileSize: 128,
  drawTile(g, tx, tz, px) {
    const T = this.tileSize;
    g.save();
    g.scale(px / T, px / T);
    g.translate(-tx * T, -tz * T);
    const x0 = tx * T, z0 = tz * T;
    for (let cz = Math.round(z0 / SZ) - 1; cz <= Math.round((z0 + T) / SZ) + 1; cz++)
      for (let cx = Math.round(x0 / AX) - 1; cx <= Math.round((x0 + T) / AX) + 1; cx++) {
        // only blocks that touch the tile
        if ((cx + 0.5) * AX < x0 || (cx - 0.5) * AX > x0 + T || (cz + 0.5) * SZ < z0 || (cz - 0.5) * SZ > z0 + T) continue;
        drawBlock(g, cx, cz);
      }
    g.restore();
  },
  version(tx, tz) {
    // repaint a tile once any block on it gets its footprints
    const T = this.tileSize;
    let v = 0;
    for (let cz = Math.floor((tz * T) / SZ - 0.5); cz <= Math.ceil(((tz + 1) * T) / SZ + 0.5); cz++)
      for (let cx = Math.floor((tx * T) / AX - 0.5); cx <= Math.ceil(((tx + 1) * T) / AX + 0.5); cx++) if (hulls.has(`${cx},${cz}`)) v++;
    return v;
  },
  labels(x0, z0, x1, z1) {
    const out: MapLabel[] = [];
    for (let cz = Math.floor(z0 / SZ); cz <= Math.ceil(z1 / SZ); cz++)
      for (let cx = Math.floor(x0 / AX); cx <= Math.ceil(x1 / AX); cx++) {
        const d = districtAt(cx, cz);
        // a district's name once: on its north-west block (no same district to the west or north)
        if (d.kind !== 'river' && districtAt(cx - 1, cz).kind !== d.kind && districtAt(cx, cz - 1).kind !== d.kind) out.push({ x: cx * AX, z: cz * SZ - SZ / 4, text: d.name, kind: 'district' });
        const sc = showcaseName(cx, cz);
        if (sc) out.push({ x: cx * AX, z: cz * SZ + SZ / 5, text: sc, kind: 'showcase' });
      }
    return out;
  },
  snap(x, z, marker) {
    // a marker: on the nearest sidewalk or path of the showcase's own block, looking at it
    if (marker) return snapToWalk(marker.x, marker.z, { x: Math.round(marker.x / AX) * AX, z: Math.round(marker.z / SZ) * SZ });
    return snapToWalk(x, z);
  },
  describe(x, z) {
    const cx = Math.round(x / AX), cz = Math.round(z / SZ);
    const sc = showcaseName(cx, cz);
    return `${districtAt(cx, cz).name}${sc ? ' · ' + sc : ''}`;
  },
  addChunk(cx, cz, hs) {
    if (!hs) return;
    if (hulls.size > MAX_BLOCKS) hulls.delete(hulls.keys().next().value!);
    hulls.set(`${cx},${cz}`, hs.map((h) => ({ ...h.rect })));
  },
};
