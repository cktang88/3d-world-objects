import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import './style.css';
import { loadManifest, allModels } from './assets';
import { Player } from './player';
import { CityLevel } from './city';
import { InteriorLevel } from './interior';
import type { Env, Level, LevelDesc, Portal } from './level';
import { skyTex } from './textures';
import { hashStr } from './rng';

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
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const hemi = new THREE.HemisphereLight('#ffffff', '#444444', 1);
const ambient = new THREE.AmbientLight('#ffffff', 0.1);
const sun = new THREE.DirectionalLight('#ffffff', 2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = sc.bottom = -60;
sc.right = sc.top = 60;
sc.near = 1;
sc.far = 260;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(hemi, ambient, sun, sun.target);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const player = new Player(camera, renderer.domElement);

// ---------------------------------------------------------------- HUD

const $ = (id: string) => document.getElementById(id)!;
const hud = {
  crumbs: $('crumbs'),
  depth: $('depth'),
  prompt: $('prompt'),
  promptLabel: $('prompt-label'),
  promptSub: $('prompt-sub'),
  fade: $('fade'),
  start: $('start'),
  startBtn: $('start-btn') as HTMLButtonElement,
  loading: $('loading'),
  credits: $('credits'),
  creditsList: $('credits-list'),
  toast: $('toast'),
  touch: $('touch'),
};

let toastTimer = 0;
function toast(text: string) {
  hud.toast.textContent = text;
  hud.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => hud.toast.classList.remove('show'), 3200);
}

// ---------------------------------------------------------------- level stack

interface Frame {
  desc: LevelDesc;
  pos: THREE.Vector3;
  yaw: number;
  scale: number; // how small you are compared to where you started
}
const stack: Frame[] = [];
let level: Level;
let scale = 1;

function build(desc: LevelDesc): Level {
  return desc.kind === 'city' ? new CityLevel(desc) : new InteriorLevel(desc);
}

function applyEnv(env: Env) {
  scene.background = skyTex(env.skyTop, env.skyBottom, env.stars, hashStr(env.skyTop));
  scene.backgroundIntensity = 1;
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
  } else {
    sun.visible = false;
  }
  camera.far = env.fog ? env.fogFar + 40 : 200;
  camera.updateProjectionMatrix();
}
const sunDir = new THREE.Vector3(0.4, 0.8, 0.3);

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
  const names = [...stack.map((f) => levelName(f.desc)), level.name];
  hud.crumbs.innerHTML = '';
  names.forEach((n, i) => {
    const s = document.createElement('span');
    s.textContent = n;
    if (i === names.length - 1) s.className = 'here';
    hud.crumbs.appendChild(s);
  });
  const depth = stack.length;
  hud.depth.innerHTML = `<b>depth ${depth}</b><span>you are ${formatScale(scale)} your original size</span>`;
}

function levelName(d: LevelDesc) {
  if (d.kind === 'interior' && d.floor > 0) return `${d.name} · floor ${d.floor + 1}`;
  return d.name;
}

function formatScale(s: number) {
  if (s >= 0.999) return '1×';
  const inv = 1 / s;
  if (inv < 1000) return `1/${inv.toFixed(inv < 10 ? 1 : 0)}`;
  const exp = Math.floor(Math.log10(inv));
  const man = inv / 10 ** exp;
  return `1/${man.toFixed(1)}×10<sup>${exp}</sup>`;
}

// ---------------------------------------------------------------- transitions

let transitioning = false;
const tmpV = new THREE.Vector3();

async function fadeTo(opacity: number, ms: number) {
  hud.fade.style.transition = `opacity ${ms}ms ease`;
  hud.fade.style.opacity = String(opacity);
  await new Promise((r) => setTimeout(r, ms));
}

/** Dolly the camera toward a point while narrowing the FOV: you are shrinking into it. */
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
      renderer.render(scene, camera);
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    step();
  });
  camera.fov = fov0;
  camera.updateProjectionMatrix();
}

async function zoomOut(ms: number) {
  const fov0 = camera.fov;
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / ms);
      camera.fov = fov0 + (1 - t) * 40;
      camera.updateProjectionMatrix();
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
  transitioning = true;
  hud.prompt.classList.remove('show');
  if (p.target === 'back') {
    await goBack();
    transitioning = false;
    return;
  }
  const isCity = p.target.kind === 'city';
  p.box.getCenter(tmpV);
  hud.fade.style.background = isCity ? '#fff' : '#000';
  const zoom = zoomInto(tmpV.clone(), isCity ? 900 : 450);
  await new Promise((r) => setTimeout(r, isCity ? 450 : 150));
  await Promise.all([zoom, fadeTo(1, isCity ? 450 : 300)]);
  stack.push({ desc: currentDesc, pos: player.pos.clone(), yaw: player.yaw, scale });
  currentDesc = p.target;
  if (isCity && p.shrink) scale *= p.shrink / 1000; // a whole ~1 km world fits inside the object
  setLevel(build(p.target));
  if (isCity) toast(`You shrink into ${p.target.name.replace('Inside ', '')}…  Press Q to climb back out.`);
  else toast(p.target.kind === 'interior' && p.target.floor > 0 ? `Floor ${p.target.floor + 1}` : `Welcome to ${p.target.name}`);
  const zo = isCity ? zoomOut(900) : Promise.resolve();
  await Promise.all([fadeTo(0, isCity ? 700 : 350), zo]);
  transitioning = false;
}

