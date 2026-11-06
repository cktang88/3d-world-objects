import * as THREE from 'three';
import type { LevelDesc, Portal } from '../level';
import type { Ctx2D, MapLabel, MinimapSource } from '../minimap';
import type { Door } from './plan';
import { ENTRY_Z, T_WALL } from './shell';

/**
 * The museum's floor plan for the minimap (src/minimap.ts). The museum is infinite and lazy, so the
 * plan holds only the rooms that have been built (prebuilt behind a doorway, or visited). Each
 * room sits in one shared plan frame: the atrium at the origin, every other room where its parent's
 * doorway puts it (its entrance wall at the end of that doorway's passage, as seamless.ts shows
 * it). The map of a level is drawn in that level's own frame. Doorways into rooms not built yet
 * are "?" stubs; a click teleports only into a visited room, through the museum's own room entry.
 */

export interface PlanRoom {
  key: string;
  desc: LevelDesc;
  name: string;
  color: string;
  W: number;
  D: number;
  /** atrium: centred on the origin (x ∈ ±W/2, z ∈ [-D, 0]) as galleries are */
  doors: Door[];
  /** per door: the room behind it (null: the way back) */
  exits: (LevelDesc | null)[];
  /** exhibit positions, room coordinates */
  dots: [number, number][];
  /** room -> plan */
  world: THREE.Matrix4;
  visited: boolean;
}

export const descKeyOf = (d: LevelDesc) => JSON.stringify(d);
const rooms = new Map<string, PlanRoom>();
/** where a room goes in the plan, decided by the first built room with a doorway into it */
const placements = new Map<string, THREE.Matrix4>();
let version = 0;

export function planVersion() {
  return version;
}
export function planRooms() {
  return rooms;
}
/** forget everything (a new game) */
export function resetPlan() {
  rooms.clear();
  placements.clear();
  visitedKeys.clear();
  version++;
}

/** a door's doorway (where the next room's entry lands) in its room's coordinates: position and yaw of someone walking out */
export function doorwayOf(d: Door, W: number, D: number) {
  const L = d.vest?.depth ?? 2.4;
  const w = d.wall === 'N' ? { c: new THREE.Vector3(d.at, 0, -D), o: new THREE.Vector3(0, 0, -1), back: Math.PI }
    : d.wall === 'S' ? { c: new THREE.Vector3(d.at, 0, 0), o: new THREE.Vector3(0, 0, 1), back: 0 }
    : d.wall === 'W' ? { c: new THREE.Vector3(-W / 2, 0, d.at), o: new THREE.Vector3(-1, 0, 0), back: -Math.PI / 2 }
    : { c: new THREE.Vector3(W / 2, 0, d.at), o: new THREE.Vector3(1, 0, 0), back: Math.PI / 2 };
  return { pos: w.c.clone().addScaledVector(w.o, T_WALL + L + T_WALL - ENTRY_Z), yaw: w.back + Math.PI };
}

/** child room -> parent room: the child's entry (0, 0, ENTRY_Z), facing -z, lands on the doorway */
function childMatrix(door: { pos: THREE.Vector3; yaw: number }) {
  return new THREE.Matrix4().makeTranslation(door.pos.x, 0, door.pos.z).multiply(new THREE.Matrix4().makeRotationY(door.yaw)).multiply(new THREE.Matrix4().makeTranslation(0, 0, -ENTRY_Z));
}

/** a room has been built: put it on the plan (and place the rooms behind its doorways) */
export function registerRoom(r: Omit<PlanRoom, 'world' | 'visited'>) {
  const old = rooms.get(r.key);
  const world = old?.world ?? placements.get(r.key) ?? new THREE.Matrix4();
  const rec: PlanRoom = { ...r, world, visited: old?.visited || visitedKeys.has(r.key) };
  rooms.set(r.key, rec);
  r.doors.forEach((d, i) => {
    const to = r.exits[i];
    if (!to) return;
    const k = descKeyOf(to);
    if (placements.has(k) || rooms.has(k)) return;
    placements.set(k, world.clone().multiply(childMatrix(doorwayOf(d, r.W, r.D))));
  });
  version++;
  return rec;
}

const visitedKeys = new Set<string>();
export function markVisited(key: string) {
  visitedKeys.add(key);
  const r = rooms.get(key);
  if (r && !r.visited) {
    r.visited = true;
    version++;
  }
}

// ---------------------------------------------------------------- the minimap source

const FLOOR = '#d9d2c4', WALL = '#3a342c', DOT = '#7a2e2e', STUB = '#8a8478';

