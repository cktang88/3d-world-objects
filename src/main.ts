import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import './style.css';
import { loadManifest, allModels } from './assets';
import { Player } from './player';
import { CityLevel } from './city';
import { InteriorLevel } from './interior';
import { NycLevel } from './nyc';
import { ShopLevel } from './shop';
import { AtriumLevel, GalleryLevel } from './museum';
import { loadMuseum, museum } from './museumData';
import { DATASET_LABEL, loadRebuiltIndex, type RemoteEntry } from './remote';
import type { Env, Level, LevelDesc, Portal } from './level';
import { skyTex } from './textures';
import { hashStr } from './rng';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { loadPbr, setPbrResolution } from './pbr';
import { initDetail, updateDetail, applyOriginals, originalsEnabled } from './detail';

// ---------------------------------------------------------------- renderer

const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 900);
const pmrem = new THREE.PMREMGenerator(renderer);
const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = roomEnv;
initDetail(renderer);

// physical sky (NYC): also baked into the environment map so glass and metal reflect it
const sky = new Sky();
sky.visible = false;
scene.add(sky);
const skyScene = new THREE.Scene();
const skyForEnv = new Sky();
skyScene.add(skyForEnv);
let skyEnv: THREE.WebGLRenderTarget | null = null;
for (const sk of [sky, skyForEnv]) {
  const u = sk.material.uniforms;
  u.turbidity.value = 5.5;
  u.rayleigh.value = 1.2;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.82;
}
skyForEnv.scale.setScalar(1000);

// ---------------------------------------------------------------- post-processing

type Quality = 'ultra' | 'high' | 'low';
const params0 = new URLSearchParams(location.search);
let quality: Quality = (params0.get('quality') as Quality) || 'ultra';
const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
const renderPass = new RenderPass(scene, camera);
const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.6, thickness: 1.2, scale: 1.1, samples: 16 });
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
gtao.blendIntensity = 0.85;
// sprites (glows, steam) and see-through glass would be written into GTAO's depth/normal
// buffer as solid quads; hide them for that internal pass only
{
  const hidden: THREE.Object3D[] = [];
  let tick = 0;
  const refresh = () => {
    hidden.length = 0;
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if ((o as THREE.Sprite).isSprite || (m && !Array.isArray(m) && m.transparent && (m.opacity < 0.6 || (m as THREE.MeshPhysicalMaterial).transmission > 0))) hidden.push(o);
    });
  };
  const original = gtao.render.bind(gtao);
  gtao.render = (r, w, rd, dt, mask) => {
    if (tick++ % 20 === 0) refresh();
    const vis = hidden.map((o) => o.visible);
    hidden.forEach((o) => (o.visible = false));
    // GTAOPass renders its normal/depth pass first, then composites over readBuffer
    original(r, w, rd, dt, mask);
    hidden.forEach((o, i) => (o.visible = vis[i]));
  };
}
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.28, 0.5, 2.2);
composer.addPass(renderPass);
composer.addPass(gtao);
composer.addPass(bloom);
composer.addPass(new OutputPass());
function applyQuality() {
  gtao.enabled = quality === 'ultra';
  setPbrResolution(quality === 'low' ? '1k' : '2k');
  bloom.enabled = quality !== 'low';
  renderer.setPixelRatio(quality === 'low' ? 1 : Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(innerWidth, innerHeight);
  sun.shadow.mapSize.setScalar(quality === 'low' ? 2048 : 4096);
  sun.shadow.map?.dispose();
  sun.shadow.map = null;
}
function draw() {
  if (quality === 'low') renderer.render(scene, camera);
  else composer.render();
}

const hemi = new THREE.HemisphereLight('#ffffff', '#444444', 1);
const ambient = new THREE.AmbientLight('#ffffff', 0.1);
const sun = new THREE.DirectionalLight('#ffffff', 2);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera;
sc.left = sc.bottom = -70;
sc.right = sc.top = 70;
sc.near = 1;
sc.far = 320;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(hemi, ambient, sun, sun.target);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

const player = new Player(camera, renderer.domElement);
const coarse = matchMedia('(pointer: coarse)').matches;

// ---------------------------------------------------------------- HUD

const $ = (id: string) => document.getElementById(id)!;
const hud = {
  crumbs: $('crumbs'),
  depth: $('depth'),
  prompt: $('prompt'),
  promptKey: $('prompt-key'),
  promptLabel: $('prompt-label'),
  promptSub: $('prompt-sub'),
  fade: $('fade'),
  start: $('start'),
  loading: $('loading'),
  credits: $('credits'),
  creditsList: $('credits-list'),
  toast: $('toast'),
  touch: $('touch'),
  info: $('info'),
  help: $('help'),
};

let toastTimer = 0;
function toast(text: string) {
  hud.toast.textContent = text;
  hud.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => hud.toast.classList.remove('show'), 3400);
}

