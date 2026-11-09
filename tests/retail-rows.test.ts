import { test, expect, near } from './qa';
import { retailBays, RETAIL_PLANS } from '../src/shopkit/rows';

test('retail plans create distinct layouts with accessible cross aisles inside the original footprint', () => {
  const signatures = new Set<string>();
  for (const plan of RETAIL_PLANS) {
    const bays = retailBays(-5, 5, plan);
    signatures.add(JSON.stringify(bays));
    near(bays[0].center - bays[0].length / 2, -5, 1e-6, 'back extent');
    near(bays.at(-1)!.center + bays.at(-1)!.length / 2, 5, 1e-6, 'front extent');
    for (let i = 1; i < bays.length; i++) {
      const gap = bays[i].center - bays[i].length / 2 - bays[i - 1].center - bays[i - 1].length / 2;
      expect(gap >= 1.19, 'cross aisle >= 1.2m');
    }
  }
  expect(signatures.size === 3, 'three distinct arrangements');
  for (const plan of RETAIL_PLANS) expect(retailBays(0, 1.8, plan).length === 1, 'short run stays one usable fixture');
});
