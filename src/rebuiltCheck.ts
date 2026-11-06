/**
 * Does a rebuilt GLB (public/rebuilt, Blender rebuild of the sand3d program) have the size and
 * orientation of its source USDA? Used by remote.ts to fall back to the USDA when not, and by
 * tests/materials.test.ts. Sizes are [x, y, z] in Y-up metres.
 */
export interface SizeCheck {
  /** median ratio of the sorted dimensions (got / want) */
  scale: number;
  /** the per-axis ratios agree with the sorted ones: not lying on its side */
  axesOk: boolean;
  ok: boolean;
}

export function checkSize(got: ArrayLike<number>, want: ArrayLike<number>, tol = 1.2): SizeCheck {
  const g = [got[0], got[1], got[2]], w = [want[0], want[1], want[2]];
  const ratios = [0, 1, 2].map((i) => g[i] / Math.max(w[i], 1e-6));
  const gs = [...g].sort((a, b) => a - b), ws = [...w].sort((a, b) => a - b);
  const sorted = [0, 1, 2].map((i) => gs[i] / Math.max(ws[i], 1e-6)).sort((a, b) => a - b);
  const scale = sorted[1];
  const spread = (r: number[]) => Math.max(...r) / Math.max(Math.min(...r), 1e-9);
  const axesOk = spread(ratios) < Math.max(1.35, spread(sorted) * 1.35);
  return { scale, axesOk, ok: axesOk && scale <= tol && scale >= 1 / tol };
}
