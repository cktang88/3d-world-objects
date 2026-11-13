/** Office suites (src/rooms/office.ts): type variety up a building, aisles, desk clutter at real size on desks, reachability, lights, memory. */
import * as THREE from 'three';
import { test, expect, Grid } from './qa';
import './env';
import { OfficeLevel, officeTypeFor, OFFICE_TYPES, type OfficeType } from '../src/rooms/office';
import { FloorLevel, toWorld } from '../src/rooms/vertical';
import { LIB } from '../src/rooms/lib';
import { cycles, refsOf } from './memlib';
import { memTrack } from '../src/dispose';
import type { LevelDesc } from '../src/level';

const suite = (type: OfficeType, seed = 7): Extract<LevelDesc, { kind: 'interior' }> => ({ kind: 'interior', seed, name: `QA ${type}`, style: 'office', floor: 0, floors: 1, biome: 'town', office: type });
const built = new Map<OfficeType, OfficeLevel>();
const level = (t: OfficeType) => {
  let l = built.get(t);
  if (!l) built.set(t, (l = new OfficeLevel(suite(t))));
  l.group.updateMatrixWorld(true);
  return l;
};

test('offices: 20 floors of a building show at least 5 suite types, no floor repeats the one below', () => {
  for (const [building, district] of [['office', 'midtown'], ['office', undefined], ['loft', 'bowery'], ['loft', 'industrial']] as const) {
    for (const seed of [11, 202, 3003]) {
      const seen = new Set<OfficeType>();
      for (let u = 0; u < 3; u++) {
        let prev: OfficeType | null = null;
        for (let f = 1; f <= 20; f++) {
          const t = officeTypeFor(seed, building, district, f, u);
          seen.add(t);
          expect(t !== prev, `${building}/${district} seed ${seed} unit ${u}: floors ${f} and ${f + 1} are both ${t}`);
          expect(officeTypeFor(seed, building, district, f, u) === t, 'the type is not deterministic (revisits would differ)');
          prev = t;
        }
      }
      expect(seen.size >= 5, `${building}/${district} seed ${seed}: only ${seen.size} types over 20 floors (${[...seen].join(', ')})`);
    }
  }
  // the hall's suite doors carry the type, and it is the same on a revisit (a fresh FloorLevel)
  const fd = (floor: number): Extract<LevelDesc, { kind: 'floor' }> => ({ kind: 'floor', seed: 4242, name: 'QA tower', type: 'office', floor, floors: 21, district: 'midtown' });
  const types = (lv: FloorLevel) => lv.portals().map((p) => (typeof p.target === 'object' && p.target.kind === 'interior' ? p.target.office : undefined)).filter(Boolean);
  const a = types(new FloorLevel(fd(5))), b = types(new FloorLevel(fd(5))), c = types(new FloorLevel(fd(6)));
  expect(a.length >= 2 && JSON.stringify(a) === JSON.stringify(b), `suite types on floor 6: ${a} vs revisit ${b}`);
  expect(a.every((t, i) => t !== c[i]), `floor 6 and floor 7 suites repeat a type in the same position: ${a} / ${c}`);
});

test('offices: every type builds, within the light budget, with seats, desks and its own look', () => {
  const sigs = new Set<string>();
  for (const t of OFFICE_TYPES) {
    const l = level(t);
    let lights = 0, shadow = 0;
    l.group.traverse((o) => { if ((o as THREE.Light).isLight) { lights++; if ((o as THREE.PointLight).castShadow) shadow++; } });
    expect(lights <= 8 && shadow === 0, `${t}: ${lights} lights (${shadow} with shadows); a suite keeps 8 and none with shadows`);
    expect(l.seats.length >= (t === 'gym' || t === 'dentist' ? 3 : 8), `${t}: only ${l.seats.length} seats`);
    sigs.add(`${l.look.ceiling}|${l.look.H}|${(l.look.floor as THREE.MeshStandardMaterial).uuid}`);
    const im = l.group.children.filter((c) => (c as THREE.InstancedMesh).isInstancedMesh).length;
    expect(im >= 1, `${t}: chairs/screens are not instanced`);
  }
  expect(sigs.size >= 6, `only ${sigs.size} distinct floor/ceiling looks over ${OFFICE_TYPES.length} types`);
});

