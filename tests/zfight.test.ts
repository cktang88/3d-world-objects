/**
 * Z-fighting ("flickering textures") in the city: coplanar, same-facing, overlapping faces of different meshes
 * or instances (src/zfix.ts). Builds the spawn block and representative blocks (avenue towers, a showcase
 * district, the park, a brownstone row) and counts flickering pairs and their area.
 * QA_VERBOSE=1 prints the worst mesh pairs per block.
 */
import { test, expect, soft, fmt } from './qa';
import { nycChunk } from './world';
import { districtAt } from '../src/nyc/districts';
import { scanZFight, fixZFight, topPairs } from '../src/zfix';
import { setZfix } from '../src/nyc/buildings';
import * as THREE from 'three';

function find(kind: string, not?: [number, number]): [number, number] | null {
  for (let r = 0; r < 12; r++)
    for (let cz = -r; cz <= r; cz++)
      for (let cx = -r; cx <= r; cx++) if (Math.max(Math.abs(cx), Math.abs(cz)) === r && districtAt(cx, cz).kind === kind && !(not && not[0] === cx && not[1] === cz)) return [cx, cz];
  return null;
}

// default: only the spawn block (the full qa has a 120 s cap); QA_ZFIGHT=all for every block + the runtime pass
const ALL = process.env.QA_ZFIGHT === 'all';
const BLOCKS_ALL: [string, [number, number] | null][] = [
  ['spawn (5 Av)', [0, 0]],
  ['midtown avenue', find('midtown', [0, 0])],
  ['showcase (autorow)', find('autorow') ?? find('timesq')],
  ['park', find('park')],
  ['brownstone row', find('brownstone')],
];

const verbose = !!process.env.QA_VERBOSE;
const rows: string[] = [];

/** target from the shared fix task: <= 50 m² of flickering overlap per block */
const TARGET = 50;

const BLOCKS = ALL ? BLOCKS_ALL : BLOCKS_ALL.slice(0, 1);

test('z-fighting per block (source fixes, no runtime pass)', () => {
  for (const [label, at] of BLOCKS) {
    if (!at) continue;
    const ch = nycChunk(1, at[0], at[1], true);
    const s = scanZFight(ch.group);
    rows.push(`${label.padEnd(20)} (${at}) tris ${s.tris}  pairs ${s.pairs}  overlap ${fmt(s.area)} m²  build ${Math.round(ch.ms)} ms  scan ${Math.round(s.ms)} ms`);
    if (verbose) for (const l of topPairs(s, 10)) rows.push('     ' + l);
    console.log(rows.splice(0).join('\n'));
    soft(s.area <= TARGET, `KNOWN ${label}: ${fmt(s.area)} m² of flickering overlap (target <= ${TARGET})`);
  }
});

test('the runtime per-building pass still works when switched on (setZfix)', () => {
  if (!ALL) return;
  const at = BLOCKS[0][1]!;
  const off = scanZFight(nycChunk(1, at[0], at[1], true).group);
  setZfix(true);
  const t = performance.now();
  const ch = nycChunk(1, at[0], at[1], true);
  const ms = performance.now() - t;
  setZfix(false);
  const on = scanZFight(ch.group);
  console.log(`  runtime pass on spawn: ${fmt(off.area)} -> ${fmt(on.area)} m², build ${Math.round(ms)} ms`);
  expect(on.area <= off.area, 'the runtime pass must not add overlap');
});

test('zfix: lifts a flush decal, a stacked chain and an instanced plate apart', () => {
  const root = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2), mat);
  const decal = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
  const dot = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3).rotateX(-Math.PI / 2), mat);
  const inst = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.5, 0.5).rotateX(-Math.PI / 2), mat, 2);
  inst.setMatrixAt(0, new THREE.Matrix4().makeTranslation(1.5, 0, 1.5));
  inst.setMatrixAt(1, new THREE.Matrix4().makeTranslation(-1.5, 0.5, -1.5)); // in the air: no fight
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  box.position.set(-1.5, 0.5, 1.5); // bottom face down: faces the other way, no fight
  root.add(floor, decal, dot, inst, box);
  const s0 = scanZFight(root);
  expect(s0.pairs >= 3, `found the flush decal, dot and instance (${s0.pairs} pairs)`);
  const f = fixZFight(root);
  const s1 = scanZFight(root);
  expect(s1.pairs === 0, `fixed: ${s1.pairs} pairs left after ${f.passes} passes`);
  root.updateMatrixWorld(true);
  const y = (m: THREE.Mesh) => new THREE.Box3().setFromObject(m).max.y;
  expect(y(floor) < 1e-6 && y(decal) > 0.003 && y(dot) > y(decal) + 0.003, `stacked heights floor ${fmt(y(floor))} decal ${fmt(y(decal))} dot ${fmt(y(dot))}`);
  const m = new THREE.Matrix4();
  inst.getMatrixAt(0, m);
  expect(m.elements[13] > 0.003, `instance lifted ${fmt(m.elements[13])}`);
});
