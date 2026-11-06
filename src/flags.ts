/**
 * Cheap-render URL flags for dev/QA screenshots on a machine with no GPU (see
 * .claude/skills/fast-3d-testing). Imported first by main.ts, so that modules which read
 * location.search when they load see the flags that ?fast=1 implies.
 *
 *   ?fast=1     preset: r=0 (just your block), people=0, notex=1, post=0, shadows=0, quality=low
 *               (pixel ratio 1). Flags that are given explicitly win, e.g. ?fast=1&people=20.
 *   ?notex=1    no textures: no image or texture downloads, and every material is drawn in
 *               flat colours (its maps are removed). lighting.ts also skips HDRIs for it.
 *   ?post=0     no post-processing: no GTAO, bloom or grading passes, just a direct render.
 *   ?shadows=0  no shadow maps.
 *
 * Everything is done by patching three.js prototypes, so it works for the game, labs and
 * every level without touching their code.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';

const FAST: Record<string, string> = { r: '0', people: '0', notex: '1', post: '0', shadows: '0', quality: 'low' };

function readFlags() {
  if (typeof location === 'undefined') return new URLSearchParams();
  const p = new URLSearchParams(location.search);
  if (p.get('fast') === '1') {
    let changed = false;
    for (const [k, v] of Object.entries(FAST)) if (!p.has(k)) { p.set(k, v); changed = true; }
    // put the implied flags in the URL, so modules reading location.search see them too
    if (changed && typeof history !== 'undefined') history.replaceState(history.state, '', `${location.pathname}?${p.toString()}${location.hash}`);
  }
  return p;
}
const params = readFlags();
const on = (k: string) => params.has(k) && params.get(k) !== '0';
const off = (k: string) => params.get(k) === '0';

export const FLAGS = { notex: on('notex'), post: !off('post'), shadows: !off('shadows'), fast: on('fast') };
(globalThis as unknown as { __flags: typeof FLAGS }).__flags = FLAGS;

// ---------------------------------------------------------------- ?notex=1

const MAPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'bumpMap', 'displacementMap', 'alphaMap', 'lightMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap', 'specularIntensityMap', 'specularColorMap', 'transmissionMap', 'thicknessMap', 'iridescenceMap', 'iridescenceThicknessMap', 'anisotropyMap'] as const;
function strip(m: THREE.Material) {
  // (checked every few frames: maps assigned later, e.g. once a model streams in, go too)
  // shader materials (sky, VAT crowd, custom effects) own their uniforms: leave them alone
  if ((m as THREE.ShaderMaterial).isShaderMaterial) return;
  const mm = m as unknown as Record<string, THREE.Texture | null>;
  let any = false;
  for (const k of MAPS) if (mm[k]) { mm[k] = null; any = true; }
  if (any) m.needsUpdate = true;
}
function stripScene(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = (c as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    if (Array.isArray(m)) m.forEach(strip);
    else strip(m);
  });
}

if (FLAGS.notex) {
  // no downloads: image/texture loaders hand back an empty texture at once
  const blank = () => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return c;
  };
  const tl = THREE.TextureLoader.prototype as unknown as { load: (url: string, onLoad?: (t: THREE.Texture) => void) => THREE.Texture };
  tl.load = function (_url, onLoad) {
    const t = new THREE.Texture(blank());
    t.needsUpdate = true;
    if (onLoad) setTimeout(() => onLoad(t), 0);
    return t;
  };
  const il = THREE.ImageLoader.prototype as unknown as { load: (url: string, onLoad?: (i: HTMLCanvasElement) => void) => HTMLCanvasElement };
  il.load = function (_url, onLoad) {
    const c = blank();
    if (onLoad) setTimeout(() => onLoad(c), 0);
    return c;
  };
}

// ---------------------------------------------------------------- render hooks (notex, shadows)

if (FLAGS.notex || !FLAGS.shadows) {
  // WebGLRenderer defines render() per instance, so hook the scene instead: the renderer calls
  // scene.onBeforeRender() before it draws shadow maps or compiles any program
  const proto = THREE.Scene.prototype as unknown as { onBeforeRender: (r: THREE.WebGLRenderer, s: THREE.Scene) => void };
  const before = proto.onBeforeRender;
  let n = 0;
  proto.onBeforeRender = function (this: THREE.Scene, r: THREE.WebGLRenderer, s: THREE.Scene) {
    if (!FLAGS.shadows && r.shadowMap) r.shadowMap.enabled = false;
    // new things stream in: re-strip every few frames
    if (FLAGS.notex && (n++ % 10 === 0 || n < 5)) stripScene(s);
    return before.call(this, r, s);
  };
}

// ---------------------------------------------------------------- ?post=0

if (!FLAGS.post) {
  const proto = EffectComposer.prototype as unknown as { render: (dt?: number) => void };
  proto.render = function (this: EffectComposer) {
    // the first scene pass, straight to the screen (tone mapping and output colour space apply)
    const rp = this.passes.find((p) => (p as unknown as { scene?: THREE.Scene }).scene && (p as unknown as { camera?: THREE.Camera }).camera) as unknown as { scene: THREE.Scene; camera: THREE.Camera } | undefined;
    if (!rp) return;
    this.renderer.setRenderTarget(null);
    this.renderer.render(rp.scene, rp.camera);
  };
}
