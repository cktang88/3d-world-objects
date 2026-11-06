/**
 * Shrinking into an object (src/macro.ts): the world matches the object (a garden in a plant, the inside of
 * a container, a circuit board in a device, a macro surface for food, its own surface for anything else),
 * the player spawns on walkable ground, and no city is generated unless the object is city-like.
 */
import * as THREE from 'three';
import { test, expect, between, insideRect } from './qa';
import './env';
import { MacroLevel, macroMode, shrinkInto } from '../src/macro';
import type { ModelEntry } from '../src/assets';
import type { LevelDesc } from '../src/level';

async function manifest(): Promise<ModelEntry[]> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public', 'models', 'manifest.json'), 'utf8'));
}

const EXPECT: Record<string, string> = { plant: 'garden', container: 'vessel', storage: 'vessel', electronics: 'circuit', food: 'food', tool: 'surface', building: 'city' };

test('shrink-in builds a world from the object: 7 roles, kind matches, walkable spawn, no city below depth 0 unless city-like', async () => {
  const all = await manifest();
  const levels: string[] = [];
  for (const [role, want] of Object.entries(EXPECT)) {
    const e = all.find((m) => m.role === role);
    expect(!!e, `a ${role} in the manifest`);
    const size = Math.max(...e!.size) * (role === 'building' ? 0.05 : 0.3 / Math.max(...e!.size)); // as placed: a 30 cm object, a 5% model building
    const p = shrinkInto(e!, size, 1234, 'town');
    const t = p.target as LevelDesc;
    expect(/^Shrink into /.test(p.label) && !!p.sub, `${role}: the prompt says what it is ("${p.label}" — ${p.sub})`);
    if (want === 'city') {
      expect(t.kind === 'city', `${role} (city-like): a town at its scale`);
      continue;
    }
    expect(t.kind === 'macro', `${role}: not a city (got ${t.kind})`);
    expect(t.kind === 'macro' && t.mode === want, `${role}: ${want} world (got ${(t as { mode?: string }).mode})`);
    const lv = new MacroLevel(t as Extract<LevelDesc, { kind: 'macro' }>);
    const s = lv.spawn.pos;
    expect(Math.abs(s.y) < 1e-6, `${role}: spawn on the ground plane`);
    expect(Math.hypot(s.x, s.z) < lv.radius - 1, `${role}: spawn inside the walkable disc`);
    const blocked = lv.colliders().filter((c) => insideRect(c, s.x, s.z, 0.35));
    expect(blocked.length === 0, `${role}: spawn not inside a collider`);
    // real scale: the depth counter's shrink matches k (shrink / 1000 = 1 / k)
    between(p.shrink! / 1000, 0.99 / lv.k, 1.01 / lv.k, `${role}: depth counter scale`);
    // cheap: few meshes
    let meshes = 0;
    lv.group.traverse((o) => (o as THREE.Mesh).isMesh && meshes++);
    expect(meshes < 80, `${role}: ${meshes} meshes`);
    levels.push(`${role}→${want} k=${lv.k.toFixed(0)} meshes=${meshes}`);
    lv.dispose();
  }
  console.log('   ' + levels.join('; '));
  expect(macroMode({ role: 'building', family: 'building' }) === null, 'buildings keep the city');
});
