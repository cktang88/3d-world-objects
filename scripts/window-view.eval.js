// Look out of a 4th-floor apartment window in the real world (windowview.ts).
//   node scripts/shot.mjs --port <port> --url "/?mode=world" --max 600 --out after.png --eval "$(cat scripts/window-view.eval.js)"
//   ...&wv=0 for the painted backdrop (before)
(async () => {
  const W = window.__world;
  const sl = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 1200 && !(W.level && W.desc.kind === 'nyc' && !W.transitioning); i++) await sl(100);
  const V = W.player.pos.constructor;
  const at = (p) => p.box.getCenter(new V()).distanceTo(W.player.pos);
  const ps = W.level.portals().filter((p) => typeof p.target === 'object' && p.target.kind === 'floor' && p.target.floors >= 5 && p.door).sort((a, b) => at(a) - at(b));
  if (!ps.length) return 'no building of 5+ floors';
  await W.enter(ps[0]);
  for (let i = 0; i < 300 && W.transitioning; i++) await sl(100);
  if (W.desc.kind !== 'floor') return 'not in a lobby: ' + W.desc.kind;
  W.goFloor(3);
  await sl(300);
  const ap = W.level.portals().filter((p) => typeof p.target === 'object' && p.target.kind === 'interior');
  if (!ap.length) return 'no apartment door on floor 4';
  await W.enter(ap[0]);
  for (let i = 0; i < 300 && W.transitioning; i++) await sl(100);
  const wv = !/[?&]wv=0/.test(location.search);
  for (let i = 0; i < 600 && wv && !W.views.stats.applied; i++) await sl(100);
  let mesh = null;
  W.level.group.traverse((o) => {
    const m = o.material;
    if (!mesh && o.isMesh && m && (m.userData.realView || (m.userData.windowView && m.emissiveMap))) mesh = o;
  });
  if (!mesh) return 'no window in ' + W.level.name;
  mesh.updateWorldMatrix(true, false);
  const pos = mesh.geometry.attributes.position;
  const v = [0, 1, 2].map((i) => new V().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
  const c = new V().fromBufferAttribute(pos, 0).add(new V().fromBufferAttribute(pos, 1)).add(new V().fromBufferAttribute(pos, 2)).add(new V().fromBufferAttribute(pos, 3)).multiplyScalar(0.25).applyMatrix4(mesh.matrixWorld);
  const n = v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).setY(0).normalize();
  if (n.dot(W.level.spawn.pos.clone().sub(c)) < 0) n.negate();
  const p = c.clone().addScaledVector(n, 2.7).setY(0);
  W.player.place(p, Math.atan2(n.x, n.z));
  W.player.pitch = -0.12;
  await sl(1500);
  const s = W.views.stats;
  const tw = W.toWorld ? new V().setFromMatrixPosition(W.toWorld) : null;
  return `${W.level.name} via ${ps[0].label}; window ${s.lastWindow ? s.lastWindow.toArray().map((x) => x.toFixed(1)) : '-'} capture ${s.lastSpot ? s.lastSpot.toArray().map((x) => x.toFixed(1)) : '-'}; faces ${s.faces} applied ${s.applied}; frame origin ${tw ? tw.toArray().map((x) => x.toFixed(1)) : '-'}`;
})();
