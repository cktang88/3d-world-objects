import * as THREE from 'three';
import { simplifierReady, lodChain, type MeshArrays } from './meshlod-core';

/**
 * Runtime LOD chains for heavy streamed models (Objaverse originals, Smithsonian scans: 0.2-1.5M triangles).
 * Each heavy mesh becomes a ScreenLOD whose levels share the original vertex buffers and differ only in
 * their index buffer (so a chain costs ~30 % more index memory, no extra vertices). Levels come from
 * meshoptimizer's attribute-aware simplifier (normals + uvs weighted, uv seams intact, so the model's own
 * base-colour and normal maps still fit), built in a worker. Switching is by screen-space error: the
 * coarsest level whose geometric error projects to <= ScreenLOD.pixels on screen.
 * See .claude/skills/mesh-simplification/SKILL.md.
 */

export interface LodOptions {
  /** meshes below this many triangles are left alone (default 40k) */
  minTris?: number;
  /** triangle ratios of the levels after the original (default 25 % and 6 %) */
  ratios?: number[];
  /** without a worker (tests, old browsers) only meshes up to this size are simplified on the main thread */
  syncMax?: number;
}

/** A THREE.LOD whose level `distance` holds that level's geometric error (geometry units). */
export class ScreenLOD extends THREE.LOD {
  /** allowed projected error in pixels (1 = invisible in practice; 2 is still hard to see) */
  static pixels = 1;
  /** viewport height in CSS pixels (follows the window; 1080 without one) */
  static screenHeight = typeof window !== 'undefined' && window.innerHeight > 1 ? window.innerHeight : 1080;
  private sphere: THREE.Sphere | null = null;
  readonly isScreenLOD = true;
  private level = 0;
  override getCurrentLevel() {
    return this.level;
  }
  override update(camera: THREE.Camera) {
    const levels = this.levels;
    if (!levels.length) return;
    let pick = 0;
    const cam = camera as THREE.PerspectiveCamera;
    if (levels.length > 1 && cam.isPerspectiveCamera) {
      if (!this.sphere) {
        const g = (levels[0].object as THREE.Mesh).geometry;
        if (!g.boundingSphere) g.computeBoundingSphere();
        this.sphere = g.boundingSphere!.clone();
      }
      const s = this.matrixWorld.getMaxScaleOnAxis();
      _c.copy(this.sphere.center).applyMatrix4(this.matrixWorld);
      _p.setFromMatrixPosition(camera.matrixWorld);
      const d = Math.max(0, _p.distanceTo(_c) - this.sphere.radius * s);
      // world size of one pixel at distance d
      const px = (d * 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / (cam.zoom * ScreenLOD.screenHeight);
      const allowed = px * ScreenLOD.pixels;
      for (let i = 1; i < levels.length; i++) {
        // 10 % hysteresis on the way to coarser levels against flicker at the boundary
        const e = levels[i].distance * s * (i > this.level ? 1.1 : 1);
        if (e <= allowed) pick = i;
        else break;
      }
    }
    for (let i = 0; i < levels.length; i++) levels[i].object.visible = i === pick;
    this.level = pick;
  }
}
const _c = new THREE.Vector3(), _p = new THREE.Vector3();
if (typeof window !== 'undefined' && window.addEventListener)
  window.addEventListener('resize', () => {
    if (window.innerHeight > 1) ScreenLOD.screenHeight = window.innerHeight;
  });

/** triangles a model draws at its finest level (ScreenLOD coarse levels are not counted) */
export function lodTris(root: THREE.Object3D) {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m.userData.lodLevel ?? 0) > 0) return;
    n += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
  });
  return n;
}

function floats(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, size: number): Float32Array | null {
  if (!a) return null;
  if (a instanceof THREE.BufferAttribute && a.array instanceof Float32Array && !a.normalized && a.itemSize === size) return a.array;
  const out = new Float32Array(a.count * size);
  for (let i = 0; i < a.count; i++) {
    out[i * size] = a.getX(i);
    if (size > 1) out[i * size + 1] = a.getY(i);
    if (size > 2) out[i * size + 2] = a.getZ(i);
  }
  return out;
}

