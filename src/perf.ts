/**
 * Frame counters for the whole post-processing pipeline (WP1 in docs/research/performance.md).
 *
 * three resets `renderer.info` on every `renderer.render()` call, so with EffectComposer the counts
 * only ever showed the last full-screen pass. Here `info.autoReset` is off and the counters are reset
 * once per frame, at the start of `composer.render()` (or of the plain `renderer.render(scene, camera)`
 * on quality=low). Every composer pass and the shadow-map render are wrapped so the frame splits
 * into exclusive per-pass buckets, keyed by path:
 *
 *   RenderPass          main scene pass (without its shadow maps)
 *   RenderPass/shadow   CSM cascades + point/spot shadows rendered inside the main pass
 *   GTAOPass            GTAO normal/depth scene pass + its full-screen passes
 *   GTAOPass/shadow     shadow maps re-rendered inside GTAO's scene pass (if any)
 *   UnrealBloomPass, ShaderPass, OutputPass, ...
 *
 * `window.__world.perf()` returns the last frame's counts (plus a scene census); `perf({ top: 20 })`
 * also lists the in-frustum meshes with the most triangles. `?perf=1` shows a small overlay.
 *
 * Installed from a tiny delimited hook at the end of main.ts. Costs a few closures per frame.
 */
import * as THREE from 'three';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { Pass } from 'three/examples/jsm/postprocessing/Pass.js';

export interface PerfCtx {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  level: () => unknown;
}

export interface PassCounts { calls: number; tris: number; n: number }

export interface PerfFrame {
  calls: number;
  tris: number;
  points: number;
  lines: number;
  programs: number;
  geometries: number;
  textures: number;
  /** exclusive counts per pass path; n = times the bucket was entered this frame */
  perPass: Record<string, PassCounts>;
  /** interval between the last two frame starts (rAF cadence), and its smoothed value */
  frameMs: number;
  frameMsAvg: number;
  /** CPU time spent inside the draw (composer.render / renderer.render) */
  cpuMs: number;
  /** GPU time of the whole draw, only with ?perf=1 on a GPU exposing EXT_disjoint_timer_query_webgl2 */
  gpuMs: number | null;
  frame: number;
}

export interface SceneCensus {
  meshes: number;
  meshesVisible: number;
  meshesInFrustum: number;
  instanced: number;
  instancesInFrustum: number;
  skinnedInFrustum: number;
  /** triangles of in-frustum meshes x instances: what the main pass would draw before depth rejection */
  trisInFrustum: number;
  shadowCastersVisible: number;
  transmissiveInFrustum: number;
  sprites: number;
  lights: number;
  shadowLights: number;
  chunks?: number;
}

export interface Contributor { label: string; tris: number; instances: number; draws: number; castShadow: boolean }

export interface PerfApi {
  (opts?: { top?: number }): PerfFrame & { scene: SceneCensus; top?: Contributor[] };
  last: PerfFrame;
}

interface Bucket { path: string; c0: number; t0: number; childC: number; childT: number }

