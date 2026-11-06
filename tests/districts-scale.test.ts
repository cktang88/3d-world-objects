/** NYC districts: showcase vehicles, aircraft and boats end up at real size whatever scale their source used. */
import { readFileSync } from 'fs';
import { test, expect, none, fmt } from './qa';
import { realScale } from '../src/realscale';
import { RANGES, plausible } from '../src/nyc/district-showcase';

const pools = JSON.parse(readFileSync('public/districts/pools.json', 'utf8')) as Record<string, unknown[][]>;
/** typical proportions (length, height, width) of each pool's objects */
const SHAPE: Record<string, [number, number, number]> = {
  car: [4.6, 1.5, 1.9], carShow: [4.6, 1.5, 1.9], truck: [7, 3, 2.5], bike: [1.9, 1.1, 0.7], train: [18, 4.2, 3],
  plane: [12, 3.5, 11], planeStand: [38, 11, 35], deckPlane: [16, 4.5, 11], heli: [13, 4, 3], boat: [8, 3, 2.6], structure: [5, 3.2, 4], folly: [5, 3.5, 4],
};

test('every showcase car / truck / aircraft / boat lands in its real range at any source scale', () => {
  const bad: string[] = [];
  let n = 0;
  for (const kind of Object.keys(RANGES)) {
    const R = RANGES[kind];
    const [L, H, W] = SHAPE[kind];
    for (const row of pools[kind] ?? []) {
      const [, , , , family, entry, title, , , , , , , , ] = row as string[];
      const ds = row[0] as string;
      // the same object exported at toy, model, real and huge scales
      for (const s of [0.01, 0.2, 1, 3.5, 60]) {
        const x = L * s, y = H * s, z = W * s;
        const k = realScale(title, entry, family, Math.max(x, y, z), ds);
        const f = plausible(kind, x * k, y * k, z * k);
        n++;
        if (f === null) { if (!R.keep) bad.push(`${kind} '${title}' at x${s}: rejected`); continue; }
        const len = Math.max(x, z) * k * f, h = y * k * f;
        if (len < R.len[0] - 1e-6 || len > R.len[1] + 1e-6 || h < R.h[0] - 1e-6 || h > R.h[1] + 1e-6) bad.push(`${kind} '${title}' at x${s}: ${fmt(len)} x ${fmt(h)} m`);
      }
    }
  }
  expect(n > 2000, `only ${n} cases`);
  none(bad, 'showcase objects outside their real range');
});

test('cars are 3.6-6 m long and 1.3-2.1 m tall; a cube in a car slot is rejected', () => {
  const f = plausible('car', 0.9, 0.35, 0.4)!; // a 0.9 m toy-scale car
  expect(f !== null && Math.abs(0.9 * f - 4.6) < 0.01 && 0.35 * f >= 1.3 && 0.35 * f <= 2.1, `toy car rescaled by ${f}`);
  expect(plausible('car', 2, 2, 2) === null, 'a 2 m cube passes as a car');
  expect(plausible('carShow', 4.8, 1.45, 1.9) === 1, 'a real-size car was rescaled');
  expect(plausible('statue', 0.3, 0.3, 0.3) === 1, 'pools without a range must pass unchanged');
});
