import * as THREE from 'three';
import './env';
import { test, expect } from './qa';
import { Kit } from '../src/rooms/kit';
import { kitchenRun } from '../src/rooms/furniture';
import { Rng } from '../src/rng';
import { scanZFight } from '../src/zfix';

test('kitchen worktop does not overlap the hob at counter height', () => {
  for (const fridgeAt of [-1, 0, 1] as const) for (const len of [1.8, 3, 4.5]) {
    const k = new Kit(), material = new THREE.MeshStandardMaterial();
    kitchenRun(k, new Rng(1), { len, cab: material, counter: material, splash: material, fridgeAt, rangeAt: 0.3, sinkAt: 0.7, uppers: true, ceilingH: 3 });
    const group = new THREE.Group();
    k.finish(group);
    const scan = scanZFight(group, { keepPairs: true });
    const hob = scan.list.filter((p) => p.n[1] > 0.99 && Math.abs(p.at[1] - 0.92) < 0.001);
    expect(hob.length === 0, `${len}m fridge ${fridgeAt}: ${hob.length} overlapping top surfaces`);
  }
});