async function goBack() {
  const f = stack.pop();
  if (!f) {
    toast('This is the outermost world.');
    return;
  }
  const wasCity = currentDesc.kind === 'city';
  hud.fade.style.background = wasCity ? '#fff' : '#000';
  await fadeTo(1, wasCity ? 500 : 300);
  currentDesc = f.desc;
  scale = f.scale;
  // step back a little from the portal so you are not standing inside it
  const back = new THREE.Vector3(Math.sin(f.yaw), 0, Math.cos(f.yaw)).multiplyScalar(0.6);
  setLevel(build(f.desc), f.pos.clone().add(back), f.yaw + Math.PI);
  await fadeTo(0, wasCity ? 600 : 300);
}

// ---------------------------------------------------------------- portal targeting

const ray = new THREE.Ray();
const fwd = new THREE.Vector3();
const hit = new THREE.Vector3();
let aimed: Portal | null = null;
const outline = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color('#ffe58a'));
(outline.material as THREE.LineBasicMaterial).transparent = true;
(outline.material as THREE.LineBasicMaterial).depthTest = false;
outline.renderOrder = 10;
outline.visible = false;
scene.add(outline);

function target(): Portal | null {
  camera.getWorldDirection(fwd);
  ray.set(camera.position, fwd);
  const reach = currentDesc.kind === 'city' ? 7 : 3.6;
  let best: Portal | null = null;
  let bestD = Infinity;
  let bestVol = Infinity;
  const hits: { p: Portal; d: number; v: number }[] = [];
  for (const p of level.portals()) {
    if (p.box.containsPoint(camera.position)) {
      // standing in a door frame counts as looking at it
      hits.push({ p, d: 0.01, v: volume(p.box) });
      continue;
    }
    const h = ray.intersectBox(p.box, hit);
    if (!h) continue;
    const d = h.distanceTo(camera.position);
    if (d > reach) continue;
    hits.push({ p, d, v: volume(p.box) });
  }
  if (!hits.length) return null;
  const nearest = Math.min(...hits.map((h) => h.d));
  // prefer the smallest thing near the front: the cup on the table, not the table
  for (const h of hits) {
    if (h.d <= nearest + 0.9 && h.v < bestVol) {
      best = h.p;
      bestVol = h.v;
      bestD = h.d;
    }
  }
  void bestD;
  return best;
}
function volume(b: THREE.Box3) {
  return (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z);
}

// ---------------------------------------------------------------- input

let started = false;
function lock() {
  if (matchMedia('(pointer: coarse)').matches) return; // touch devices use the on-screen controls
  renderer.domElement.requestPointerLock();
}

hud.startBtn.addEventListener('click', () => {
  started = true;
  hud.start.classList.add('hidden');
  lock();
});
renderer.domElement.addEventListener('click', () => {
  if (started && !player.locked) lock();
});
document.addEventListener('pointerlockchange', () => {
  if (!player.locked && started && !hud.credits.classList.contains('show') && !matchMedia('(pointer: coarse)').matches) {
    hud.start.classList.remove('hidden');
    hud.startBtn.textContent = 'Resume';
    started = false;
  }
});

addEventListener('keydown', (e) => {
  if (!started) return;
  if (e.code === 'KeyE' || e.code === 'Enter') {
    if (aimed) enter(aimed);
  } else if (e.code === 'KeyQ' || e.code === 'Backspace') {
    if (!transitioning) {
      transitioning = true;
      goBack().then(() => (transitioning = false));
    }
  } else if (e.code === 'KeyC') {
    toggleCredits();
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

// touch: left half moves, right half looks, buttons enter / back
function setupTouch() {
  if (!matchMedia('(pointer: coarse)').matches) return;
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

let currentDesc: LevelDesc;
const clock = new THREE.Clock();
let time = 0;

function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  time += dt;
  if (!transitioning) {
    player.update(dt, level.colliders(player.pos), !started && !matchMedia('(pointer: coarse)').matches);
    level.update(dt, player.pos, time);
    aimed = started || matchMedia('(pointer: coarse)').matches ? target() : null;
    if (aimed) {
      outline.box.copy(aimed.box);
      outline.visible = true;
      (outline.material as THREE.LineBasicMaterial).opacity = 0.55 + 0.35 * Math.sin(time * 6);
      hud.promptLabel.textContent = aimed.label;
      hud.promptSub.textContent = aimed.sub ?? '';
      hud.prompt.classList.add('show');
    } else {
      outline.visible = false;
      hud.prompt.classList.remove('show');
    }
    if (sun.visible) {
      sun.position.copy(player.pos).addScaledVector(sunDir, 120);
      sun.target.position.copy(player.pos);
    }
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}

async function main() {
  await loadManifest();
  const params = new URLSearchParams(location.search);
  const seed = params.has('seed') ? Number(params.get('seed')) || hashStr(params.get('seed')!) : 20261105;
  const biome = params.get('biome') ?? 'town';
  currentDesc = { kind: 'city', seed, biome, name: 'The World' };
  setLevel(build(currentDesc));
  hud.loading.classList.add('hidden');
  hud.startBtn.disabled = false;
  setupTouch();
  if (params.has('autostart')) {
    started = true;
    hud.start.classList.add('hidden');
  }
  frame();
  // expose for debugging / screenshots
  Object.assign(window, { __world: { renderer, player, enter, goBack, get level() { return level; }, get aimed() { return aimed; }, setStarted: (v: boolean) => (started = v) } });
}
main();