// ---------------------------------------------------------------- level stack

type Mode = 'world' | 'museum';
let mode: Mode = 'world';

interface Frame {
  desc: LevelDesc;
  pos: THREE.Vector3;
  yaw: number;
  exact: boolean;
  scale: number;
}
const stack: Frame[] = [];
let level: Level;
let currentDesc: LevelDesc;
let scale = 1;
let roomsVisited = 0;

function build(desc: LevelDesc): Level {
  switch (desc.kind) {
    case 'city': return new CityLevel(desc);
    case 'nyc': return new NycLevel(desc);
    case 'atrium': return new AtriumLevel();
    case 'gallery': return new GalleryLevel(desc);
    case 'interior': return desc.shop ? new ShopLevel(desc) : new InteriorLevel(desc);
  }
}

function descName(d: LevelDesc): string {
  switch (d.kind) {
    case 'atrium': return 'Atrium';
    case 'gallery': {
      const t = museum().themes[d.theme];
      return t ? t.name + (d.page ? ` ${d.page + 1}` : '') : 'Gallery';
    }
    case 'interior': return d.floor > 0 ? `${d.name} · floor ${d.floor + 1}` : d.name;
    default: return d.name;
  }
}

const sunDir = new THREE.Vector3(0.4, 0.8, 0.3);
function applyEnv(env: Env) {
  if (env.physicalSky && env.sun) {
    const el = THREE.MathUtils.degToRad(env.sun.elev), az = THREE.MathUtils.degToRad(env.sun.azim);
    const dir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    sky.material.uniforms.sunPosition.value.copy(dir);
    skyForEnv.material.uniforms.sunPosition.value.copy(dir);
    skyEnv?.dispose();
    skyEnv = pmrem.fromScene(skyScene as unknown as THREE.Scene, 0, 1, 2000);
    scene.environment = skyEnv.texture;
    scene.background = null;
    sky.visible = true;
  } else {
    sky.visible = false;
    scene.environment = roomEnv;
    scene.background = skyTex(env.skyTop, env.skyBottom, env.stars, hashStr(env.skyTop));
  }
  scene.fog = env.fog ? new THREE.Fog(env.fog, env.fogNear, env.fogFar) : null;
  hemi.color.set(env.hemi.sky);
  hemi.groundColor.set(env.hemi.ground);
  hemi.intensity = env.hemi.intensity;
  ambient.intensity = env.ambient;
  scene.environmentIntensity = env.envIntensity;
  renderer.toneMappingExposure = env.exposure;
  if (env.sun) {
    sun.visible = true;
    sun.color.set(env.sun.color);
    sun.intensity = env.sun.intensity;
    const el = THREE.MathUtils.degToRad(env.sun.elev);
    const az = THREE.MathUtils.degToRad(env.sun.azim);
    sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  } else sun.visible = false;
  camera.far = env.fog ? env.fogFar + 60 : 220;
  camera.updateProjectionMatrix();
  sky.scale.setScalar(camera.far * 1.1);
}

function setLevel(next: Level, pos?: THREE.Vector3, yaw?: number) {
  if (level) {
    scene.remove(level.group);
    level.dispose();
  }
  level = next;
  scene.add(level.group);
  applyEnv(level.env);
  player.place(pos ?? level.spawn.pos, yaw ?? level.spawn.yaw);
  renderCrumbs();
}

