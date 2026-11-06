import * as THREE from 'three';
import type { Level } from './level';

/**
 * Dev probes (?probe=pedcar): checks that run in the real game, logged to the console.
 *
 * pedcar: once a second, every pedestrian against the bounding box of every vehicle mesh in the level
 * (moving traffic, parked cars, showcase vehicles: anything carrying userData.model / userData.len /
 * userData.vehicle), grown by 0.3 m. Logs who is how close to what, and keeps a tally in
 * window.__probe.pedcar. Costs a few ms a second; off unless asked for.
 */
const box = new THREE.Box3();
const near = new THREE.Box3();
let last = -1;
const tally = { checks: 0, hits: 0, log: [] as string[] };

export function probePedCar(level: Level, time: number) {
  if (time - last < 1) return;
  last = time;
  const peds = (level as unknown as { peds?: { peds?: { pos: THREE.Vector3; state: string; axis: string }[] } }).peds?.peds;
  if (!peds?.length) return;
  const vehicles: { name: string; box: THREE.Box3 }[] = [];
  level.group.traverse((o) => {
    const u = o.userData;
    if (!(u.model || u.len || u.vehicle) || !o.visible) return;
    box.makeEmpty();
    box.setFromObject(o);
    if (box.isEmpty()) return;
    vehicles.push({ name: String(u.model ?? u.kind ?? o.name ?? 'vehicle'), box: box.clone() });
  });
  tally.checks++;
  for (const pd of peds) {
    for (const v of vehicles) {
      near.copy(v.box).expandByScalar(0.3);
      if (pd.pos.y > v.box.max.y || !near.containsPoint(new THREE.Vector3(pd.pos.x, Math.max(pd.pos.y, near.min.y + 0.01), pd.pos.z))) continue;
      const inside = v.box.containsPoint(new THREE.Vector3(pd.pos.x, v.box.min.y + 0.01, pd.pos.z));
      tally.hits++;
      const line = `[probe pedcar] t=${time.toFixed(1)} person (${pd.state}, along ${pd.axis}) at ${pd.pos.x.toFixed(2)},${pd.pos.z.toFixed(2)} ${inside ? 'INSIDE' : 'within 0.3 m of'} ${v.name} ${v.box.min.x.toFixed(2)}..${v.box.max.x.toFixed(2)} x ${v.box.min.z.toFixed(2)}..${v.box.max.z.toFixed(2)}`;
      tally.log.push(line);
      if (tally.log.length > 200) tally.log.shift();
      console.warn(line);
    }
  }
  (window as unknown as { __probe: { pedcar: typeof tally } }).__probe = { pedcar: tally };
}
