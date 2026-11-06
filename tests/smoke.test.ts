import { test, stats } from './qa';
import { nycChunk } from './world';
test('one chunk', () => {
  for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [3, -2]]) {
    const c = nycChunk(1, cx, cz);
    console.log('chunk', cx, cz, Math.round(c.ms), 'ms', JSON.stringify(stats(c.group)), c.colliders.length, c.portals.length);
  }
});