function renderCrumbs() {
  const names = [...stack.map((f) => descName(f.desc)), level.name];
  const shown = names.length > 6 ? ['…', ...names.slice(-5)] : names;
  hud.crumbs.innerHTML = '';
  shown.forEach((n, i) => {
    const s = document.createElement('span');
    s.textContent = n;
    if (i === shown.length - 1) s.className = 'here';
    hud.crumbs.appendChild(s);
  });
  if (mode === 'museum') {
    const t = currentDesc.kind === 'gallery' ? museum().themes[currentDesc.theme] : null;
    hud.depth.innerHTML = `<b>${t ? t.collection : 'The sand3d Museum'}</b><span>${stack.length} room${stack.length === 1 ? '' : 's'} deep · ${roomsVisited} visited</span><span>${museum().total.toLocaleString()} objects · ${museum().themes.length.toLocaleString()} rooms</span>`;
  } else {
    hud.depth.innerHTML = `<b>depth ${stack.length}</b><span>you are ${formatScale(scale)} your original size</span>`;
  }
}

function formatScale(s: number) {
  if (s >= 0.999) return '1×';
  const inv = 1 / s;
  if (inv < 1000) return `1/${inv.toFixed(inv < 10 ? 1 : 0)}`;
  const exp = Math.floor(Math.log10(inv));
  return `1/${(inv / 10 ** exp).toFixed(1)}×10<sup>${exp}</sup>`;
}

// ---------------------------------------------------------------- transitions

let transitioning = false;

async function fadeTo(opacity: number, ms: number) {
  hud.fade.style.transition = `opacity ${ms}ms ease`;
  hud.fade.style.opacity = String(opacity);
  await new Promise((r) => setTimeout(r, ms));
}

/** Dolly toward a point while narrowing the FOV: shrinking into it. */
async function zoomInto(target: THREE.Vector3, ms: number) {
  const start = camera.position.clone();
  const fov0 = camera.fov;
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / ms);
      const e = t * t * (3 - 2 * t);
      camera.position.lerpVectors(start, target, e * 0.92);
      camera.fov = fov0 - e * 45;
      camera.updateProjectionMatrix();
      draw();
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    step();
  });
  camera.fov = fov0;
  camera.updateProjectionMatrix();
}

async function enter(p: Portal) {
  if (transitioning) return;
  if (p.target === 'inspect') {
    if (p.inspect) openInfo(p.inspect);
    return;
  }
  transitioning = true;
  hud.prompt.classList.remove('show');
  if (p.target === 'back') {
    await goBack();
    transitioning = false;
    return;
  }
  const target = p.target;
  const shrink = target.kind === 'city';
  const quick = target.kind === 'gallery' || target.kind === 'atrium';
  hud.fade.style.background = shrink ? '#fff' : '#000';
  if (shrink) {
    const c = new THREE.Vector3();
    p.box.getCenter(c);
    const zoom = zoomInto(c, 900);
    await new Promise((r) => setTimeout(r, 450));
    await Promise.all([zoom, fadeTo(1, 450)]);
  } else await fadeTo(1, quick ? 220 : 300);
  stack.push({ desc: currentDesc, pos: (p.returnPos ?? player.pos).clone(), yaw: p.returnYaw ?? player.yaw, exact: !!p.returnPos, scale });
  currentDesc = target;
  if (shrink && p.shrink) scale *= p.shrink / 1000;
  roomsVisited++;
  setLevel(build(target));
  if (shrink) toast(`You shrink into ${target.name.replace('Inside ', '')}…  Press Q to climb back out.`);
  else if (target.kind === 'interior') toast(target.floor > 0 ? `Floor ${target.floor + 1}` : `Welcome to ${target.name}`);
  else if (target.kind === 'gallery' && stack.length === 1) toast(`${target.wing ?? ''} wing — every doorway leads somewhere similar`);
  await fadeTo(0, shrink ? 700 : quick ? 260 : 350);
  transitioning = false;
}

