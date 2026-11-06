import * as THREE from 'three';
import { AX, SZ, LX, LZ } from './common';
import { getNight, litWindows } from '../lighting';
import { hashN } from '../rng';
import type { HeightGrid } from './occlusion';
import type { Hull } from './buildings';

/**
 * Far-city proxies (HLOD), what you see down every avenue and from the roofs.
 *
 * Built per chunk from the architecture's building hulls (footprint, height, street-wall height,
 * setback tiers, type), falling back to the chunk's height grid where there are none (districts):
 *  - one box per mass, facade colour from the building type's palette, cornice / parapet band,
 *  - rooftop water towers (wooden tank on legs, conical roof) and stair / elevator bulkheads,
 *  - a procedural window grid in the shader: masonry punched windows (glazed, a share lit at night
 *    with the same ratio and warm/TV tints as litWindows()), storefront band, and glass towers as
 *    reflective curtain walls (low roughness, metallic: they pick up the sky HDRI) with mullions.
 * Everything sits in ONE THREE.BatchedMesh (one draw for all far chunks) plus a shadow-only batch.
 * Shadows: the shadow batch holds every chunk; per cascade it casts occluded chunks always and,
 * in the farthest cascade only, the fully drawn chunks too (their real meshes leave that cascade
 * via layers: see CityHlod.shadowLayers).
 */

/** surface kinds, in the `aKind` attribute */
const K = { masonry: 0, glass: 1, roof: 2, trim: 3, bits: 4, store: 5 } as const;

const PALETTE: Record<string, string[]> = {
  brownstone: ['#6e4632', '#7a5038', '#5e3c2c', '#83604a'],
  tenement: ['#8c3b2a', '#9a5a3c', '#a3683f', '#7a3a2e', '#b58a5a', '#6b4a3a', '#c9b08a'],
  prewar: ['#b89d78', '#a8896a', '#9a5a3c', '#c9a982', '#8c4a34'],
  midrise: ['#9a8c7c', '#b8b0a2', '#7d6b5a', '#a35a3c'],
  tower: ['#4d6276', '#5a7084', '#3f5568', '#6c8296', '#556b70'],
  castiron: ['#e2ddd0', '#c9cec9', '#d8ccb0', '#bfbfb8', '#a9b2a8'],
  grid: ['#8a4c3c', '#9a5a44', '#b9ab92', '#c8bca5', '#6b4a3a', '#a49c90', '#8e8478', '#b07a5c'],
};
const TRIM: Record<string, string> = { brownstone: '#5a3a2a', tenement: '#c8bfae', prewar: '#d8cfbc', midrise: '#bdb5a8', tower: '#9aa4ac', castiron: '#f0ece2', grid: '#b8b0a2' };

