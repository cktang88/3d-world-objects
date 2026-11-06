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

test('a pushed stroller stands on the ground (its wheels were 8 cm in the air)', async () => {
  const { strollerGeo } = await import('../src/nyc/peopleProps');
  const g = strollerGeo('#2a2c30');
  g.computeBoundingBox();
  // held at the handlebar 1.0 m up (people.ts), the wheels' bottom is at y = 1.0 + min.y
  between(1.0 + g.boundingBox!.min.y, -0.01, 0.01, 'stroller wheels above the ground (m)');
  // a real city stroller: ~0.6 m wide, ~0.95 m long, handle at the top; and cheap
  const sz = g.boundingBox!.getSize(new THREE.Vector3());
  between(sz.x, 0.55, 0.68, 'stroller width');
  between(sz.z, 0.85, 1.1, 'stroller length');
  const tris = g.getAttribute('position').count / 3;
  between(tris, 300, 1500, 'stroller triangles');
});

test('pushing a stroller: both hands are on its handlebar (two-bone IK), within 6 cm, while walking', async () => {
  allowModels(/assets\/people\//);
  const { Person, loadPeopleAssets } = await import('../src/nyc/people');
  const { Rng } = await import('../src/rng');
  const assets = await loadPeopleAssets();
  const r = new Rng(21);
  const found: InstanceType<typeof Person>[] = [];
  for (let i = 0; i < 400 && found.length < 4; i++) {
    const p = new Person(assets, r, i % 2 ? 'female' : 'male');
    if (p.noPhone && !p.dog && p.pose) found.push(p);
  }
  expect(found.length > 0, 'no stroller pushers');
  const bad: string[] = [];
  let checked = 0;
  for (const p of found) {
    const st = p.root.children.find((c) => (c as THREE.Mesh).isMesh && !!(c as THREE.Mesh).geometry.getAttribute('color')) as THREE.Mesh | undefined;
    if (!st) continue;
    p.setActivity('walk', 0);
    p.setSpeed(1.0);
    for (let i = 0; i < 40; i++) {
      p.update(1 / 30);
      p.root.updateMatrixWorld(true);
      if (i % 10) continue;
      for (const [hand, x] of [['hand_r', -0.17], ['hand_l', 0.17]] as const) {
        const h = bone(p.root, hand)!.getWorldPosition(new THREE.Vector3());
        const g = st.localToWorld(new THREE.Vector3(x, 0.02, -0.03));
        const d = h.distanceTo(g);
        checked++;
        if (d > 0.06) bad.push(`${p.gender} ${hand}: ${fmt(d)} m off the bar`);
      }
    }
  }
  console.log(`   ${found.length} pushers, ${checked} hand checks`);
  expect(checked > 0, 'no stroller found on the pushers');
  expect(!bad.length, bad.slice(0, 6).join('\n'));
});

test('near/far hand-off: the far proxy is as tall as the near body and painted the same, per person', async () => {
  // cheap: no FarCrowd. The far crowd bakes the person's own 2.5k-tri Body_LOD through the same
  // clips and draws it at pd.pos with scale scaleH, so the LOD posed by the person's skeleton, in
  // model space x scaleH, is what the far instance shows; the near body is the full mesh as drawn
  const ps = await people(40, 31);
  const bad: string[] = [];
  const dh: number[] = [];
  const box = new THREE.Box3(), loc = new THREE.Box3();
  for (const [i, p] of ps.entries()) {
    p.setActivity(i % 3 ? 'walk' : 'idle', (i * 0.13) % 1);
    p.update(1 / 30);
    p.root.updateMatrixWorld(true);
    const P = p as unknown as { fullMesh: THREE.SkinnedMesh | null; lodMesh: THREE.SkinnedMesh | null; far: { top: THREE.Color; bottom: THREE.Color; shoe: THREE.Color; skin: THREE.Color } };
    const full = P.fullMesh, lod = P.lodMesh;
    if (!full || !lod) { bad.push(`${p.gender} #${i}: no full/LOD body`); continue; }
    full.skeleton.update();
    // near: the full body as drawn (world), from the root's ground
    box.makeEmpty().expandByObject(full, true);
    const nearTop = box.max.y - p.root.position.y;
    // far: LOD posed by the same skeleton, back in the model's own frame, x scaleH from the ground
    loc.makeEmpty();
    const v = new THREE.Vector3(), inv = (p.root.children[0] as THREE.Object3D).matrixWorld.clone().invert();
    for (let k = 0; k < lod.geometry.attributes.position.count; k++) loc.expandByPoint(lod.getVertexPosition(k, v).applyMatrix4(lod.matrixWorld).applyMatrix4(inv));
    const farTop = loc.max.y * p.scaleH;
    dh.push(farTop - nearTop);
    if (Math.abs(farTop - nearTop) > 0.03) bad.push(`${p.gender} #${i}: far ${fmt(farTop)} m vs near ${fmt(nearTop)} m`);
    const u = (full.material as THREE.Material).userData.u as Record<string, { value: THREE.Color }> | undefined;
    if (!u) { bad.push('near body material has no paint uniforms'); continue; }
    for (const [k, f] of [['uTop', P.far.top], ['uBottom', P.far.bottom], ['uShoe', P.far.shoe], ['uSkin', P.far.skin]] as const) {
      const c = u[k].value;
      const d = Math.max(Math.abs(c.r - f.r), Math.abs(c.g - f.g), Math.abs(c.b - f.b));
      if (d > 0.02) bad.push(`${p.gender} #${i} ${k}: near #${c.getHexString()} far #${f.getHexString()}`);
    }
  }
  const m = dh.reduce((s, x) => s + x, 0) / Math.max(1, dh.length);
  console.log(`   ${dh.length} people: far - near height mean ${fmt(m * 100)} cm, worst ${fmt(Math.max(...dh.map(Math.abs)) * 100)} cm`);
  expect(dh.length > 0, 'nobody measured');
  expect(!bad.length, bad.slice(0, 8).join('\n'));
});

test('a backpack stays on the back through the walk cycle (top and bottom of its back panel within 3 cm of the back)', async () => {
  const { BODY, loadPeopleAssets } = await import('../src/nyc/people');
  const { slim } = await import('../src/nyc/peopleFar');
  const assets = await loadPeopleAssets();
  const all = await people(160, 41);
  const ps = all.filter((p) => p.packPart).slice(0, 8);
  expect(ps.length > 0, 'nobody with a backpack');
  const bad: string[] = [];
  const gaps: number[] = [];
  const v = new THREE.Vector3(), n = new THREE.Vector3(), c = new THREE.Vector3();
  for (const p of ps) {
    const P = p as unknown as { fullMesh: THREE.SkinnedMesh; propsMesh: THREE.SkinnedMesh; far: { style: THREE.Vector4 } };
    const full = P.fullMesh, props = P.propsMesh, [s0, cnt] = p.packPart!.range!;
    const female = p.gender === 'female';
    // the back as drawn: the shader's torso reshaping (this person's proportions) + the top's
    // inflation, applied to the bind positions, then skinned by the same skeleton
    const U = (full.material as THREE.Material).userData.u as Record<string, { value: THREE.Vector4 }>;
    const sh = [U.uShape.value.x, U.uShape.value.y, U.uShape.value.z, U.uShape2.value.x, U.uShape2.value.y, U.uShape2.value.z];
    const infl = [0.006, 0.014, 0.034, 0.02, 0.018][P.far.style.x];
    const G = assets.body[p.gender].geo, Gi = G.clone().invert(), nG = new THREE.Matrix3().getNormalMatrix(G);
    const g2 = full.geometry.clone();
    const pos = g2.attributes.position as THREE.BufferAttribute, nrm = g2.attributes.normal as THREE.BufferAttribute;
    const back: number[] = [];
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(G);
      if (Math.abs(v.x) > 0.07 || v.z > -0.02 || v.y < 0.9 || v.y > 1.5) continue;
      n.fromBufferAttribute(nrm, k).applyMatrix3(nG).normalize();
      slim(v, n, BODY[p.gender], female, sh);
      v.addScaledVector(n, infl).applyMatrix4(Gi);
      pos.setXYZ(k, v.x, v.y, v.z);
      back.push(k);
    }
    const drawn = new THREE.SkinnedMesh(g2, full.material);
    full.parent!.add(drawn);
    drawn.position.copy(full.position); drawn.quaternion.copy(full.quaternion); drawn.scale.copy(full.scale);
    drawn.bind(full.skeleton, full.bindMatrix);
    const model = p.root.children[0];
    p.setActivity('walk', 0);
    p.setSpeed(1.3);
    let lo = 1, hi = -1;
    for (let f = 0; f < 36; f++) {
      p.update(1 / 30);
      p.root.updateMatrixWorld(true);
      full.skeleton.update();
      const inv = model.matrixWorld.clone().invert();
      const pv: THREE.Vector3[] = [];
      for (let k = s0; k < s0 + cnt; k++) pv.push(props.getVertexPosition(k, new THREE.Vector3()).applyMatrix4(props.matrixWorld).applyMatrix4(inv));
      const ys = pv.map((q) => q.y), top = Math.max(...ys), bot = Math.min(...ys);
      const bv = back.map((k) => drawn.getVertexPosition(k, new THREE.Vector3()).applyMatrix4(drawn.matrixWorld).applyMatrix4(inv));
      // the centres of the pack's top and bottom thirds, each to the nearest point of the back
      for (const [a, b] of [[bot, bot + (top - bot) / 3], [top - (top - bot) / 3, top]]) {
        c.set(0, 0, 0);
        let m = 0;
        for (const q of pv) if (q.y >= a && q.y <= b) { c.add(q); m++; }
        c.divideScalar(Math.max(1, m));
        let d = 9;
        for (const q of bv) d = Math.min(d, q.distanceTo(c));
        const gap = d - 0.075; // the pack is 0.15 m deep: centre line to back panel
        gaps.push(gap);
        lo = Math.min(lo, gap);
        hi = Math.max(hi, gap);
      }
    }
    drawn.removeFromParent();
    g2.dispose();
    if (lo < -0.03 || hi > 0.03) bad.push(`${p.gender}: back panel ${fmt(lo * 100)}..${fmt(hi * 100)} cm off the back`);
  }
  console.log(`   ${ps.length} backpacks x 36 frames, top and bottom: back panel to back ${fmt(Math.min(...gaps) * 100)}..${fmt(Math.max(...gaps) * 100)} cm`);
  expect(!bad.length, bad.join('\n'));
});