async function goBack() {
  const f = stack.pop();
  if (!f) {
    toast(mode === 'museum' ? 'This is the atrium — pick a wing.' : 'This is the outermost world.');
    return;
  }
  const wasCity = currentDesc.kind === 'city';
  hud.fade.style.background = wasCity ? '#fff' : '#000';
  await fadeTo(1, wasCity ? 450 : 240);
  currentDesc = f.desc;
  scale = f.scale;
  if (f.exact) setLevel(build(f.desc), f.pos, f.yaw);
  else {
    const back = new THREE.Vector3(Math.sin(f.yaw), 0, Math.cos(f.yaw)).multiplyScalar(0.8);
    setLevel(build(f.desc), f.pos.clone().add(back), f.yaw + Math.PI);
  }
  await fadeTo(0, wasCity ? 600 : 260);
}

// ---------------------------------------------------------------- aiming at things

const ray = new THREE.Ray();
const fwd = new THREE.Vector3();
const hit = new THREE.Vector3();
let aimed: Portal | null = null;
const outline = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color('#ffe58a'));
const outlineMat = outline.material as THREE.LineBasicMaterial;
outlineMat.transparent = true;
outlineMat.depthTest = false;
outline.renderOrder = 10;
outline.visible = false;
scene.add(outline);

function volume(b: THREE.Box3) {
  return (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z);
}

function target(): Portal | null {
  camera.getWorldDirection(fwd);
  ray.set(camera.position, fwd);
  const reach = currentDesc.kind === 'city' || currentDesc.kind === 'nyc' ? 7 : 4.2;
  const hits: { p: Portal; d: number; v: number }[] = [];
  for (const p of level.portals()) {
    if (p.auto) continue;
    if (p.box.containsPoint(camera.position)) {
      hits.push({ p, d: 0.01, v: volume(p.box) });
      continue;
    }
    const h = ray.intersectBox(p.box, hit);
    if (!h) continue;
    const d = h.distanceTo(camera.position);
    if (d <= reach) hits.push({ p, d, v: volume(p.box) });
  }
  if (!hits.length) return null;
  const nearest = Math.min(...hits.map((h) => h.d));
  let best: Portal | null = null;
  let bestV = Infinity;
  for (const h of hits) if (h.d <= nearest + 0.9 && h.v < bestV) { best = h.p; bestV = h.v; }
  return best;
}

const feet = new THREE.Vector3();
function autoPortal(): Portal | null {
  feet.set(player.pos.x, 1, player.pos.z);
  for (const p of level.portals()) if (p.auto && p.box.containsPoint(feet)) return p;
  return null;
}

// ---------------------------------------------------------------- info panel

let infoOpen = false;
function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
function openInfo(e: RemoteEntry) {
  infoOpen = true;
  document.exitPointerLock();
  const hf = `https://huggingface.co/datasets/Sandflow/sand3d-${e.ds}/viewer/default/${e.split}?row=${e.row}`;
  hud.info.innerHTML = `
    <button class="close" id="info-close">×</button>
    <div class="kicker">${esc(DATASET_LABEL[e.ds] ?? e.ds)}${e.family && !/^\d+$/.test(e.family) ? ` · ${esc(e.family.replace(/_/g, ' '))}` : ''}</div>
    <h2>${esc(e.title)}</h2>
    <div class="meta">
      ${e.author ? `<div><span>original by</span>${esc(e.author)}</div>` : ''}
      ${e.entry ? `<div><span>sand3d entry</span><code>${esc(e.entry)}()</code></div>` : ''}
      ${e.attribution ? `<div><span>size</span>${esc(e.attribution)}</div>` : ''}
      ${e.joints ? `<div><span>joints</span>${e.joints} — it moves</div>` : ''}
      <div><span>match to source</span>${(e.f * 100).toFixed(0)}% F-score</div>
      <div><span>licence</span>${esc(e.license || 'CC-BY-4.0')} (program and USD: CC BY 4.0, Sandflow)</div>
    </div>
    <div class="links">
      ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">source model</a>` : ''}
      <a href="${hf}" target="_blank" rel="noopener">dataset row</a>
    </div>
    <div id="info-render"></div>
    <button id="info-prog" class="prog">Show its sand3d program</button>
    <pre id="info-code" hidden></pre>
    <p class="hint">Esc or E to close</p>`;
  hud.info.classList.add('show');
  $('info-close').addEventListener('click', closeInfo);
  $('info-prog').addEventListener('click', async () => {
    const btn = $('info-prog') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Loading program…';
    try {
      const res = await fetch(`https://datasets-server.huggingface.co/rows?dataset=Sandflow/sand3d-${e.ds}&config=default&split=${e.split}&offset=${e.row}&length=1`);
      const d = await res.json();
      const row = d.rows?.[0]?.row;
      const code = $('info-code');
      code.textContent = row?.program ?? 'Program unavailable right now.';
      code.hidden = false;
      if (row?.render?.src) $('info-render').innerHTML = `<img src="${esc(row.render.src)}" alt="Sandflow's render of this object">`;
      btn.textContent = `${(row?.program ?? '').split('\n').length} lines of Python`;
    } catch {
      btn.textContent = 'Could not reach Hugging Face';
    }
  });
}
function closeInfo() {
  infoOpen = false;
  hud.info.classList.remove('show');
  if (started) lock();
}