export function installPerf(ctx: PerfCtx): PerfApi {
  const { renderer, composer, scene, camera } = ctx;
  const info = renderer.info;
  info.autoReset = false;

  let acc: Record<string, PassCounts> = {};
  const stack: Bucket[] = [];
  let inFrame = false;
  let tStart = 0, tPrev = 0, frameAvg = 0;
  let frameNo = 0;
  let gpuMs: number | null = null;
  const blank = (): PerfFrame => ({ calls: 0, tris: 0, points: 0, lines: 0, programs: 0, geometries: 0, textures: 0, perPass: {}, frameMs: 0, frameMsAvg: 0, cpuMs: 0, gpuMs: null, frame: 0 });
  let last = blank();

  const enter = (name: string) => {
    const parent = stack[stack.length - 1];
    stack.push({ path: parent && parent.path !== '' ? `${parent.path}/${name}` : name, c0: info.render.calls, t0: info.render.triangles, childC: 0, childT: 0 });
  };
  const exit = () => {
    const b = stack.pop()!;
    const dc = info.render.calls - b.c0, dt = info.render.triangles - b.t0;
    const e = (acc[b.path] ??= { calls: 0, tris: 0, n: 0 });
    e.calls += dc - b.childC;
    e.tris += dt - b.childT;
    e.n++;
    const parent = stack[stack.length - 1];
    if (parent) { parent.childC += dc; parent.childT += dt; }
  };

  const gpu = new URLSearchParams(location.search).get('perf') === '1' ? gpuTimer(renderer) : null;

  const begin = (root: string) => {
    inFrame = true;
    info.reset();
    acc = {};
    stack.length = 0;
    tStart = performance.now();
    gpu?.begin();
    enter(root);
  };
  const end = () => {
    exit();
    gpu?.end();
    inFrame = false;
    const now = performance.now();
    const frameMs = tPrev ? tStart - tPrev : 0;
    tPrev = tStart;
    frameAvg = frameAvg ? frameAvg * 0.9 + frameMs * 0.1 : frameMs;
    const perPass: Record<string, PassCounts> = {};
    for (const [k, v] of Object.entries(acc)) if (v.calls || v.tris || k.includes('/')) perPass[k] = v;
    const g = gpu?.poll();
    if (g != null) gpuMs = g;
    last = {
      calls: info.render.calls, tris: info.render.triangles, points: info.render.points, lines: info.render.lines,
      programs: info.programs?.length ?? 0, geometries: info.memory.geometries, textures: info.memory.textures,
      perPass, frameMs: +frameMs.toFixed(2), frameMsAvg: +frameAvg.toFixed(2), cpuMs: +(now - tStart).toFixed(2), gpuMs, frame: ++frameNo,
    };
  };

  // one frame = one composer.render(), or a top-level renderer.render(scene, camera) (quality=low)
  const composerRender = composer.render.bind(composer);
  composer.render = (delta?: number) => {
    if (inFrame) return composerRender(delta);
    wrapPasses();
    begin('');
    try { composerRender(delta); } finally { end(); }
  };
  const render = renderer.render.bind(renderer);
  renderer.render = (s: THREE.Object3D, c: THREE.Camera) => {
    if (inFrame || s !== scene || c !== camera) return render(s, c);
    begin('main');
    try { render(s, c); } finally { end(); }
  };
  const sm = renderer.shadowMap as THREE.WebGLShadowMap & { render: (...a: unknown[]) => void };
  const smRender = sm.render.bind(sm);
  sm.render = (...a: unknown[]) => {
    if (!inFrame) return smRender(...a);
    enter('shadow');
    try { smRender(...a); } finally { exit(); }
  };

  const wrapped = new WeakSet<Pass>();
  function wrapPasses() {
    const seen = new Map<string, number>();
    for (const p of composer.passes) {
      const base = p.constructor?.name || 'Pass';
      const k = seen.get(base) ?? 0;
      seen.set(base, k + 1);
      if (wrapped.has(p)) continue;
      wrapped.add(p);
      const name = k ? `${base}#${k + 1}` : base;
      const orig = p.render.bind(p);
      p.render = (...a: Parameters<Pass['render']>) => {
        enter(name);
        try { orig(...a); } finally { exit(); }
      };
    }
  }

  const api = ((opts?: { top?: number }) => {
    const c = census(scene, camera, ctx.level(), opts?.top ?? 0);
    return { ...last, perPass: { ...last.perPass }, scene: c.census, ...(opts?.top ? { top: c.top } : {}) };
  }) as PerfApi;
  Object.defineProperty(api, 'last', { get: () => last });

  const w = (window as unknown as { __world?: Record<string, unknown> });
  if (w.__world) w.__world.perf = api;
  if (gpu || new URLSearchParams(location.search).has('perf')) overlay(api);
  return api;
}

// ---------------------------------------------------------------- scene census

const _frustum = new THREE.Frustum();
const _m = new THREE.Matrix4();

function trisOf(g: THREE.BufferGeometry) {
  const n = g.index ? g.index.count : g.attributes.position?.count ?? 0;
  const dr = g.drawRange;
  return Math.floor(Math.min(n, dr.count) / 3);
}

function labelOf(o: THREE.Object3D) {
  const names: string[] = [];
  for (let p: THREE.Object3D | null = o; p && names.length < 4; p = p.parent) if (p.name) names.unshift(p.name);
  const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[];
  // baked chunk meshes are unnamed: describe the material (vertex colours, map, colour) instead
  const desc = (x: THREE.Material) => {
    if (x.name) return x.name;
    const s = x as THREE.MeshStandardMaterial;
    return [x.type, s.vertexColors ? 'vc' : '', s.map ? `map:${s.map.name || 'tex'}` : '', s.color ? '#' + s.color.getHexString() : '', x.transparent ? 'transp' : ''].filter(Boolean).join(' ');
  };
  const mat = Array.isArray(m) ? m.map(desc).join('+') : m ? desc(m) : '';
  const kind = (o as THREE.InstancedMesh).isInstancedMesh ? 'Instanced' : (o as THREE.SkinnedMesh).isSkinnedMesh ? 'Skinned' : 'Mesh';
  return `${names.join('/') || '(unnamed)'} [${kind} ${mat}]`;
}