export function meshArrays(g: THREE.BufferGeometry): MeshArrays | null {
  if (!g.index) return null;
  return {
    index: g.index.array instanceof Uint32Array ? g.index.array : new Uint32Array(g.index.array as ArrayLike<number>),
    position: floats(g.getAttribute('position') as THREE.BufferAttribute, 3)!,
    normal: floats(g.getAttribute('normal') as THREE.BufferAttribute, 3),
    uv: floats(g.getAttribute('uv') as THREE.BufferAttribute, 2),
  };
}

let worker: Worker | null | undefined;
let jobId = 0;
const jobs = new Map<number, (r: { index: Uint32Array; error: number }[] | null) => void>();
function getWorker() {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./meshlod.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const { id, levels } = e.data as { id: number; levels: { index: Uint32Array; error: number }[] | null };
      jobs.get(id)?.(levels);
      jobs.delete(id);
    };
    worker.onerror = () => {
      for (const r of jobs.values()) r(null);
      jobs.clear();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

async function chain(m: MeshArrays, ratios: number[], syncMax: number) {
  const w = getWorker();
  if (w) {
    const id = ++jobId;
    // copies go to the worker (the originals stay on the geometry)
    const msg = { id, ratios, index: m.index.slice(), position: m.position.slice(), normal: m.normal?.slice() ?? null, uv: m.uv?.slice() ?? null };
    const res = await new Promise<{ index: Uint32Array; error: number }[] | null>((resolve) => {
      jobs.set(id, resolve);
      w.postMessage(msg, [msg.index.buffer, msg.position.buffer, ...(msg.normal ? [msg.normal.buffer] : []), ...(msg.uv ? [msg.uv.buffer] : [])]);
    });
    if (res) return res;
  }
  if (m.index.length / 3 > syncMax) return null;
  await simplifierReady;
  return lodChain(m, ratios, { normalWeight: 0.5 }).slice(1);
}

/**
 * Give every heavy mesh under `root` a screen-space LOD chain (in place). Resolves with the number of
 * meshes changed. Safe to call on anything: light meshes, non-indexed or skinned geometry are skipped.
 */
export async function addLods(root: THREE.Object3D, opts: LodOptions = {}): Promise<number> {
  const minTris = opts.minTris ?? 40_000;
  const ratios = opts.ratios ?? [0.25, 0.06];
  const heavy: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || !m.geometry.index || m.parent instanceof ScreenLOD) return;
    if (m.geometry.index.count / 3 >= minTris) heavy.push(m);
  });
  let n = 0;
  for (const mesh of heavy) {
    const arrays = meshArrays(mesh.geometry);
    if (!arrays) continue;
    const levels = await chain(arrays, ratios, opts.syncMax ?? 300_000).catch(() => null);
    if (!levels?.length || !mesh.parent) continue;
    const lod = new ScreenLOD();
    lod.name = mesh.name;
    lod.position.copy(mesh.position);
    lod.quaternion.copy(mesh.quaternion);
    lod.scale.copy(mesh.scale);
    lod.userData = { ...mesh.userData };
    const parent = mesh.parent;
    parent.add(lod);
    parent.remove(mesh);
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    mesh.userData.lodLevel = 0;
    lod.addLevel(mesh, 0);
    levels.forEach((l, i) => {
      const g = new THREE.BufferGeometry();
      for (const [k, a] of Object.entries(mesh.geometry.attributes)) g.setAttribute(k, a); // shared vertex buffers
      g.setIndex(new THREE.BufferAttribute(l.index, 1));
      g.boundingBox = mesh.geometry.boundingBox;
      g.boundingSphere = mesh.geometry.boundingSphere;
      for (const gr of mesh.geometry.groups) g.addGroup(0, l.index.length, gr.materialIndex);
      const m = new THREE.Mesh(g, mesh.material);
      m.castShadow = mesh.castShadow;
      m.receiveShadow = mesh.receiveShadow;
      m.name = `${mesh.name}:lod${i + 1}`;
      m.userData.lodLevel = i + 1;
      lod.addLevel(m, l.error);
    });
    n++;
  }
  return n;
}