/** the plan as seen from room `key` (its own coordinates), or null outside the museum */
export function museumSource(key: string, enter?: (desc: LevelDesc) => void): MinimapSource {
  const toLocal = () => {
    const me = rooms.get(key);
    return me ? me.world.clone().invert() : new THREE.Matrix4();
  };
  const corners = (r: PlanRoom, m: THREE.Matrix4) => [[-r.W / 2, -r.D], [r.W / 2, -r.D], [r.W / 2, 0], [-r.W / 2, 0]].map(([x, z]) => new THREE.Vector3(x, 0, z).applyMatrix4(m));
  const roomAt = (x: number, z: number) => {
    const inv = toLocal();
    for (const r of rooms.values()) {
      const m = inv.clone().multiply(r.world);
      const l = new THREE.Vector3(x, 0, z).applyMatrix4(m.clone().invert());
      if (l.x > -r.W / 2 && l.x < r.W / 2 && l.z > -r.D && l.z < 0) return { r, l };
    }
    return null;
  };
  return {
    tileSize: 64,
    version: () => version,
    drawTile(g: Ctx2D, tx: number, tz: number, px: number) {
      const T = 64;
      g.save();
      g.scale(px / T, px / T);
      g.translate(-tx * T, -tz * T);
      const inv = toLocal();
      for (const r of rooms.values()) {
        const m = inv.clone().multiply(r.world);
        const c = corners(r, m);
        g.globalAlpha = r.visited || r.key === key ? 1 : 0.55;
        g.fillStyle = r.key === key ? '#efe7d6' : FLOOR;
        g.beginPath();
        g.moveTo(c[0].x, c[0].z);
        for (const p of c.slice(1)) g.lineTo(p.x, p.z);
        g.closePath();
        g.fill();
        // a band of the room's colour along its far wall
        g.fillStyle = r.color;
        const band = corners({ ...r, D: Math.min(1.2, r.D / 6) } as PlanRoom, m.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -(r.D - Math.min(1.2, r.D / 6)))));
        g.beginPath();
        g.moveTo(band[0].x, band[0].z);
        for (const p of band.slice(1)) g.lineTo(p.x, p.z);
        g.closePath();
        g.fill();
        // walls, with gaps at the doorways
        g.strokeStyle = WALL;
        g.lineWidth = 0.5;
        const walls: [string, THREE.Vector3, THREE.Vector3, (d: Door) => [number, number]][] = [
          ['N', new THREE.Vector3(-r.W / 2, 0, -r.D), new THREE.Vector3(r.W / 2, 0, -r.D), (d) => [(d.at + r.W / 2) / r.W, d.w / r.W]],
          ['S', new THREE.Vector3(-r.W / 2, 0, 0), new THREE.Vector3(r.W / 2, 0, 0), (d) => [(d.at + r.W / 2) / r.W, d.w / r.W]],
          ['W', new THREE.Vector3(-r.W / 2, 0, -r.D), new THREE.Vector3(-r.W / 2, 0, 0), (d) => [(d.at + r.D) / r.D, d.w / r.D]],
          ['E', new THREE.Vector3(r.W / 2, 0, -r.D), new THREE.Vector3(r.W / 2, 0, 0), (d) => [(d.at + r.D) / r.D, d.w / r.D]],
        ];
        for (const [w, a, b, f] of walls) {
          const cuts = r.doors.filter((d) => d.wall === w).map(f).sort((p, q) => p[0] - q[0]);
          let t0 = 0;
          const seg = (s0: number, s1: number) => {
            if (s1 - s0 < 1e-3) return;
            const p = a.clone().lerp(b, s0).applyMatrix4(m), q = a.clone().lerp(b, s1).applyMatrix4(m);
            g.beginPath();
            g.moveTo(p.x, p.z);
            g.lineTo(q.x, q.z);
            g.stroke();
          };
          for (const [ct, cw] of cuts) {
            seg(t0, ct - cw / 2);
            t0 = ct + cw / 2;
          }
          seg(t0, 1);
        }
        // doorways into rooms not on the plan yet: a grey stub beyond the opening
        g.fillStyle = STUB;
        r.doors.forEach((d, i) => {
          const to = r.exits[i];
          if (!to || rooms.has(descKeyOf(to))) return;
          const p = doorwayOf(d, r.W, r.D).pos.applyMatrix4(m);
          g.beginPath();
          g.arc(p.x, p.z, 1.1, 0, Math.PI * 2);
          g.fill();
        });
        // exhibits
        g.fillStyle = DOT;
        for (const [x, z] of r.dots) {
          const p = new THREE.Vector3(x, 0, z).applyMatrix4(m);
          g.beginPath();
          g.arc(p.x, p.z, 0.35, 0, Math.PI * 2);
          g.fill();
        }
      }
      g.globalAlpha = 1;
      g.restore();
    },
    labels(x0: number, z0: number, x1: number, z1: number): MapLabel[] {
      const out: MapLabel[] = [];
      const inv = toLocal();
      const inside = (p: THREE.Vector3) => p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1;
      for (const r of rooms.values()) {
        const m = inv.clone().multiply(r.world);
        const c = new THREE.Vector3(0, 0, -r.D / 2).applyMatrix4(m);
        if (inside(c)) out.push({ x: c.x, z: c.z, text: r.name, kind: 'district' });
        // doorways into rooms not on the plan yet: "?"
        r.doors.forEach((d, i) => {
          const to = r.exits[i];
          if (!to || rooms.has(descKeyOf(to))) return;
          const p = doorwayOf(d, r.W, r.D).pos.applyMatrix4(m);
          if (inside(p)) out.push({ x: p.x, z: p.z, text: '?', kind: 'door' });
        });
      }
      return out;
    },
    describe(x: number, z: number) {
      const h = roomAt(x, z);
      return h ? `${h.r.name}${h.r.visited ? '' : ' (not visited)'}` : '';
    },
    snap(x: number, z: number) {
      const h = roomAt(x, z);
      if (!h || !h.r.visited) return null;
      if (h.r.key === key) {
        // within this room: a spot inside, facing into it
        return { x: Math.max(-h.r.W / 2 + 0.8, Math.min(h.r.W / 2 - 0.8, x)), z: Math.max(-h.r.D + 0.8, Math.min(-0.8, z)), yaw: 0 };
      }
      // another visited room: through the museum's own room entry (a level switch), not a jump
      enter?.(h.r.desc);
      return null;
    },
  };
}

/** a portal-shaped request to walk into a room (main.ts's enter() takes portals) */
export function entryPortal(desc: LevelDesc): Portal {
  return { box: new THREE.Box3(), label: 'map', target: desc };
}