function census(scene: THREE.Scene, camera: THREE.Camera, level: unknown, top: number) {
  camera.updateMatrixWorld();
  _frustum.setFromProjectionMatrix(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const c: SceneCensus = {
    meshes: 0, meshesVisible: 0, meshesInFrustum: 0, instanced: 0, instancesInFrustum: 0, skinnedInFrustum: 0,
    trisInFrustum: 0, shadowCastersVisible: 0, transmissiveInFrustum: 0, sprites: 0, lights: 0, shadowLights: 0,
  };
  scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) c.meshes++; });
  const list: Contributor[] = [];
  scene.traverseVisible((o) => {
    if ((o as THREE.Light).isLight) {
      c.lights++;
      if ((o as THREE.Light).castShadow) c.shadowLights++;
      return;
    }
    if ((o as THREE.Sprite).isSprite) { c.sprites++; return; }
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    c.meshesVisible++;
    if (mesh.castShadow) c.shadowCastersVisible++;
    if (mesh.frustumCulled && !_frustum.intersectsObject(mesh)) return;
    c.meshesInFrustum++;
    const inst = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
    if (inst !== 1 || (mesh as THREE.InstancedMesh).isInstancedMesh) { c.instanced++; c.instancesInFrustum += inst; }
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) c.skinnedInFrustum++;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mats.some((m) => (m as THREE.MeshPhysicalMaterial).transmission > 0)) c.transmissiveInFrustum++;
    const t = trisOf(mesh.geometry) * inst;
    c.trisInFrustum += t;
    if (top) list.push({ label: labelOf(mesh), tris: t, instances: inst, draws: Array.isArray(mesh.material) ? mesh.geometry.groups.length || 1 : 1, castShadow: mesh.castShadow });
  });
  const chunks = (level as { chunks?: Map<unknown, unknown> } | undefined)?.chunks;
  if (chunks instanceof Map) c.chunks = chunks.size;
  let topList: Contributor[] | undefined;
  if (top) {
    // merge meshes with the same label, then rank by triangles
    const by = new Map<string, Contributor>();
    for (const x of list) {
      const e = by.get(x.label);
      if (e) { e.tris += x.tris; e.instances += x.instances; e.draws += x.draws; e.castShadow ||= x.castShadow; }
      else by.set(x.label, { ...x });
    }
    topList = [...by.values()].sort((a, b) => b.tris - a.tris).slice(0, top);
  }
  return { census: c, top: topList };
}

// ---------------------------------------------------------------- GPU timer (real GPUs only)

function gpuTimer(renderer: THREE.WebGLRenderer) {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  if (!ext || !(gl instanceof WebGL2RenderingContext)) return null;
  const pending: WebGLQuery[] = [];
  let active: WebGLQuery | null = null;
  return {
    begin() {
      if (active || pending.length > 3) return;
      active = gl.createQuery();
      if (active) gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
    },
    end() {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(active);
      active = null;
    },
    poll(): number | null {
      let out: number | null = null;
      while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = pending.shift()!;
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) out = ns / 1e6;
        gl.deleteQuery(q);
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- ?perf=1 overlay

function overlay(api: PerfApi) {
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;margin:0;padding:6px 8px;font:11px/1.35 ui-monospace,monospace;color:#e8f0e8;background:rgba(0,0,0,0.62);border-radius:4px;pointer-events:none;white-space:pre';
  document.body.appendChild(el);
  const k = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
  setInterval(() => {
    const f = api.last;
    const fps = f.frameMsAvg ? 1000 / f.frameMsAvg : 0;
    const lines = [
      `${fps.toFixed(0)} fps  frame ${f.frameMsAvg.toFixed(1)} ms  cpu ${f.cpuMs.toFixed(1)} ms  gpu ${f.gpuMs == null ? 'n/a' : f.gpuMs.toFixed(1) + ' ms'}`,
      `calls ${f.calls}  tris ${k(f.tris)}  programs ${f.programs}  geo ${f.geometries}  tex ${f.textures}`,
      ...Object.entries(f.perPass).sort((a, b) => b[1].calls - a[1].calls).map(([p, v]) => `  ${p.padEnd(22)} ${String(v.calls).padStart(5)}  ${k(v.tris).padStart(7)}${v.n > 1 ? `  x${v.n}` : ''}`),
    ];
    el.textContent = lines.join('\n');
  }, 250);
}
