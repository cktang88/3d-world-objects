import type { OpenCtx } from './district-open';
import { apronMat, slab } from './district-tex';
import { CURB } from './common';

/** LaGuardia-style airport apron (filled in by the airport pass). */
export function buildAirport(c: OpenCtx) {
  const { inner, stat } = c;
  stat.add(slab(apronMat(), inner.minX, inner.maxX, inner.minZ, inner.maxZ, CURB * 0.5, 20));
}
