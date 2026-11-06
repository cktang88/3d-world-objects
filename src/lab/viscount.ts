import * as THREE from 'three';
import type { LabScene } from '../lab';
import { NycLevel } from '../nyc';

/**
 * ?lab=viscount — cheap visibility counts for the NYC level, no rendering of the city.
 *
 * Builds the real streamed level (not added to the scene), and for each fixed pose (the same as
 * scripts/perf.mjs) steps level.update() at that position so streaming and the visibility system
 * (ring hiding, occlusion, HLOD, tree LOD) run, then counts what a camera there would draw:
 * in-frustum visible meshes ≈ main-pass draw calls, their triangles (BatchedMesh: drawn ranges of
 * in-frustum instances), and shadow casters among them. Result in window.__viscount.
 * scripts/viscount.mjs drives it from the command line.
 */
export const VIS_POSES = [
  { name: 'avenue', pos: [50.5, 0, 0], yaw: -Math.PI / 2, pitch: 0 },
  { name: 'cross-street', pos: [0, 0, 25.5], yaw: Math.PI / 2, pitch: 0 },
  { name: 'corner-down-avenue', pos: [56, 0, 29], yaw: 0, pitch: 0.02 },
  { name: 'elevated', pos: [20, 45, 28], yaw: 0.6, pitch: -0.45 },
] as const;

export interface VisCount {
  calls: number;
  tris: number;
  shadowCasters: number;
  shadowTris: number;
  chunksDrawn: number;
  chunksLoaded: number;
  instancedTris: number;
  sprites: number;
}

export function countVisible(root: THREE.Object3D, cam: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer | null): VisCount {
  cam.updateMatrixWorld();
  root.updateMatrixWorld(true);
  // run the draw-less per-frame hooks (tree LOD drivers) for this camera, as the renderer would
  if (renderer) root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry.drawRange.count === 0) m.onBeforeRender(renderer, null as unknown as THREE.Scene, cam, m.geometry, m.material as THREE.Material, null as unknown as THREE.Group);
  });
  root.traverse((o) => { if ((o as THREE.LOD).isLOD) (o as THREE.LOD).update(cam); });
  const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const r: VisCount = { calls: 0, tris: 0, shadowCasters: 0, shadowTris: 0, chunksDrawn: 0, chunksLoaded: 0, instancedTris: 0, sprites: 0 };
  for (const ch of root.children) if (ch.userData.chunk) { r.chunksLoaded++; if (ch.visible) r.chunksDrawn++; }
  const mtx = new THREE.Matrix4(), sph = new THREE.Sphere();
  root.traverseVisible((o) => {
    if ((o as THREE.Sprite).isSprite) { r.sprites++; return; }
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.geometry.drawRange.count === 0) return;
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh && im.count === 0) return;
    if (o.frustumCulled && !fr.intersectsObject(o)) return;
    const g = m.geometry;
    let n = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    const bm = o as THREE.BatchedMesh;
    if (bm.isBatchedMesh) {
      n = 0;
      for (let i = 0; i < bm.instanceCount; i++) {
        try {
          if (!bm.getVisibleAt(i)) continue;
          const gid = bm.getGeometryIdAt(i);
          bm.getMatrixAt(i, mtx);
          bm.getBoundingSphereAt(gid, sph);
          sph.applyMatrix4(mtx).applyMatrix4(bm.matrixWorld);
          if (!fr.intersectsSphere(sph)) continue;
          n += (bm.getGeometryRangeAt(gid)?.count ?? 0) / 3;
        } catch {
          /* deleted instance */
        }
      }
      if (n === 0) return;
    } else if (im.isInstancedMesh) {
      n *= im.count;
      r.instancedTris += n;
    }
    r.calls++;
    r.tris += n;
    if (o.castShadow) {
      r.shadowCasters++;
      r.shadowTris += n;
    }
  });
  r.tris = Math.round(r.tris);
  r.shadowTris = Math.round(r.shadowTris);
  r.instancedTris = Math.round(r.instancedTris);
  return r;
}

const scene: LabScene = {
  name: 'viscount',
  description: 'visibility counts of the NYC level at fixed poses, no city rendering (&poses=a,b)',
  cam: [0, 2, 5],
  look: [0, 1, 0],
  env: 'studio',
  ground: false,
  async build({ params, renderer }) {
    const want = params.get('poses')?.split(',');
    const out: Record<string, VisCount & { buildMs: number; vis: string }> = {};
    const level = new NycLevel({ kind: 'nyc', seed: Number(params.get('seed') ?? 20261105), name: 'viscount' });
    level.vis.enabled = params.get('vis') !== '0'; // &vis=0: counts without chunk visibility
    const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
    const steps = Number(params.get('steps') ?? 60);
    for (const pose of VIS_POSES) {
      if (want && !want.includes(pose.name)) continue;
      const p = new THREE.Vector3(...pose.pos);
      const t0 = performance.now();
      // step until streaming settles (chunk builds are time-sliced across frames)
      for (let i = 0; i < steps || (level.streaming && i < 20000); i++) level.update(1 / 60, p, i / 60);
      const buildMs = Math.round(performance.now() - t0);
      cam.position.set(p.x, p.y + 1.6, p.z);
      cam.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ');
      // two passes: the first lets lazy work (impostor bakes, LOD switches) settle
      countVisible(level.group, cam, renderer);
      await new Promise((r) => setTimeout(r, 300));
      level.update(1 / 60, p, steps / 60);
      out[pose.name] = { ...countVisible(level.group, cam, renderer), buildMs, vis: level.vis.debug() };
    }
    (window as unknown as { __viscount: unknown }).__viscount = out;
    level.dispose();
  },
};
export default scene;
