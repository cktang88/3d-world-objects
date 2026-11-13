/** Building lobbies (src/rooms/lobbies.ts): variety across buildings, sculpture on plinths at real size, a clear way to the lifts, staff at their posts. */
import { test, expect, between, Grid, insideRect } from './qa';
import './env';
import { FloorLevel } from '../src/rooms/vertical';
import { slotsUnder } from '../src/nyc/district-showcase';

const TYPES = ['office', 'office', 'office', 'office', 'office', 'office', 'prewar', 'prewar', 'prewar', 'prewar', 'loft', 'loft'];
const lobby = (type: string, seed: number) => new FloorLevel({ kind: 'floor', seed, name: `QA ${type} ${seed}`, type, floor: 0, floors: 9 });

test('lobbies: 12 buildings show at least 5 styles; same building, same lobby', () => {
  const styles = new Set<string>();
  const seen: string[] = [];
  TYPES.forEach((type, i) => {
    const a = lobby(type, 1000 + i * 37), b = lobby(type, 1000 + i * 37);
    expect(a.lobbyStyle?.id === b.lobbyStyle?.id, `${type} #${i}: consistent on revisits`);
    styles.add(a.lobbyStyle!.id);
    seen.push(`${type}:${a.lobbyStyle!.id}`);
  });
  console.log('   ' + seen.join(' '));
  expect(styles.size >= 5, `${styles.size} distinct styles (${[...styles].join(', ')})`);
});

test('lobbies: sculpture stands on a plinth (or the floor) and fits at real size; aisles clear to the lifts; staff at their posts', () => {
  for (let i = 0; i < TYPES.length; i++) {
    const type = TYPES[i], lv = lobby(type, 1000 + i * 37);
    const b = lv.lobbyBuilt!;
    const id = `${type}:${lv.lobbyStyle!.id}#${i}`;
    expect(!!b, `${id}: furnished`);
    // sculpture: every showcase slot sits on one of the plinths, sized for a real statue (no miniatures)
    const slots = slotsUnder(lv.group);
    for (const s of slots) {
      const on = b.plinths.find((p) => Math.abs(p.x - s.x) < 1e-6 && Math.abs(p.z - s.z) < 1e-6);
      expect(!!on && Math.abs((s.y ?? 0) - on.top) < 1e-6, `${id}: statue slot on its plinth`);
      between(s.min ?? 0, 0.4, 1.5, `${id}: statue min size`);
      between(s.h ?? 0, 1.5, 6, `${id}: statue height room`);
      between(on!.top, 0, 1.0, `${id}: plinth height`);
    }
    // the way in: from the street door to the hall and to every lift's door
    const d = lv.d;
    const g = new Grid({ minX: -20, maxX: 20, minZ: d.zBack - 4, maxZ: d.zS + 2 }, lv.colliders(), 0.1, 0.3);
    const reach = g.flood(lv.spawn.pos.x, lv.spawn.pos.z);
    expect(reach(0, d.Ld + 1.0, 0.5), `${id}: street door -> hall`);
    for (const l of lv.lifts) {
      const f = l.frame, x = f.x + Math.sin(f.r) * 1.0, z = f.z + Math.cos(f.r) * 1.0;
      expect(reach(x, z, 0.5), `${id}: street door -> lift at ${x.toFixed(1)},${z.toFixed(1)}`);
    }
    // staff: inside the lobby room, standing clear of furniture, a doorman by the door / a guard by the desk
    for (const p of b.staff) {
      expect(p.z > d.zH1 - 0.01 && p.z < d.zS && Math.abs(p.x) < d.lw / 2, `${id}: ${p.role} inside the lobby`);
      expect(!lv.colliders().some((c) => insideRect(c, p.x, p.z, 0.2)), `${id}: ${p.role} not standing in furniture`);
      if (p.role === 'doorman') expect(d.zS - p.z < 2.5, `${id}: doorman by the door`);
    }
    const residential = type === 'prewar';
    expect(b.staff.some((p) => p.role === (residential ? 'doorman' : 'guard')), `${id}: ${residential ? 'a doorman' : 'a guard'} on duty`);
  }
});
