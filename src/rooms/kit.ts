import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * A static-geometry batcher for procedural interiors. Everything drawn through a Kit is merged
 * into one mesh per material when the room is finished, so a whole building of mouldings,
 * radiators, cabinets and books costs a few dozen draw calls.
 *
 * Coordinates: push() a frame (position + rotation about y), then draw in that local frame.
 * box() takes its base centre (like build.ts box()). UVs default to world metres projected on
 * the face's dominant axis, so tiled PBR surfaces (`surface(key, [1, 1])`) come out at real scale.
 */
export type UVMode = 'world' | 'keep';

const unitBox = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
const cylCache = new Map<string, THREE.BufferGeometry>();
const rboxCache = new Map<string, THREE.BufferGeometry>();

export class Kit {
  private bins = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  private tmp = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  tris = 0;

  get m() {
    return this.stack[this.stack.length - 1];
  }
  push(x: number, y: number, z: number, rotY = 0) {
    this.q.setFromAxisAngle(this.up, rotY);
    const t = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(1, 1, 1));
    this.stack.push(this.m.clone().multiply(t));
    return this;
  }
  pop() {
    if (this.stack.length > 1) this.stack.pop();
    return this;
  }
  /** run fn in a local frame */
  at(x: number, y: number, z: number, rotY: number, fn: () => void) {
    this.push(x, y, z, rotY);
    try {
      fn();
    } finally {
      this.pop();
    }
  }

  /** add any geometry (cloned) under the current frame with an extra local matrix */
  add(geo: THREE.BufferGeometry, mat: THREE.Material, local?: THREE.Matrix4, uv: UVMode = 'world', uvScale: [number, number] = [1, 1]) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    if (uv === 'keep' && (uvScale[0] !== 1 || uvScale[1] !== 1)) {
      const a = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) * uvScale[0], a.getY(i) * uvScale[1]);
    }
    this.tmp.copy(this.m);
    if (local) this.tmp.multiply(local);
    g.applyMatrix4(this.tmp);
    if (uv === 'world') worldUV(g, uvScale);
    let bin = this.bins.get(mat);
    if (!bin) this.bins.set(mat, (bin = []));
    bin.push(g);
    this.tris += g.getAttribute('position').count / 3;
    return g;
  }

  /** box with its base centre at (x, y, z) in the current frame, optionally turned about y and tilted about x/z */
  box(mat: THREE.Material, w: number, h: number, d: number, x = 0, y = 0, z = 0, rotY = 0, uv: UVMode = 'world', uvScale: [number, number] = [1, 1]) {
    const l = new THREE.Matrix4().compose(new THREE.Vector3(x, y + h / 2, z), this.q.setFromAxisAngle(this.up, rotY).clone(), new THREE.Vector3(w, h, d));
    return this.add(unitBox, mat, l, uv, uvScale);
  }
  /** box with an arbitrary local transform (centre at x,y,z) */
  boxM(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, euler: THREE.Euler) {
    const l = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(euler), new THREE.Vector3(w, h, d));
    return this.add(unitBox, mat, l);
  }
  /** rounded box, base centre at (x, y, z) */
  rbox(mat: THREE.Material, w: number, h: number, d: number, r: number, x = 0, y = 0, z = 0, rotY = 0, segs = 2) {
    r = Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
    const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}|${r.toFixed(3)}|${segs}`;
    let g = rboxCache.get(key);
    if (!g) rboxCache.set(key, (g = new RoundedBoxGeometry(w, h, d, segs, r)));
    const l = new THREE.Matrix4().compose(new THREE.Vector3(x, y + h / 2, z), this.q.setFromAxisAngle(this.up, rotY).clone(), new THREE.Vector3(1, 1, 1));
    return this.add(g, mat, l);
  }
  /** cylinder (or frustum) with its base centre at (x, y, z) */
  cyl(mat: THREE.Material, rTop: number, rBot: number, h: number, x = 0, y = 0, z = 0, seg = 16, open = false) {
    const big = Math.max(rTop, rBot, 1e-4);
    const a = rTop / big, b = rBot / big;
    const key = `${seg}|${open}|${a.toFixed(3)}|${b.toFixed(3)}`;
    let g = cylCache.get(key);
    if (!g) cylCache.set(key, (g = new THREE.CylinderGeometry(a, b, 1, seg, 1, open)));
    const l = new THREE.Matrix4().compose(new THREE.Vector3(x, y + h / 2, z), new THREE.Quaternion(), new THREE.Vector3(big, h, big));
    return this.add(g, mat, l);
  }
  /** horizontal cylinder along local x (axis 'x') or z */
  rod(mat: THREE.Material, r: number, len: number, x: number, y: number, z: number, axis: 'x' | 'z' = 'x', seg = 8) {
    const key = `rod${seg}`;
    let g = cylCache.get(key);
    if (!g) cylCache.set(key, (g = new THREE.CylinderGeometry(1, 1, 1, seg, 1, false)));
    const e = axis === 'x' ? new THREE.Euler(0, 0, Math.PI / 2) : new THREE.Euler(Math.PI / 2, 0, 0);
    const l = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(r, len, r));
    return this.add(g, mat, l);
  }
  sphere(mat: THREE.Material, r: number, x: number, y: number, z: number, sy = 1) {
    let g = cylCache.get('sphere');
    if (!g) cylCache.set('sphere', (g = new THREE.SphereGeometry(1, 12, 8)));
    const l = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(r, r * sy, r));
    return this.add(g, mat, l);
  }
  /** a vertical quad facing +z (local), centre at x,y,z, with its own 0..1 uvs */
  quad(mat: THREE.Material, w: number, h: number, x: number, y: number, z: number, rotY = 0, uvScale: [number, number] = [1, 1]) {
    let g = cylCache.get('quad');
    if (!g) cylCache.set('quad', (g = new THREE.PlaneGeometry(1, 1)));
    const l = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(this.up, rotY), new THREE.Vector3(w, h, 1));
    return this.add(g, mat, l, 'keep', uvScale);
  }
  /** a horizontal quad facing up, centre at x,y,z */
  flat(mat: THREE.Material, w: number, d: number, x: number, y: number, z: number, uv: UVMode = 'world', uvScale: [number, number] = [1, 1], rotY = 0) {
    let g = cylCache.get('flat');
    if (!g) cylCache.set('flat', (g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)));
    const l = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(this.up, rotY), new THREE.Vector3(w, 1, d));
    return this.add(g, mat, l, uv, uvScale);
  }

  /** merge everything into meshes under `into` */
  finish(into: THREE.Object3D, shadows = true) {
    for (const [mat, list] of this.bins) {
      if (!list.length) continue;
      const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!geo) continue;
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      const transparent = (mat as THREE.MeshStandardMaterial).transparent;
      mesh.castShadow = shadows && !transparent;
      mesh.receiveShadow = true;
      mesh.userData.owned = true;
      into.add(mesh);
      list.forEach((g) => g !== geo && g.dispose());
    }
    this.bins.clear();
  }
}

/** world-metre UVs from each triangle's dominant normal axis */
function worldUV(g: THREE.BufferGeometry, s: [number, number]) {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i += 3) {
    // per-triangle axis so faces never smear
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < 3; k++) {
      nx += n.getX(i + k);
      ny += n.getY(i + k);
      nz += n.getZ(i + k);
    }
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    for (let k = 0; k < 3; k++) {
      const j = i + k;
      const x = p.getX(j), y = p.getY(j), z = p.getZ(j);
      if (ay >= ax && ay >= az) uv.setXY(j, x * s[0], z * s[1]);
      else if (ax >= az) uv.setXY(j, (nx > 0 ? -z : z) * s[0], y * s[1]);
      else uv.setXY(j, (nz > 0 ? x : -x) * s[0], y * s[1]);
    }
  }
  uv.needsUpdate = true;
}
