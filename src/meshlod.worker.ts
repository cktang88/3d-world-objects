// LOD chains off the main thread (src/meshlod.ts): a 1.5M-triangle scan takes ~1-3 s to simplify.
import { simplifierReady, lodChain } from './meshlod-core';

self.onmessage = async (e: MessageEvent) => {
  const { id, ratios, index, position, normal, uv } = e.data;
  try {
    await simplifierReady;
    const levels = lodChain({ index, position, normal, uv }, ratios, { normalWeight: 0.5 }).slice(1);
    (self as unknown as Worker).postMessage({ id, levels }, levels.map((l) => l.index.buffer));
  } catch {
    (self as unknown as Worker).postMessage({ id, levels: null });
  }
};
