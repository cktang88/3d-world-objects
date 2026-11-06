/**
 * Up close, people must walk, not skate: while a foot is planted (the lower foot, barely rising), it must
 * stay put on the ground as the body moves on. Also their proportions: stature spread like real adults,
 * head about 1/7.5 of stature.
 */
import * as THREE from 'three';
import { test, expect, between, fmt } from './qa';
import { allowModels, settle } from './env';

async function people(n: number, seed = 7) {
  allowModels(/assets\/people\//);
  const { Person, loadPeopleAssets } = await import('../src/nyc/people');
  const { Rng } = await import('../src/rng');
  const assets = await loadPeopleAssets();
  await settle(0);
  const r = new Rng(seed);
  return Array.from({ length: n }, (_, i) => new Person(assets, r, i % 2 ? 'female' : 'male'));
}

function bone(root: THREE.Object3D, name: string) {
  let b: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!b && (o as THREE.Bone).isBone && o.name === name) b = o;
  });
  return b as THREE.Object3D | null;
}

/** walk a person along -z at v m/s for `secs`, dt 1/60: the planted foot's horizontal speed (m/s) */
function stance(p: InstanceType<Awaited<ReturnType<typeof importPeople>>['Person']>, v: number, secs = 3) {
  const root = p.root;
  root.position.set(0, 0, 0);
  root.rotation.y = Math.PI; // the walk clip faces +z: turn to walk along -z? measured either way below
  p.setActivity('walk', 0);
  p.setSpeed(v);
  const fl = bone(root, 'foot_l'), fr = bone(root, 'foot_r');
  if (!fl || !fr) return null;
  const dt = 1 / 60;
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(root.quaternion);
  const prev = [new THREE.Vector3(), new THREE.Vector3()], cur = [new THREE.Vector3(), new THREE.Vector3()];
  const speeds: number[] = [];
  const signed: number[] = [];
  let lowY = Infinity;
  for (let i = 0; i < secs / dt; i++) {
    p.update(dt);
    root.position.addScaledVector(fwd, v * dt);
    root.updateMatrixWorld(true);
    fl.getWorldPosition(cur[0]);
    fr.getWorldPosition(cur[1]);
    lowY = Math.min(lowY, cur[0].y, cur[1].y);
    if (i > 30) {
      // the planted foot: the lower one, within 2 cm of the lowest a foot gets, hardly moving up or down
      const k = cur[0].y < cur[1].y ? 0 : 1;
      const vy = Math.abs(cur[k].y - prev[k].y) / dt;
      if (cur[k].y < lowY + 0.02 && vy < 0.1) {
        speeds.push(Math.hypot(cur[k].x - prev[k].x, cur[k].z - prev[k].z) / dt);
        signed.push(((cur[k].x - prev[k].x) * fwd.x + (cur[k].z - prev[k].z) * fwd.z) / dt);
      }
    }
    prev[0].copy(cur[0]);
    prev[1].copy(cur[1]);
  }
  speeds.sort((a, b) => a - b);
  signed.sort((a, b) => a - b);
  return { median: speeds[speeds.length >> 1] ?? NaN, n: speeds.length, along: signed[signed.length >> 1] ?? NaN };
}
const importPeople = () => import('../src/nyc/people');

test('walking feet plant: a planted foot slides less than 5% of the walking speed (1.0-1.5 m/s)', async () => {
  const ps = await people(6);
  const bad: string[] = [];
  const rows: string[] = [];
  for (const [i, p] of ps.entries()) {
    for (const v of [1.0, 1.3, 1.5]) {
      const s = stance(p as never, v);
      if (!s) continue;
      rows.push(`${p.gender[0]}${i} ${v} m/s: planted foot ${fmt(s.median)} m/s, ${fmt(s.along)} along the walk (${s.n} frames)`);
      if (!(s.median < 0.05 * v)) bad.push(`${p.gender} ${i} at ${v} m/s: the planted foot slides at ${fmt(s.median)} m/s (${fmt((100 * s.median) / v)}% of the walking speed)`);
    }
  }
  console.log('   ' + rows.join('\n   '));
  expect(rows.length > 0, 'no foot bones found');
  expect(!bad.length, bad.join('\n'));
});

test('proportions: adults spread like real ones (NHANES), heads in proportion', async () => {
  const ps = await people(80, 11);
  const by: Record<string, number[]> = { male: [], female: [] };
  const crowns: number[] = [];
  for (const p of ps) {
    p.root.updateMatrixWorld(true);
    // the body's own height (the root scale x the base mesh): stature without hair, hats or shoes
    const b = new THREE.Box3().setFromObject(p.root);
    const h = b.max.y - Math.max(0, b.min.y);
    by[p.gender].push(h);
    const head = bone(p.root, 'head') ?? bone(p.root, 'Head');
    if (head) crowns.push(h - head.getWorldPosition(new THREE.Vector3()).y);
  }
  const stat = (a: number[]) => {
    const m = a.reduce((s, x) => s + x, 0) / a.length;
    return { m, sd: Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length), lo: Math.min(...a), hi: Math.max(...a) };
  };
  const M = stat(by.male), F = stat(by.female), C = stat(crowns);
  console.log(`   men ${fmt(M.m)} sd ${fmt(M.sd)} (${fmt(M.lo)}-${fmt(M.hi)}), women ${fmt(F.m)} sd ${fmt(F.sd)} (${fmt(F.lo)}-${fmt(F.hi)}) with hair and shoes; skull base to crown ${fmt(C.m)} m`);
  // NHANES 1.755 / 1.625 m; measured in the walk/idle pose (a few cm lower), with shoes and hair
  between(M.m, 1.71, 1.82, 'men, mean stature');
  between(F.m, 1.58, 1.70, 'women, mean stature');
  between(M.m - F.m, 0.07, 0.17, 'men taller than women by');
  between(M.sd, 0.05, 0.1, 'men, stature sd');
  between(F.sd, 0.045, 0.095, 'women, stature sd');
  // the head: skull base (atlas) to the crown is 0.17-0.20 m on an adult, + hair or a hat
  between(C.m, 0.16, 0.27, 'skull base to crown');
});