test('offices: aisles at least 0.9 m: every seat, room and the exit reachable from the door with a 0.9 m wide body', () => {
  for (const t of OFFICE_TYPES) {
    const l = level(t);
    const { W, D } = l.look;
    const g = new Grid({ minX: -W / 2, maxX: W / 2, minZ: -D / 2, maxZ: D / 2 + 0.01 }, l.colliders(), 0.1, 0.45);
    const reach = g.flood(l.spawn.pos.x, l.spawn.pos.z);
    const bad = l.seats.filter((s) => !reach(s.x, s.z, 0.5));
    expect(!bad.length, `${t}: ${bad.length}/${l.seats.length} seats not reachable through 0.9 m aisles, e.g. ${bad.slice(0, 3).map((v) => v.toArray().map((n) => n.toFixed(1)).join(',')).join(' | ')}`);
    for (const r of l.rooms) expect(reach((r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2 + 0.6, 1.0), `${t}: room ${JSON.stringify(r)} not reachable`);
  }
});

test('offices: desk clutter is real-size and sits on its desk', () => {
  const real: Record<string, [number, number]> = { monitor: [0.45, 0.75], crt: [0.3, 0.5], keyboard: [0.35, 0.5], papers: [0.2, 0.36], mug: [0.07, 0.1], laptop: [0.28, 0.4] };
  for (const t of OFFICE_TYPES) {
    const l = level(t);
    if (t !== 'gym') expect(l.clutter.length >= (t === 'dentist' ? 3 : 10), `${t}: only ${l.clutter.length} things on desks`);
    for (const c of l.clutter) {
      const d = l.desks[c.desk];
      expect(Math.abs(c.y - d.top) < 0.02, `${t}: ${c.kind} at y ${c.y.toFixed(2)}, desk top ${d.top}`);
      expect(c.x - c.w / 2 >= d.x0 - 0.02 && c.x + c.w / 2 <= d.x1 + 0.02 && c.z - c.d / 2 >= d.z0 - 0.02 && c.z + c.d / 2 <= d.z1 + 0.02, `${t}: ${c.kind} hangs off its desk`);
      const lib = LIB[c.kind];
      if (lib) expect(Math.abs(c.h - lib[1]) < 1e-6, `${t}: library ${c.kind} not at its real size`);
      else {
        const [lo, hi] = real[c.kind] ?? [0, 99];
        const size = Math.max(c.w, c.d);
        expect(size >= lo && size <= hi, `${t}: ${c.kind} is ${size.toFixed(2)} m, real ones are ${lo}-${hi} m`);
      }
    }
  }
});

test('offices: lifts and stairs stay reachable on office and loft floors (suite doors do not block them)', () => {
  for (const type of ['office', 'loft']) {
    const lv = new FloorLevel({ kind: 'floor', seed: 99, name: 'QA', type, floor: 3, floors: 10, district: 'midtown' });
    const cols = lv.colliders(new THREE.Vector3());
    const b = new THREE.Box3().setFromObject(lv.group);
    const g = new Grid({ minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z }, cols, 0.1, 0.3);
    const reach = g.flood(0, lv.d.Ld + 0.5); // the stair landing (as tests/vertical.test.ts walks from)
    const doors = lv.portals().filter((p) => p.returnPos);
    expect(doors.length >= 2, `${type}: ${doors.length} doors`);
    for (const p of doors) expect(reach(p.returnPos!.x, p.returnPos!.z, 0.6), `${type}: ${p.label} not reachable from the landing`);
    for (const l of lv.lifts) {
      const [hx, hz] = toWorld(l.frame, 0, 0.6); // the hall in front of its doors
      expect(reach(hx, hz, 0.5), `${type}: a lift front is not reachable`);
    }
  }
});

test('offices: build -> evict 6x frees every suite (memory)', async () => {
  const types = OFFICE_TYPES;
  await cycles('offices', 6, async (i) => {
    const l = new OfficeLevel(suite(types[(i % 2) * 3], 50 + (i % 2)));
    l.update(0, l.spawn.pos);
    memTrack(l.group, 'office');
    const refs = refsOf(l.group, [l]);
    l.dispose();
    return refs;
  }, { res: 12, heapMB: 6 });
});