// ---------------------------------------------------------------- input

let started = false;
function lock() {
  if (coarse) return;
  renderer.domElement.requestPointerLock();
}

renderer.domElement.addEventListener('click', () => {
  if (started && !player.locked && !infoOpen) lock();
});
document.addEventListener('pointerlockchange', () => {
  if (!player.locked && started && !infoOpen && !hud.credits.classList.contains('show') && !coarse) {
    hud.start.classList.remove('hidden');
    hud.start.classList.add('paused');
    started = false;
  }
});

addEventListener('keydown', (e) => {
  if (infoOpen && (e.code === 'Escape' || e.code === 'KeyE')) {
    closeInfo();
    return;
  }
  if (!started) return;
  if (e.code === 'KeyE' || e.code === 'Enter') {
    if (aimed) enter(aimed);
  } else if (e.code === 'KeyQ' || e.code === 'Backspace') {
    if (!transitioning) {
      transitioning = true;
      goBack().then(() => (transitioning = false));
    }
  } else if (e.code === 'KeyC') toggleCredits();
  else if (e.code === 'KeyG') {
    quality = quality === 'ultra' ? 'high' : quality === 'high' ? 'low' : 'ultra';
    applyQuality();
    toast(`Graphics: ${quality === 'ultra' ? 'ultra (ambient occlusion, bloom, 4K shadows)' : quality === 'high' ? 'high (bloom, 4K shadows)' : 'low'}`);
  } else if (e.code === 'KeyO') {
    applyOriginals(!originalsEnabled);
    toast(originalsEnabled ? 'Original textured models: on (streamed from Objaverse as you get close)' : 'Original models off: pure sand3d programs');
  }
});

function toggleCredits() {
  const show = !hud.credits.classList.contains('show');
  hud.credits.classList.toggle('show', show);
  if (show) {
    if (!hud.creditsList.childElementCount) {
      for (const m of [...allModels()].sort((a, b) => a.role.localeCompare(b.role) || a.title.localeCompare(b.title))) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.textContent = m.title;
        a.href = m.url ?? '#';
        a.target = '_blank';
        a.rel = 'noopener';
        li.append(`${m.role} · `, a, ` by ${m.author ?? 'unknown'} (${m.license ?? 'CC-BY-4.0'}), rewritten as a sand3d program by Sandflow`);
        hud.creditsList.appendChild(li);
      }
    }
    document.exitPointerLock();
  } else if (started) lock();
}
$('credits-close').addEventListener('click', toggleCredits);
$('credits-link').addEventListener('click', (e) => {
  e.preventDefault();
  toggleCredits();
});

