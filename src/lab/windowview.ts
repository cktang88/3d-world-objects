import * as THREE from 'three';
import type { LabScene } from '../lab';
import { viewMaterial, captureSpot, type ViewEntry } from '../windowview';

/**
 * ?lab=windowview: the window-view shader on a dummy HDR cubemap (bright saturated blue sky up,
 * blue horizon, warm street down), four quads left to right: night as shipped; gain 0 (must be
 * black); the night correction off (uNight 0, night grade); day (no grade). Tests the maths alone.
 */
const scene: LabScene = {
  name: 'windowview',
  description: 'window-view shader on a dummy night cubemap: night / gain 0 / correction off / day',
  cam: [0, 1.5, 4.2],
  look: [0, 1.5, 0],
  env: 'studio',
  ground: false,
  build({ group, renderer }) {
    const rt = new THREE.WebGLCubeRenderTarget(32, { type: THREE.HalfFloatType, generateMipmaps: false });
    const faces: [number, number, number][] = [[0.05, 0.08, 0.6], [0.05, 0.08, 0.6], [0.1, 0.2, 4.0], [1.5, 0.9, 0.4], [0.05, 0.08, 0.6], [0.05, 0.08, 0.6]];
    const prev = renderer.getRenderTarget(), clear = renderer.getClearColor(new THREE.Color()), a = renderer.getClearAlpha();
    faces.forEach(([r, g, b], i) => {
      renderer.setRenderTarget(rt, i);
      renderer.setClearColor(new THREE.Color(r, g, b), 1);
      renderer.clear();
    });
    renderer.setRenderTarget(prev);
    renderer.setClearColor(clear, a);
    const spot = captureSpot(new THREE.Vector3(0, 1.5, -10), []);
    const e: ViewEntry = { key: 'lab', rt, spot, faces: 6 };
    const night = { gain: new THREE.Vector3(0.97, 0.98, 1), lift: new THREE.Vector3(0.02, 0.027, 0.07), sat: 1.12, contrast: 1.08, night: 1 };
    const variants = [
      viewMaterial(e, new THREE.Matrix4(), 1.35, night),
      viewMaterial(e, new THREE.Matrix4(), 0, night),
      viewMaterial(e, new THREE.Matrix4(), 1.35, { ...night, night: 0 }),
      viewMaterial(e, new THREE.Matrix4(), 1, null),
    ];
    variants.forEach((m, i) => {
      const q = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 2.2), m);
      q.position.set((i - 1.5) * 1.0, 1.5, 0);
      group.add(q);
    });
  },
};
export default scene;
