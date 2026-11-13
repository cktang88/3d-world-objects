// Look out of a 4th-floor apartment window in the real world (windowview.ts).
//   node scripts/shot.mjs --port <port> --url "/?mode=world" --max 600 --out after.png --eval "$(cat scripts/window-view.eval.js)"
//   ...&wv=0 for the painted backdrop (before)
(async () => {
  const W = window.__world;
  const sl = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 1200 && !(W.level && W.desc.kind === 'nyc' && !W.transitioning); i++) await sl(100);
  const V = W.player.pos.constructor;
  const at = (p) => p.box.getCenter(new V()).distanceTo(W.player.pos);
  const ps = W.level.portals().filter((p) => typeof p.target === 'object' && p.target.kind === 'floor' && p.target.floors >= 5 && p.door).sort((a, b) => Number(!/walkup|prewar/.test(a.target.type)) - Number(!/walkup|prewar/.test(b.target.type)) || at(a) - at(b));
  if (!ps.length) return 'no building of 5+ floors';
  await W.enter(ps[0]);
  for (let i = 0; i < 300 && W.transitioning; i++) await sl(100);
  if (W.desc.kind !== 'floor') return 'not in a lobby: ' + W.desc.kind;
  W.goFloor(3);
  await sl(300);
  const ap = W.level.portals().filter((p) => typeof p.target === 'object' && p.target.kind === 'interior').sort((a, b) => Number(a.target.style !== 'apartment') - Number(b.target.style !== 'apartment'));
  if (!ap.length) return 'no apartment door on floor 4';
  await W.enter(ap[0]);
  for (let i = 0; i < 300 && W.transitioning; i++) await sl(100);
  const wv = !/[?&]wv=0/.test(location.search);
  const mem = () => {
    if (window.gc) window.gc();
    const m = window.__mem();
    const city = [...W.seam.slots.values()].some((x) => x.desc.kind === 'nyc') ? 'city alive' : 'city dropped';
    return `${city}: geometries ${m.gpu.geometries}, textures ${m.gpu.textures}, programs ${m.gpu.programs}, heap ${m.heapMB} MB`;
  };
  let memAlive = '';
  for (let i = 0; i < 600 && wv && W.views.stats.faces < 5; i++) await sl(50);
  if (wv) memAlive = mem();
  for (let i = 0; i < 600 && wv && !W.views.stats.applied; i++) await sl(100);
  await sl(500);
  const mem1 = mem();
  const tod = (/[?&]wvtod=(\w+)/.exec(location.search) || [])[1];
  let mem2 = '';
  if (tod && wv) {
    W.lighting.setTime(tod, true);
    for (let i = 0; i < 4000 && W.views.stats.applied < 2; i++) await sl(100);
    mem2 = ` | after ${tod} recapture: ${mem()} (rebuilds ${W.views.stats.rebuilds}, refreshes ${W.views.stats.refreshes})`;
  }
  let mesh = null;
  W.level.group.traverse((o) => {
    const m = o.material;
    if (!mesh && o.isMesh && m && (m.userData.realView || (m.userData.windowView && m.emissiveMap))) mesh = o;
  });
  if (!mesh) { const mats = new Set(); W.level.group.traverse((o) => o.isMesh && o.material && mats.add((o.material.name || o.material.type) + (o.material.userData.windowView ? '*' : ''))); return 'no window in ' + W.level.name + ' stats ' + JSON.stringify(W.views.stats) + ' mats ' + [...mats].slice(0, 30).join(','); }
  // diagnostic: backdrops still painted vs on the capture, and the chosen window's room and material
  let painted = 0, real = 0;
  const paintedRooms = new Set();
  W.level.group.traverse((o) => {
    const m = o.material;
    if (!o.isMesh || !m) return;
    if (m.userData.realView) real++;
    else if (m.userData.windowView && m.emissiveMap) { painted++; let p = o; while (p.parent && !/^room:/.test(p.name)) p = p.parent; paintedRooms.add(p.name || '?'); }
  });
  let room = mesh; while (room.parent && !/^room:/.test(room.name)) room = room.parent;
  const u = mesh.material.uniforms;
  const diag = `diag: painted ${painted} [${[...paintedRooms]}] real ${real}; chosen in ${room.name || '?'} ${mesh.material.type}${u ? ` uNight ${u.uNight.value.toFixed(2)} uGain ${u.uGain.value.toFixed(2)}` : ''}`;
  mesh.updateWorldMatrix(true, false);
  const pos = mesh.geometry.attributes.position;
  const v = [0, 1, 2].map((i) => new V().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
  const c = new V().fromBufferAttribute(pos, 0).add(new V().fromBufferAttribute(pos, 1)).add(new V().fromBufferAttribute(pos, 2)).add(new V().fromBufferAttribute(pos, 3)).multiplyScalar(0.25).applyMatrix4(mesh.matrixWorld);
  const n = v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).setY(0).normalize();
  if (n.dot(W.level.spawn.pos.clone().sub(c)) < 0) n.negate();
  const p = c.clone().addScaledVector(n, 2.7).setY(0);
  W.player.place(p, Math.atan2(n.x, n.z));
  W.player.pitch = -0.12;
  // &wvdiag=1: the real-view material drawn black: is the pane in the shot ours?
  if (/[?&]wvdiag=1/.test(location.search)) W.level.group.traverse((o) => { if (o.isMesh && o.material && o.material.userData.realView) o.material.uniforms.uGain.value = 0; });
  await sl(1500);
  const s = W.views.stats;
  const tw = W.toWorld ? new V().setFromMatrixPosition(W.toWorld) : null;
  return `${W.level.name} via ${ps[0].label}; window ${s.lastWindow ? s.lastWindow.toArray().map((x) => x.toFixed(1)) : '-'} capture ${s.lastSpot ? s.lastSpot.toArray().map((x) => x.toFixed(1)) : '-'}; faces ${s.faces} (max ${s.maxFaceMs.toFixed(0)} ms) applied ${s.applied}; frame origin ${tw ? tw.toArray().map((x) => x.toFixed(1)) : '-'} | ${diag} | mem during capture: ${memAlive} | after: ${mem1}${mem2}`;
})();