class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  kind: number[] = [];
  idx: number[] = [];
  private c = new THREE.Color();
  color(hex: string, mul = 1) {
    this.c.set(hex).convertSRGBToLinear().multiplyScalar(mul);
    return this;
  }
  /** quad a,b,c,d (counter-clockwise seen from outside) with facade uvs (u metres along, v metres up) */
  quad(a: number[], b: number[], c: number[], d: number[], n: number[], kind: number, u0 = 0, u1 = 0) {
    const base = this.pos.length / 3;
    const us = [u0, u1, u1, u0];
    [a, b, c, d].forEach((p, i) => {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n[0], n[1], n[2]);
      this.uv.push(us[i], p[1]);
      this.col.push(this.c.r, this.c.g, this.c.b);
      this.kind.push(kind);
    });
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /** box walls (+ roof) from y0 to y1 */
  box(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, wall: number, roof = true, roofColor?: string) {
    const W = x1 - x0, D = z1 - z0;
    // u runs continuously around the box so windows wrap the corners
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], wall, 0, W);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], wall, W, W + D);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], wall, W + D, 2 * W + D);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], wall, 2 * W + D, 2 * W + 2 * D);
    if (roof) {
      if (roofColor) this.color(roofColor);
      this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], K.roof);
    }
  }
  /** an 8-sided water tower: legs, tank, conical roof */
  waterTower(x: number, z: number, y: number, s: number) {
    const R = 1.6 * s, H = 3.6 * s, legs = 2.2 * s, n = 8;
    this.color('#2a2522');
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) this.box(x + dx * R * 0.6 - 0.1, x + dx * R * 0.6 + 0.1, z + dz * R * 0.6 - 0.1, z + dz * R * 0.6 + 0.1, y, y + legs, K.bits, false);
    this.color('#6b5844');
    const ring = (yy: number, r: number) => Array.from({ length: n }, (_, i) => [x + Math.cos((i / n) * Math.PI * 2) * r, yy, z + Math.sin((i / n) * Math.PI * 2) * r]);
    const lo = ring(y + legs, R), hi = ring(y + legs + H, R);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = (i + 0.5) / n * Math.PI * 2;
      this.quad(lo[j], lo[i], hi[i], hi[j], [Math.cos(a), 0, Math.sin(a)], K.bits);
    }
    this.color('#4a3f36');
    const apex = [x, y + legs + H + 1.4 * s, z];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = (i + 0.5) / n * Math.PI * 2;
      this.quad(hi[j], hi[i], apex, apex, [Math.cos(a) * 0.7, 0.7, Math.sin(a) * 0.7], K.bits);
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    const ok = this.pos.length > 0;
    g.setAttribute('position', new THREE.Float32BufferAttribute(ok ? this.pos : [0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(ok ? this.nor : [0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(ok ? this.uv : [0, 0, 0, 0, 0, 0], 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(ok ? this.col : [0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(ok ? this.kind : [0, 0, 0], 1));
    g.setIndex(ok ? this.idx : [0, 1, 2]);
    return g;
  }
}

/** proxy from building hulls (rects in chunk-local coordinates) */
export function hullGeometry(hulls: Hull[], seed: number) {
  const b = new GeoBuilder();
  for (const hl of hulls) {
    const r = hl.rect;
    const hsh = hashN(seed, Math.round(r.minX * 3), Math.round(r.minZ * 3));
    const type = hl.type;
    const pal = PALETTE[type] ?? PALETTE.grid;
    const wallHex = pal[hsh % pal.length];
    const glass = type === 'tower';
    const masses = hl.tiers?.length ? hl.tiers : [{ rect: r, y0: 0, y1: hl.h }];
    masses.forEach((m, i) => {
      const { minX: x0, maxX: x1, minZ: z0, maxZ: z1 } = m.rect;
      b.color(wallHex);
      b.box(x0, x1, z0, z1, m.y0, m.y1, glass ? K.glass : K.masonry, true, glass ? '#3c4246' : '#4a4642');
      // cornice / parapet band at the top of each mass
      b.color(TRIM[type] ?? TRIM.grid, glass ? 0.8 : 1);
      const o = glass ? 0.05 : 0.35, t = glass ? 0.5 : 0.9;
      b.box(x0 - o, x1 + o, z0 - o, z1 + o, m.y1 - t, m.y1 + (glass ? 0.6 : 0.25), K.trim, true, TRIM[type] ?? TRIM.grid);
      // a base course under the lowest mass of masonry buildings
      if (i === 0 && !glass) {
        b.color(wallHex, 0.7);
        b.box(x0 - 0.12, x1 + 0.12, z0 - 0.12, z1 + 0.12, 0, 4.2, K.store, false);
      }
    });
    // rooftop bits on the highest mass
    const topM = masses[masses.length - 1];
    const tr = topM.rect, ty = topM.y1 + (glass ? 0.6 : 0.25);
    const cx = (tr.minX + tr.maxX) / 2, cz = (tr.minZ + tr.maxZ) / 2;
    const w = tr.maxX - tr.minX, d = tr.maxZ - tr.minZ;
    if (type !== 'brownstone' && w > 5 && d > 5 && hsh % 10 < 7) {
      // stair / elevator bulkhead
      b.color('#7a746c');
      const bx = cx + ((hsh >> 4) % 5 - 2) * 0.15 * w, bz = cz + ((hsh >> 7) % 5 - 2) * 0.15 * d;
      b.box(bx - 1.6, bx + 1.6, bz - 1.3, bz + 1.3, ty, ty + 3.2, K.bits, true, '#5a5650');
    }
    if ((type === 'prewar' || type === 'tenement' || type === 'midrise' || type === 'castiron') && hl.h > 16 && w > 7 && d > 7 && (hsh >> 3) % 10 < (type === 'prewar' ? 6 : 4)) {
      b.waterTower(cx + ((hsh >> 9) % 3 - 1) * 0.2 * w, cz + ((hsh >> 11) % 3 - 1) * 0.2 * d, ty, 0.9 + ((hsh >> 13) % 4) * 0.08);
    }
  }
  return b.build();
}

/** fallback proxy from a height grid (chunks without hulls): greedy storey-quantised boxes */
export function hlodGeometry(grid: HeightGrid, seed: number) {
  const STOREY = 3.3;
  const { nx, nz, h, cell } = grid;
  const q = new Int16Array(nx * nz);
  for (let i = 0; i < q.length; i++) q[i] = h[i] > 4.5 ? Math.max(1, Math.round(h[i] / STOREY)) : 0;
  const used = new Uint8Array(nx * nz);
  const b = new GeoBuilder();
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
      const hsh = hashN(seed, Math.round(x0 * 0.2), Math.round(z0 * 0.2), Math.round(y));
      const tall = y > 45;
      const pal = tall ? PALETTE.tower : PALETTE.grid;
      b.color(pal[hsh % pal.length]);
      b.box(x0, x1, z0, z1, 0, y, tall ? K.glass : K.masonry, true, '#4a4642');
    }
  return b.build();
}

/** the live lit-window share from lighting.ts (captured from litWindows' own uniform) */
function litUniform(): { value: number } {
  const dummy = new THREE.MeshStandardMaterial();
  litWindows(dummy);
  const sh = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <emissivemap_fragment>' };
  try {
    dummy.onBeforeCompile(sh as unknown as THREE.WebGLProgramParametersWithUniforms, null as unknown as THREE.WebGLRenderer);
  } catch {
    /* fall through */
  }
  dummy.dispose();
  return (sh.uniforms.uLit as { value: number }) ?? { get value() { return 0.35 * getNight(); } };
}

let drawMat: THREE.MeshStandardMaterial | null = null;
function hlodMaterial() {
  if (drawMat) return drawMat;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0 });
  const uNight = { get value() { return getNight(); } };
  const uLit = litUniform();
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = uNight;
    sh.uniforms.uLit = uLit;
    sh.vertexShader = 'attribute float aKind;\nvarying float vKind;\nvarying vec2 vFac;\nvarying vec3 vWPos;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vKind = aKind;
      vFac = uv;
      #ifdef USE_BATCHING
        vWPos = (modelMatrix * batchingMatrix * vec4(transformed, 1.0)).xyz;
      #else
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #endif`);
    sh.fragmentShader = 'uniform float uNight;\nuniform float uLit;\nvarying float vKind;\nvarying vec2 vFac;\nvarying vec3 vWPos;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        float hRough = -1.0, hMetal = -1.0;
        vec3 hEmit = vec3(0.0);
        {
          int kind = int(vKind + 0.5);
          // per-building seed: the facade's world position at metre scale
          vec3 bseed = floor(vWPos / 40.0);
          if (kind == 0 || kind == 5) {
            // masonry: punched windows (bay 2.4 m, storey 3.2 m), storefront band below 4.2 m
            float u = vFac.x, v = vFac.y;
            bool store = kind == 5 || v < 4.2;
            vec2 cellId = store ? vec2(floor(u / 4.0), 0.0) : floor(vec2(u / 2.4, (v - 4.2) / 3.2));
            vec2 f = store ? vec2(fract(u / 4.0), v / 4.2) : fract(vec2(u / 2.4, (v - 4.2) / 3.2));
            bool win = store ? (f.x > 0.08 && f.x < 0.92 && f.y > 0.12 && f.y < 0.78) : (f.x > 0.25 && f.x < 0.75 && f.y > 0.22 && f.y < 0.8);
            if (win) {
              float wh = fract(sin(dot(vec3(cellId, dot(bseed, vec3(1.0, 7.0, 13.0))), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
              float wh2 = fract(wh * 91.17 + 0.31);
              diffuseColor.rgb = mix(vec3(0.05, 0.06, 0.07), vec3(0.12, 0.14, 0.17), wh2 * 0.5);
              hRough = 0.15; hMetal = 0.6;
              float on = step(wh, store ? max(uLit, 0.5) : uLit) * uNight;
              vec3 warm = mix(vec3(1.0, 0.45, 0.14), vec3(1.0, 0.7, 0.4), wh2);
              vec3 tint = fract(wh2 * 13.7) > 0.88 ? vec3(0.45, 0.6, 1.0) : warm;
              hEmit = tint * on * (0.25 + 0.45 * wh2);
            } else if (!store && f.y < 0.06) {
              diffuseColor.rgb *= 0.86; // storey / sill line
            }
          } else if (kind == 1) {
            // glass curtain wall: mullions 1.5 m, floors 3.8 m, reflective panes
            vec2 f = fract(vec2(vFac.x / 1.5, vFac.y / 3.8));
            vec2 cellId = floor(vec2(vFac.x / 1.5, vFac.y / 3.8));
            bool frame = f.x < 0.06 || f.y < 0.1;
            if (frame) { diffuseColor.rgb *= 0.55; hRough = 0.5; hMetal = 0.7; }
            else {
              diffuseColor.rgb *= 0.55;
              hRough = 0.06; hMetal = 0.92;
              float wh = fract(sin(dot(vec3(cellId, dot(bseed, vec3(1.0, 7.0, 13.0))), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
              hEmit = vec3(0.9, 0.85, 0.75) * step(wh, uLit * 0.7) * uNight * 0.35;
            }
          } else if (kind == 2) {
            diffuseColor.rgb *= 0.8;
          }
        }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n if (hRough >= 0.0) roughnessFactor = hRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n if (hMetal >= 0.0) metalnessFactor = hMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += hEmit;');
  };
  m.customProgramCacheKey = () => 'nyc-hlod-2';
  return (drawMat = m);
}

export type HlodMode = 'off' | 'draw' | 'shadow';
/** layer the far shadow cascade renders (only proxies and what opts in), see shadowLayers() */
export const PROXY_SHADOW_LAYER = 7;

export class CityHlod {
  private draw: THREE.BatchedMesh;
  private shadow: THREE.BatchedMesh;
  private ids = new Map<number, { geo: [number, number]; inst: [number, number]; verts: number; index: number; mode: HlodMode }>();
  private next = 1;
  private used = { v: 0, i: 0 };
  private cap = { v: 1 << 17, i: 1 << 18 };
  private cnt = 0;
  /** stats for tools */
  tris = 0;

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
    // the drawn proxies also cast in the far cascade
    this.draw.layers.enable(PROXY_SHADOW_LAYER);
    // the shadow-only batch: never in the main pass, only shadow cameras (they enable this layer)
    this.shadow.layers.set(PROXY_SHADOW_LAYER);
    // per shadow camera: occluded chunks always, fully drawn chunks only in the far cascade
    const base = THREE.BatchedMesh.prototype.onBeforeShadow;
    const self = this;
    this.shadow.onBeforeShadow = function (renderer, object, camera, shadowCamera, geometry, depthMaterial, group) {
      const far = !shadowCamera.layers.isEnabled(0);
      for (const e of self.ids.values()) self.shadow.setVisibleAt(e.inst[1], e.mode === 'shadow' || (far && e.mode === 'off'));
      base.call(this, renderer, object, camera, shadowCamera, geometry, depthMaterial, group);
    };
  }

  attach(root: THREE.Object3D) {
    root.add(this.draw, this.shadow);
  }

  /**
   * Shadow cascades: every shadow camera sees the proxy layer; the farthest cascade sees ONLY it
   * (real chunk meshes, trees, cars, people drop out there and the proxies stand in for them).
   * Called each frame by CityVis.update with the scene's directional shadow lights.
   */
  shadowLayers(lights: THREE.DirectionalLight[]) {
    if (!lights.length) return;
    let farL: THREE.DirectionalLight | null = null, farW = -1;
    for (const l of lights) {
      const c = l.shadow.camera;
      const w = c.right - c.left;
      if (w > farW) { farW = w; farL = l; }
    }
    for (const l of lights) {
      const c = l.shadow.camera.layers;
      c.enable(PROXY_SHADOW_LAYER);
      if (l === farL && lights.length > 1) c.disable(0);
      else c.enable(0);
    }
  }

  /** add a chunk's proxy (hulls in world coordinates unless hullsLocal); returns an id for set()/remove() */
  add(cx: number, cz: number, grid: HeightGrid, hulls?: Hull[], hullsLocal = false) {
    const ox = cx * AX, oz = cz * SZ;
    const dx = hullsLocal ? 0 : -ox, dz = hullsLocal ? 0 : -oz;
    const local = hulls?.map((h) => ({ ...h, rect: shift(h.rect, dx, dz), tiers: h.tiers?.map((t) => ({ ...t, rect: shift(t.rect, dx, dz) })) }));
    const geo = local?.length ? hullGeometry(local, hashN(cx, cz, 77)) : hlodGeometry(grid, hashN(cx, cz, 77));
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
    const m = new THREE.Matrix4().makeTranslation(ox, 0, oz);
    this.draw.setMatrixAt(i0, m);
    this.shadow.setMatrixAt(i1, m);
    this.draw.setVisibleAt(i0, false);
    this.shadow.setVisibleAt(i1, false);
    this.used.v += v;
    this.used.i += i;
    this.tris += i / 3;
    geo.dispose();
    const id = this.next++;
    this.ids.set(id, { geo: [g0, g1], inst: [i0, i1], verts: v, index: i, mode: 'off' });
    return id;
  }

  set(id: number, mode: HlodMode) {
    const e = this.ids.get(id);
    if (!e) return;
    e.mode = mode;
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
    this.tris -= e.index / 3;
    this.ids.delete(id);
    this.cnt--;
  }
}

function shift(r: { minX: number; maxX: number; minZ: number; maxZ: number }, dx: number, dz: number) {
  return { minX: r.minX + dx, maxX: r.maxX + dx, minZ: r.minZ + dz, maxZ: r.maxZ + dz };
}
