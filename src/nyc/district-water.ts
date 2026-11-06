import type { OpenCtx } from './district-open';
import { waterMat, slab } from './district-tex';

/** The rivers and the Hudson River Park piers (filled in by the waterfront pass). */
export function buildWater(c: OpenCtx) {
  const { inner, group } = c;
  group.add(slab(waterMat(), inner.minX, inner.maxX, inner.minZ, inner.maxZ, -1.2, 12));
}
