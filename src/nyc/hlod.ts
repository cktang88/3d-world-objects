import * as THREE from 'three';
import { AX, SZ, LX, LZ } from './common';
import { getNight } from '../lighting';
import { hashN } from '../rng';
import type { HeightGrid } from './occlusion';

/**
 * Per-chunk HLOD proxies (WP2 in docs/research/performance.md): each built chunk's height grid is
 * greedy-meshed into a few dozen boxes (heights quantised to storeys), coloured from an NYC facade
 * palette, with a procedural window grid (lit at night) in the shader. All proxies live in ONE
 * THREE.BatchedMesh (one draw for every far chunk), and the same geometry sits in a second,
 * shadow-only batch (no colour, no depth) so chunks hidden by occlusion still cast their shadows.
 */

const STOREY = 3.3;
const PALETTE = ['#8a4c3c', '#7a4434', '#9a5a44', '#b9ab92', '#c8bca5', '#6b4a3a', '#a49c90', '#8e8478', '#b07a5c', '#d0c8b8'];
const GLASSY = ['#6c7884', '#7d8a94', '#5f6b74', '#9aa3a8'];

/** greedy-mesh a height grid into boxes → indexed geometry with vertex colours (chunk-local) */
export function hlodGeometry(grid: HeightGrid, seed: number) {
  const { nx, nz, h, cell } = grid;
  const q = new Int16Array(nx * nz);
  for (let i = 0; i < q.length; i++) q[i] = h[i] > 4.5 ? Math.max(1, Math.round(h[i] / STOREY)) : 0;
  const used = new Uint8Array(nx * nz);
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
  const c = new THREE.Color();
  const quad = (a: number[], b: number[], cc: number[], d: number[], n: number[]) => {
    const base = pos.length / 3;
    for (const p of [a, b, cc, d]) {
      pos.push(p[0], p[1], p[2]);
      nor.push(n[0], n[1], n[2]);
      col.push(c.r, c.g, c.b);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  let boxes = 0;
  for (let iz = 0; iz < nz; iz++)
    for (let ix = 0; ix < nx; ix++) {
      const k = iz * nx + ix;
      if (!q[k] || used[k]) continue;
      const v = q[k];
      let w = 1;
      while (ix + w < nx && q[iz * nx + ix + w] === v && !used[iz * nx + ix + w]) w++;
      let d = 1;
      grow: while (iz + d < nz) {
        for (let j = 0; j < w; j++) if (q[(iz + d) * nx + ix + j] !== v || used[(iz + d) * nx + ix + j]) break grow;
        d++;
      }
      for (let a = 0; a < d; a++) for (let j = 0; j < w; j++) used[(iz + a) * nx + ix + j] = 1;
      const x0 = -LX + ix * cell, x1 = Math.min(LX, x0 + w * cell), z0 = -LZ + iz * cell, z1 = Math.min(LZ, z0 + d * cell);
      const y = v * STOREY;
      const tall = y > 45;
      const hsh = hashN(seed, Math.round(x0 * 0.2), Math.round(z0 * 0.2), Math.round(y));
      c.set(tall ? GLASSY[hsh % GLASSY.length] : PALETTE[hsh % PALETTE.length]).convertSRGBToLinear();
      // four walls and a roof (no bottom)
      quad([x0, 0, z1], [x1, 0, z1], [x1, y, z1], [x0, y, z1], [0, 0, 1]);
      quad([x1, 0, z0], [x0, 0, z0], [x0, y, z0], [x1, y, z0], [0, 0, -1]);
      quad([x1, 0, z1], [x1, 0, z0], [x1, y, z0], [x1, y, z1], [1, 0, 0]);
      quad([x0, 0, z0], [x0, 0, z1], [x0, y, z1], [x0, y, z0], [-1, 0, 0]);
      c.multiplyScalar(0.55);
      quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0]);
      boxes++;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos.length ? pos : [0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor.length ? nor : [0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col.length ? col : [0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  g.setIndex(idx.length ? idx : [0, 1, 2]);
  g.userData.boxes = boxes;
  return g;
}

let drawMat: THREE.MeshStandardMaterial | null = null;
function hlodMaterial() {
  if (drawMat) return drawMat;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 });
  const uNight = { get value() { return getNight(); } };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = uNight;
    sh.vertexShader = 'varying vec3 vWPos;\nvarying vec3 vWN;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_BATCHING
        mat4 hlodM = modelMatrix * batchingMatrix;
      #else
        mat4 hlodM = modelMatrix;
      #endif
      vWPos = (hlodM * vec4(transformed, 1.0)).xyz;
      vWN = normalize(mat3(hlodM) * objectNormal);`);
    sh.fragmentShader = 'uniform float uNight;\nvarying vec3 vWPos;\nvarying vec3 vWN;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        float hlodLit = 0.0;
        if (abs(vWN.y) < 0.5) {
          float u = dot(vWPos.xz, vec2(-vWN.z, vWN.x));
          float v = vWPos.y;
          vec2 cellId = floor(vec2(u / 2.6, v / ${STOREY.toFixed(1)}));
          vec2 f = fract(vec2(u / 2.6, v / ${STOREY.toFixed(1)}));
          if (v > 4.2 && f.x > 0.2 && f.x < 0.8 && f.y > 0.22 && f.y < 0.82) {
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.07, 0.085, 0.1), 0.85);
            float rnd = fract(sin(dot(cellId, vec2(12.9898, 78.233)) + floor(vWPos.x * 0.01) * 3.1) * 43758.5453);
            hlodLit = step(rnd, 0.35) * uNight;
          }
          // storey line
          if (f.y < 0.05) diffuseColor.rgb *= 0.8;
        }`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += vec3(1.0, 0.78, 0.5) * hlodLit * 1.4;');
  };
  m.customProgramCacheKey = () => 'nyc-hlod';
  return (drawMat = m);
}

export type HlodMode = 'off' | 'draw' | 'shadow';

export class CityHlod {
  private draw: THREE.BatchedMesh;
  private shadow: THREE.BatchedMesh;
  private ids = new Map<number, { geo: [number, number]; inst: [number, number]; verts: number; index: number }>();
  private next = 1;
  private used = { v: 0, i: 0 };
  private cap = { v: 1 << 16, i: 1 << 17 };
  private cnt = 0;

  constructor() {
    const mk = (m: THREE.Material, shadowOnly: boolean) => {
      const b = new THREE.BatchedMesh(64, this.cap.v, this.cap.i, m);
      b.castShadow = true;
      b.receiveShadow = !shadowOnly;
      b.sortObjects = false;
      b.frustumCulled = false; // per-instance culling inside; the batch spans the whole city
      b.name = shadowOnly ? 'hlod-shadow' : 'hlod';
      return b;
    };
    this.draw = mk(hlodMaterial(), false);
    this.shadow = mk(new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), true);
  }

  attach(root: THREE.Object3D) {
    root.add(this.draw, this.shadow);
  }

  /** add a chunk's proxy; returns an id for set()/remove() */
  add(cx: number, cz: number, grid: HeightGrid) {
    const geo = hlodGeometry(grid, hashN(cx, cz, 77));
    const v = geo.getAttribute('position').count, i = geo.index!.count;
    if (this.used.v + v > this.cap.v || this.used.i + i > this.cap.i) {
      // compact deleted proxies first, then grow
      for (const b of [this.draw, this.shadow]) b.optimize();
      let usedV = 0, usedI = 0;
      for (const e of this.ids.values()) { usedV += e.verts; usedI += e.index; }
      this.used = { v: usedV, i: usedI };
      if (this.used.v + v > this.cap.v || this.used.i + i > this.cap.i) {
        this.cap = { v: Math.max(this.cap.v * 2, this.used.v + v), i: Math.max(this.cap.i * 2, this.used.i + i) };
        for (const b of [this.draw, this.shadow]) b.setGeometrySize(this.cap.v, this.cap.i);
      }
    }
    this.cnt++;
    for (const b of [this.draw, this.shadow]) if (this.cnt > b.maxInstanceCount) b.setInstanceCount(b.maxInstanceCount * 2);
    const g0 = this.draw.addGeometry(geo), g1 = this.shadow.addGeometry(geo);
    const i0 = this.draw.addInstance(g0), i1 = this.shadow.addInstance(g1);
    const m = new THREE.Matrix4().makeTranslation(cx * AX, 0, cz * SZ);
    this.draw.setMatrixAt(i0, m);
    this.shadow.setMatrixAt(i1, m);
    this.draw.setVisibleAt(i0, false);
    this.shadow.setVisibleAt(i1, false);
    this.used.v += v;
    this.used.i += i;
    geo.dispose();
    const id = this.next++;
    this.ids.set(id, { geo: [g0, g1], inst: [i0, i1], verts: v, index: i });
    return id;
  }

  set(id: number, mode: HlodMode) {
    const e = this.ids.get(id);
    if (!e) return;
    this.draw.setVisibleAt(e.inst[0], mode === 'draw');
    this.shadow.setVisibleAt(e.inst[1], mode === 'shadow');
  }

  remove(id: number) {
    const e = this.ids.get(id);
    if (!e) return;
    this.draw.deleteInstance(e.inst[0]);
    this.shadow.deleteInstance(e.inst[1]);
    this.draw.deleteGeometry(e.geo[0]);
    this.shadow.deleteGeometry(e.geo[1]);
    this.ids.delete(id);
    this.cnt--;
  }
}
