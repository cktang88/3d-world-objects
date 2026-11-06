/**
 * Visibility counts at the fixed street poses (the Node twin of scripts/viscount.mjs): a real 3x3
 * set of blocks around the spawn, counted with the chunk visibility system off and on. Prints the
 * in-view meshes (≈ main-pass draws) and triangles; fails if visibility ever adds work.
 *   QA_VERBOSE=1 npm run qa -- viscount
 */
import * as THREE from 'three';
import { test, expect } from './qa';
import { nycChunk } from './world';
import { CityVis } from '../src/nyc/occlusion';
import { countVisible, VIS_POSES } from '../src/lab/viscount';
import { AX, SZ } from '../src/nyc/common';

test('viscount: street poses, chunk visibility off vs on (3x3 real blocks)', () => {
  const root = new THREE.Group();
  const vis = new CityVis();
  vis.attach(root);
  for (let cz = -1; cz <= 1; cz++)
    for (let cx = -1; cx <= 1; cx++) {
      const c = nycChunk(1, cx, cz);
      c.group.position.set(cx * AX, 0, cz * SZ);
      c.group.updateMatrixWorld(true);
      root.add(c.group);
      vis.add(cx, cz, c.group);
    }
  const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
  const lines: string[] = [];
  for (const pose of VIS_POSES) {
    const p = new THREE.Vector3(...pose.pos);
    cam.position.set(p.x, p.y + 1.6, p.z);
    cam.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ');
    const cx = Math.round(p.x / AX), cz = Math.round(p.z / SZ);
    vis.enabled = false;
    vis.update(cam.position, cx, cz, 1, 1);
    const off = countVisible(root, cam, null);
    vis.enabled = true;
    vis.update(cam.position, cx, cz, 1, 1);
    const on = countVisible(root, cam, null);
    lines.push(`${pose.name}: calls ${off.calls} -> ${on.calls}, tris ${off.tris} -> ${on.tris}, shadow casters ${off.shadowCasters} -> ${on.shadowCasters}, chunks ${off.chunksDrawn} -> ${on.chunksDrawn} (${JSON.stringify(vis.stats)})`);
    expect(on.calls <= off.calls + 2, `${pose.name}: visibility added draws (${off.calls} -> ${on.calls})`);
  }
  console.log(lines.join("\n"));
  console.log(vis.debug());
});