function setupTouch() {
  if (!coarse) return;
  hud.touch.classList.add('on');
  let moveId: number | null = null, lookId: number | null = null;
  const o = new THREE.Vector2(), last = new THREE.Vector2();
  const el = renderer.domElement;
  el.addEventListener('touchstart', (e) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < innerWidth / 2 && moveId === null) {
        moveId = t.identifier;
        o.set(t.clientX, t.clientY);
      } else if (lookId === null) {
        lookId = t.identifier;
        last.set(t.clientX, t.clientY);
      }
    }
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === moveId) player.touchMove.set((t.clientX - o.x) / 60, (t.clientY - o.y) / 60).clampLength(0, 1);
      if (t.identifier === lookId) {
        player.look((t.clientX - last.x) * 2.2, (t.clientY - last.y) * 2.2);
        last.set(t.clientX, t.clientY);
      }
    }
  }, { passive: true });
  const end = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === moveId) { moveId = null; player.touchMove.set(0, 0); }
      if (t.identifier === lookId) lookId = null;
    }
  };
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
  $('t-enter').addEventListener('click', () => aimed && enter(aimed));
  $('t-back').addEventListener('click', () => !transitioning && goBack());
}

// ---------------------------------------------------------------- loop

const clock = new THREE.Clock();
let time = 0;

function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  time += dt;
  if (level && !transitioning) {
    const active = started || coarse;
    player.update(dt, level.colliders(player.pos), !active || infoOpen);
    level.update(dt, player.pos, time);
    const auto = active ? autoPortal() : null;
    if (auto) enter(auto);
    aimed = active && !infoOpen ? target() : null;
    if (aimed) {
      outline.box.copy(aimed.box);
      outline.visible = true;
      outlineMat.opacity = 0.55 + 0.35 * Math.sin(time * 6);
      hud.promptKey.textContent = 'E';
      hud.promptLabel.textContent = aimed.label;
      hud.promptSub.textContent = aimed.sub ?? '';
      hud.prompt.classList.add('show');
    } else {
      outline.visible = false;
      hud.prompt.classList.remove('show');
    }
    if (sun.visible) {
      sun.position.copy(player.pos).addScaledVector(sunDir, 150);
      sun.target.position.copy(player.pos);
    }
    updateDetail(player.pos, mode === 'museum' ? 40 : 30);
    draw();
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- start

const params = new URLSearchParams(location.search);
const ready = Promise.all([loadManifest(), loadMuseum(), loadPbr(renderer), loadRebuiltIndex()]);

async function startMode(m: Mode) {
  mode = m;
  await ready;
  stack.length = 0;
  scale = 1;
  roomsVisited = 0;
  document.body.dataset.mode = m;
  hud.help.innerHTML = m === 'museum'
    ? '<kbd>WASD</kbd> walk · walk through a doorway to go on · <kbd>E</kbd> inspect · <kbd>Q</kbd> previous room'
    : '<kbd>WASD</kbd> move · <kbd>Shift</kbd> run · <kbd>E</kbd> enter / shrink in · <kbd>Q</kbd> back out · <kbd>C</kbd> credits';
  if (m === 'museum') currentDesc = { kind: 'atrium' };
  else {
    const seed = params.has('seed') ? Number(params.get('seed')) || hashStr(params.get('seed')!) : 20261105;
    currentDesc = params.get('biome') ? { kind: 'city', seed, biome: params.get('biome')!, name: 'The World' } : { kind: 'nyc', seed, name: 'Manhattan' };
  }
  setLevel(build(currentDesc));
  started = true;
  hud.start.classList.add('hidden');
  hud.start.classList.remove('paused');
  lock();
  toast(m === 'museum' ? 'Six wings. Walk through any doorway — each leads to rooms of similar objects, forever.' : 'Walk into any shop or door. Look at anything and press E.');
}

document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    const m = b.dataset.mode as Mode | 'resume';
    if (m === 'resume') {
      started = true;
      hud.start.classList.add('hidden');
      lock();
    } else startMode(m);
  }),
);

applyQuality();
ready.then(() => {
  hud.loading.classList.add('hidden');
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => (b.disabled = false));
  $('museum-count').textContent = museum().total.toLocaleString();
  setupTouch();
  const pm = params.get('mode');
  if (pm === 'museum' || pm === 'world') startMode(pm);
  frame();
});

Object.assign(window, {
  __world: { renderer, player, enter, goBack, get level() { return level; }, get aimed() { return aimed; }, startMode },
});
