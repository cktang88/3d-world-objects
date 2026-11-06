import type { BCtx } from './buildings';
import type { District } from './districts';
import type { Plan } from './district-build';

/**
 * Blocks with something other than buildings on part of them: auto row showrooms and lots,
 * construction sites, the greenmarket plaza, rail and container yards, the museum steps.
 * Returns which default frontages nyc.ts should still build.
 */
export function customBlock(ctx: BCtx, d: District): Plan {
  void ctx;
  void d;
  return { ave: [true, true], rows: [true, true] };
}
