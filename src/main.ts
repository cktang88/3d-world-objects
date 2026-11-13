// ?fast=1 / ?notex=1 / ?post=0 / ?shadows=0 (src/flags.ts): first, so modules that read location.search see them
import { FLAGS, stripTextures } from './flags';
import { minimap } from './minimap'; // [minimap]
import { mark, timed } from './boot'; // boot stage marks (scripts/boot.mjs)
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import './style.css';
import { loadManifest, allModels } from './assets';
import { Player } from './player';
import { InspectionZoom } from './inspection-zoom';
import { CityLevel } from './city';
import { InteriorLevel } from './interior';
import { NycLevel, SHOPS } from './nyc';
import { ShopLevel } from './shop';
import { OfficeLevel } from './rooms/office';
import { AtriumLevel, GalleryLevel } from './museum';
import { loadMuseum, museum } from './museumData';
import { DATASET_LABEL, loadRebuiltIndex, queueHold, type RemoteEntry } from './remote';
import type { Env, Level, LevelDesc, Portal } from './level';
import { hashStr } from './rng';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { labScenes, LabLevel, vec } from './lab';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { stabilizeGtao } from './ambient-occlusion';
import { museumRoutes } from './museum/routes';
import { installMuseumCatalog } from './museum/catalog';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Lighting, TIMES, type Place, type TimeOfDay } from './lighting';
import { Weather } from './weather';
import { loadPbr, setPbrResolution } from './pbr';
import { initDetail, updateDetail, applyOriginals, originalsEnabled } from './detail';
import { Seamless, descKey, doorOf, entryOf, floorStackStep, type Slot } from './seamless';
import { WindowViews, enterWorld, floorWorld, type Hullish } from './windowview';
import { Lazy, type LazyContainer } from './lazy';
import { warmUp } from './lazy-furniture';
import { probePedCar } from './probe';
const PROBE_PEDCAR = new URLSearchParams(location.search).get('probe') === 'pedcar';
import { FloorLevel, floorName, testBuilding } from './rooms/vertical';
import { Vertical } from './vertical';
import { MacroLevel } from './macro';
import { preloadFleet } from './nyc/vehicleFleet';
import { enableMemTracker, installMemProbe, memTrackChildren, memTrackerOn } from './dispose';

// ---------------------------------------------------------------- renderer

const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
// window.__mem(): GPU/heap counts; ?mem=1 also tracks live geometries/materials/textures by owner (src/dispose.ts)
installMemProbe(renderer);
if (new URLSearchParams(location.search).has('mem')) enableMemTracker();
let memTick = 0;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// AgX keeps hue in bright sunlit/neon areas instead of ACES' skew to yellow/cyan; ?tm= to compare
renderer.toneMapping = ({ aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping } as Record<string, THREE.ToneMapping>)[new URLSearchParams(location.search).get('tm') ?? ''] ?? THREE.AgXToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// near 0.1 (was 0.05): depth precision at range scales with near (24-bit, far 900: ~6 mm at 100 m instead of
// ~12 mm), the main cause of distant flicker; still well inside the player radius (0.32 m) [zfix]
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 900);
const inspectionZoom = new InspectionZoom(camera);
const pmrem = new THREE.PMREMGenerator(renderer);
const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = roomEnv;
initDetail(renderer);


// ---------------------------------------------------------------- post-processing

type Quality = 'ultra' | 'high' | 'low';
const params0 = new URLSearchParams(location.search);
// ---- vehicles: start the car models (mid + far LODs, ~2 MB) at boot, before the city build floods the image
// decoder with facade/PBR textures: in the city their parse otherwise finished a minute after the download
if (!params0.has('lab')) void preloadFleet();
// ---- end vehicles
let quality: Quality = (params0.get('quality') as Quality) || 'ultra';
const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
// Each composer buffer owns its depth: sharing lets later MSAA resolves overwrite scene depth.
rt.depthTexture = new THREE.DepthTexture(1, 1);
const composer = new EffectComposer(renderer, rt);
const renderPass = new RenderPass(scene, camera);
const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.6, thickness: 1.2, scale: 1.1, samples: 16 });
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
gtao.blendIntensity = 0.85;
// AO from the composer's depth (normals reconstructed from depth): GTAO no longer re-renders the
// scene with an override material, so sprites, glass, the sky dome and vertex-shader tricks
// (window anchors, wind) are seen exactly as drawn
gtao.setGBuffer(rt.depthTexture);
stabilizeGtao(gtao);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.28, 0.5, 2.2);
composer.addPass(renderPass);
composer.addPass(gtao);
composer.addPass(bloom);
composer.addPass(new OutputPass());
// lighting.grade (colour grading) is appended once the lighting rig exists, below
/** pixel-ratio ceiling per quality (hi-DPI panels pay 4x the pixels at DPR 2) */
const dprCap = () => (quality === 'low' ? 1 : Math.min(devicePixelRatio, quality === 'ultra' ? 1.5 : 1));
/** dynamic resolution: a factor on the cap, lowered when frames are slow (see frame()) */
let dynScale = 1;
function applySize() {
  const pr = Math.max(0.5, dprCap() * dynScale);
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight);
  // at DPR > 1 two MSAA samples look the same as four
  const samples = pr > 1 ? 2 : 4;
  if (rt.samples !== samples) {
    rt.samples = composer.renderTarget2.samples = samples;
    rt.dispose();
    composer.renderTarget2.dispose();
  }
  composer.setPixelRatio(pr);
  composer.setSize(innerWidth, innerHeight);
  // AO and bloom at half resolution (both are low-frequency)
  const w = Math.max(1, Math.round(innerWidth * pr / 2)), h = Math.max(1, Math.round(innerHeight * pr / 2));
  gtao.setSize(w, h);
  bloom.setSize(w, h);
}
function applyQuality() {
  gtao.enabled = quality === 'ultra';
  setPbrResolution(quality === 'low' ? '1k' : '2k');
  bloom.enabled = quality !== 'low';
  dynScale = 1;
  applySize();
  sun.shadow.mapSize.setScalar(quality === 'low' ? 2048 : 4096);
  sun.shadow.map?.dispose();
  sun.shadow.map = null;
  lighting.setQuality(quality);
  weather.setQuality(quality);
}
function draw() {
  if (quality === 'low') renderer.render(scene, camera);
  else {
    // The odd number of swapping passes alternates the main scene's buffer every frame.
    gtao.setGBuffer(composer.readBuffer.depthTexture!);
    composer.render();
  }
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
const lighting = new Lighting(renderer, scene, camera, pmrem, sun, hemi, ambient, roomEnv);
// ?wv=0: the painted window backdrops (before / after comparisons)
const views = new WindowViews({
  enabled: params0.get('wv') !== '0', renderer, scene,
  asOutdoor: (fn, fog) => lighting.asOutdoor(fn, fog), outdoorKey: () => lighting.outdoorKey, grade: () => lighting.outdoorGrade,
  gain: () => lighting.outdoorExposure / Math.max(0.05, renderer.toneMappingExposure),
  stale: () => lighting.outdoorStale, refresh: () => lighting.refreshOutdoor(),
  // memory: once captured, the street level goes (rebuilt when you walk out, or for a recapture
  // when the time of day / weather changes); not from a room right off the street (brownstones)
  release: () => {
    const c = cityDescIn();
    if (c && stack.length >= 3 && params0.get('wvkeep') !== '1') seam.forget(c);
  },
  needCity: () => {
    const c = cityDescIn();
    if (c) seam.take(c);
  },
});
/** the city level this building stands in (the bottom of the stack), if any */
function cityDescIn() {
  return stack[0]?.desc.kind === 'nyc' ? stack[0].desc : null;
}
lighting.bloom = bloom;
composer.addPass(lighting.grade);
if (params0.get('tod') && (TIMES as string[]).includes(params0.get('tod')!)) lighting.setTime(params0.get('tod') as TimeOfDay);
// weather.ts: clouds, rain, snow, fog (Y cycles, ?weather=clear|partly|overcast|lightrain|rain|fog|snow|random)
const weather: Weather = new Weather(renderer, scene, camera, lighting);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  applySize();
  lighting.resize();
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
  /** that level's frame -> the city's (windowview.ts), null when not in the city */
  world?: THREE.Matrix4 | null;
}
const stack: Frame[] = [];
/** the active level's frame -> the city's: identity on the street, door placements and floor moves inside */
let toWorld: THREE.Matrix4 | null = null;
/** the place in the city of a level entered through portal p */
function childWorld(p: Portal, lv: Level) {
  return enterWorld(toWorld, doorOf(p), entryOf(lv) ?? null);
}
let level: Level;
let currentDesc: LevelDesc;
let scale = 1;
let roomsVisited = 0;

function build(desc: LevelDesc, staged = false): Level {
  switch (desc.kind) {
    case 'city': return new CityLevel(desc);
    case 'nyc': return new NycLevel(desc);
    case 'atrium': return new AtriumLevel();
    case 'gallery': return new GalleryLevel(desc);
    case 'interior': return desc.shop ? new ShopLevel(desc, { staged }) : desc.office ? new OfficeLevel(desc, { staged }) : new InteriorLevel(desc, { staged }); // office suites: src/rooms/office.ts
    case 'floor': return new FloorLevel(desc, { staged }); // src/rooms/vertical.ts
    case 'macro': return new MacroLevel(desc, { staged }); // src/macro.ts: the world inside an object
  }
}

// ---- seamless doors (src/seamless.ts): levels are prebuilt as you approach a door, cached, and
// entered/left without a fade when ready. ?seamless=0 turns it off.
const seam = new Seamless({ scene, camera, renderer, build });
seam.enabled = params0.get('seamless') !== '0';
const seamFeet = new THREE.Vector3();
/** lazy.ts: room cells drawn only when visible, container contents generated only when opened */
const lazy = new Lazy();
let aimedBox: LazyContainer | null = null;
/** switch to an already built level without fading; pos/yaw in its frame */
function seamSwitch(s: Slot, pos: THREE.Vector3 | undefined, yaw: number | undefined) {
  const exposure = renderer.toneMappingExposure;
  const pitch = player.pitch;
  setLevel(s, pos, yaw);
  player.pitch = pitch;
  seam.blendFrom(exposure);
  seam.disarm(level, seamFeet.set(player.pos.x, 1, player.pos.z));
  seam.stats.seamless++;
}
/** 'opening…' under the black fade while a door's level is still being built (n < 0 hides it) */
const hintEl = Object.assign(document.createElement('div'), { id: 'seam-hint' });
hintEl.style.cssText = 'position:fixed;left:50%;bottom:18%;transform:translateX(-50%);z-index:60;color:#cfc8b8;font:13px system-ui,sans-serif;letter-spacing:.08em;opacity:0;transition:opacity .2s;pointer-events:none';
document.body.appendChild(hintEl);
function seamHint(n: number) {
  hintEl.style.opacity = n < 0 ? '0' : '0.85';
  if (n >= 0) hintEl.textContent = `opening the door ${'·'.repeat(1 + (n % 4))}`;
}
/**
 * The first shop built in a page used to stall for seconds: its fixtures' canvas textures (floor
 * tiles, tin ceilings...) are made on first use. Make them while the start screen is up instead,
 * one shop type per idle callback.
 */
function prewarmShops() {
  const types = [...new Set(SHOPS.map((x) => x.type))];
  let total = 0;
  const idle = (f: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(f, { timeout: 400 }) : setTimeout(f, 30));
  const next = () => {
    const type = types.shift();
    if (!type) return seam.stats.log.push(`prewarmed shop textures in ${total.toFixed(0)} ms`);
    const t = performance.now();
    const lv = new ShopLevel({ kind: 'interior', seed: 1, name: 'Prewarm', style: 'store', floor: 0, floors: 1, biome: 'metropolis', shop: type }, { staged: true });
    lv.staging?.next(); // style + shell: where the shared textures are made
    queueHold.n++;
    lv.dispose();
    queueHold.n--;
    total += performance.now() - t;
    idle(next);
  };
  idle(next);
}
/**
 * Floors of one building share one stack entry: leaving the lobby (by stair or lift) pushes the
 * lobby, so Q on any upper floor takes you back to the lobby, and Q there to the
 * street; coming back down to the lobby pops it. Floor-to-floor moves push nothing.
 */
function seamFloorStack(from: LevelDesc, to: LevelDesc) {
  const step = floorStackStep(stack[stack.length - 1]?.desc, from, to);
  if (step === 'pop') stack.pop();
  // back in the lobby at its spawn by the street door: where you left it is mid-stair, which would climb again
  else if (step === 'push') stack.push({ desc: from, pos: level.spawn.pos.clone(), yaw: level.spawn.yaw, exact: true, scale, world: toWorld });
}
// ---- end seamless

// ---- vertical.ts: stairs you walk up between floors (Player.ground), elevators; floors switch in the same frame
let aimedNow: Portal | null = null;
const vert = new Vertical({ scene, camera, renderer, seam, player, aimed: () => aimedNow });
player.ground = (x, z, y) => vert.ground(level, x, z, y);
// ---- end vertical

function descName(d: LevelDesc): string {
  switch (d.kind) {
    case 'atrium': return 'Atrium';
    case 'gallery': {
      const t = museum().themes[d.theme];
      return t ? t.name + (d.page ? ` ${d.page + 1}` : '') : 'Gallery';
    }
    case 'interior': return d.floor > 0 ? `${d.name} · floor ${d.floor + 1}` : d.name;
    case 'floor': return floorName(d);
    default: return d.name;
  }
}

function placeOf(d: LevelDesc): Place {
  switch (d.kind) {
    case 'nyc': return 'outdoor';
    case 'atrium':
    case 'gallery': return 'museum';
    case 'interior': return d.shop ? 'shop' : 'interior';
    case 'floor': return d.floor >= d.floors ? 'outdoor' : 'interior';
    case 'macro': return 'studio';
    default: return 'studio';
  }
}
function applyEnv(env: Env, place: Place = lighting.place) {
  lighting.apply(env, place);
}

function setLevel(next: Slot, pos?: THREE.Vector3, yaw?: number) {
  // the previous level stays alive in seamless.ts' cache (disposed when evicted)
  if (level) scene.remove(level.group);
  level = next.level;
  // windowview.ts: the city stays alive while you are in one of its buildings (its windows show it)
  const root = stack[0]?.desc.kind === 'nyc' ? [descKey(stack[0].desc)] : [];
  seam.setActive(next, [...root, ...stack.slice(-2).map((f) => descKey(f.desc))]);
  scene.add(level.group);
  applyEnv(level.env, placeOf(currentDesc));
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
    hud.depth.innerHTML = `<b>${t ? t.collection : 'The sand3d Museum'}</b><span>${stack.length} room${stack.length === 1 ? '' : 's'} deep · ${roomsVisited} visited</span><span>${museum().total.toLocaleString()} catalogue objects · ${museum().themes.length.toLocaleString()} themes</span>`;
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
  inspectionZoom.reset();
  if (p.target === 'inspect') {
    if (p.inspect) openInfo(p.inspect);
    return;
  }
  transitioning = true;
  hud.prompt.classList.remove('show');
  if (p.target === 'back') {
    await goBack(!!p.auto); // walking through a doorway back vs. pressing E on 'back'
    transitioning = false;
    return;
  }
  const target = p.target;
  const shrink = target.kind === 'city' || target.kind === 'macro';
  const quick = target.kind === 'gallery' || target.kind === 'atrium';
  if (!shrink && seam.enabled && seam.ready(target)) {
    // seamless: already built (and maybe on show behind this door): no fade, no rebuild
    const s = seam.take(target);
    const carried = doorOf(p) && seam.placeAt(s, p) ? seam.carry(s, 'in', player.pos, player.yaw) : null;
    stack.push({ desc: currentDesc, pos: (p.returnPos ?? player.pos).clone(), yaw: p.returnYaw ?? player.yaw, exact: !!p.returnPos, scale, world: toWorld });
    toWorld = childWorld(p, s.level);
    currentDesc = target;
    roomsVisited++;
    seamSwitch(s, carried?.pos, carried?.yaw);
    if (target.kind === 'interior') toast(target.floor > 0 ? `Floor ${target.floor + 1}` : target.shop ? `Welcome to ${target.name}` : target.name);
    transitioning = false;
    return;
  }
  if (!shrink) seam.stats.fades++;
  hud.fade.style.background = shrink ? '#fff' : '#000';
  if (shrink) {
    const c = new THREE.Vector3();
    p.box.getCenter(c);
    const zoom = zoomInto(c, 900);
    await new Promise((r) => setTimeout(r, 450));
    await Promise.all([zoom, fadeTo(1, 450)]);
  } else await fadeTo(1, quick ? 220 : 300);
  stack.push({ desc: currentDesc, pos: (p.returnPos ?? player.pos).clone(), yaw: p.returnYaw ?? player.yaw, exact: !!p.returnPos, scale, world: toWorld });
  currentDesc = target;
  if (shrink && p.shrink) scale *= p.shrink / 1000;
  roomsVisited++;
  // not prebuilt: build it behind the black, in slices, with a small hint if it takes a while
  const hintAt = setTimeout(() => seamHint(0), 300);
  const built = await seam.buildNow(target, (n) => seamHint(n));
  clearTimeout(hintAt);
  seamHint(-1);
  toWorld = shrink ? null : childWorld(p, built.level);
  setLevel(built);
  if (shrink) toast(`You shrink into ${target.name.replace('Inside ', '')}…  Press Q to climb back out.`);
  else if (target.kind === 'interior') toast(target.floor > 0 ? `Floor ${target.floor + 1}` : target.shop ? `Welcome to ${target.name}` : target.name);
  else if (target.kind === 'gallery' && stack.length === 1) toast(`${target.wing ?? ''} — follow a theme or discover a different collection`);
  await precompile();
  await fadeTo(0, shrink ? 700 : quick ? 260 : 350);
  transitioning = false;
}

/**
 * Behind the black of a fade: let lighting set up the new level's materials (cascade defines,
 * light budget), then compile every shader in parallel (KHR_parallel_shader_compile) so the first
 * visible frame doesn't stall. Capped at 2 s.
 */
async function precompile() {
  try {
    lighting.update(0, player.pos);
    await Promise.race([renderer.compileAsync(scene, camera), new Promise((r) => setTimeout(r, 2000))]);
  } catch {
    /* compileAsync is an optimisation only */
  }
}

/** walked: you walked out through the door (keep moving as you were); otherwise Q / E: step out facing away */
async function goBack(walked = false) {
  inspectionZoom.reset();
  const f = stack.pop();
  if (!f) {
    toast(mode === 'museum' ? 'This is the atrium — pick a wing.' : 'This is the outermost world.');
    return;
  }
  const wasCity = currentDesc.kind === 'city' || currentDesc.kind === 'macro';
  toWorld = f.world ?? null;
  const parent = seam.slots.get(descKey(f.desc));
  if (seam.enabled && !wasCity && parent?.ready) {
    // seamless: the level you came from is still alive; walk back out where you went in
    const child = seam.slotOf(level);
    // walking out through a glass door or a doorway: carried across where you are, facing as you were.
    // Q / E on 'back': where the portal says to stand (returnPos), facing away from the door.
    const carried = walked && child?.portal && child.placement ? seam.carry(child, 'out', player.pos, player.yaw) : null;
    currentDesc = f.desc;
    scale = f.scale;
    if (carried) seamSwitch(seam.take(f.desc), carried.pos, carried.yaw);
    else if (f.exact) seamSwitch(seam.take(f.desc), f.pos, f.yaw);
    else seamSwitch(seam.take(f.desc), f.pos.clone().add(new THREE.Vector3(Math.sin(f.yaw), 0, Math.cos(f.yaw)).multiplyScalar(0.8)), f.yaw + Math.PI);
    return;
  }
  hud.fade.style.background = wasCity ? '#fff' : '#000';
  await fadeTo(1, wasCity ? 450 : 240);
  currentDesc = f.desc;
  scale = f.scale;
  if (f.exact) setLevel(seam.take(f.desc), f.pos, f.yaw);
  else {
    const back = new THREE.Vector3(Math.sin(f.yaw), 0, Math.cos(f.yaw)).multiplyScalar(0.8);
    setLevel(seam.take(f.desc), f.pos.clone().add(back), f.yaw + Math.PI);
  }
  await precompile();
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
  for (const p of level.portals()) if (p.auto && p.box.containsPoint(feet) && seam.armed(p, feet)) return p;
  return null;
}

// ---------------------------------------------------------------- info panel

let infoOpen = false;
const museumCatalog = installMuseumCatalog({
  open: () => {
    if (!started || transitioning || infoOpen || mode !== 'museum') return false;
    infoOpen = true;
    player.keys.clear();
    document.exitPointerLock();
  },
  close: () => { infoOpen = false; },
  visit: (theme) => { void enter({ box: new THREE.Box3(), label: theme.name, target: { kind: 'gallery', theme: theme.id, page: 0, wing: theme.collection } }); },
});
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
  if (museumCatalog.opened) {
    if (e.code === 'Escape') museumCatalog.close();
    return;
  }
  if (e.code === 'KeyB' && mode === 'museum' && started && !transitioning && !infoOpen) {
    museumCatalog.show();
    return;
  }
  if (infoOpen && (e.code === 'Escape' || e.code === 'KeyE')) {
    closeInfo();
    return;
  }
  if (!started) return;
  if (e.code === 'KeyE' || e.code === 'Enter') {
    if (aimedBox) lazy.toggle(aimedBox);
    else if (aimed) enter(aimed);
  } else if (e.code === 'KeyQ' || e.code === 'Backspace') {
    if (!transitioning && !vert.shut) { // vertical.ts: no backing out of a moving lift car
      transitioning = true;
      goBack().then(() => (transitioning = false));
    }
  } else if (e.code === 'KeyC') toggleCredits();
  else if (e.code === 'KeyM') minimap.cycle(); // [minimap] minimap → large map → off
  else if (e.code === 'KeyG') {
    quality = quality === 'ultra' ? 'high' : quality === 'high' ? 'low' : 'ultra';
    applyQuality();
    toast(`Graphics: ${quality === 'ultra' ? 'ultra (ambient occlusion, bloom, 4K shadows)' : quality === 'high' ? 'high (bloom, 4K shadows)' : 'low'}`);
  } else if (e.code === 'KeyT') {
    const label = lighting.cycle(e.shiftKey ? -1 : 1);
    toast(lighting.place === 'outdoor' ? `Time of day: ${label}` : `Time of day: ${label} (outside)`);
  } else if (e.code === 'KeyY') {
    toast(`Weather: ${weather.cycle(e.shiftKey ? -1 : 1)}`);
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
const bootTimes: { firstFrame?: number } = {};
(window as unknown as { __boot: typeof bootTimes }).__boot = bootTimes;
let time = 0;

let lab: { controls: OrbitControls; level: LabLevel } | null = null;

// dynamic resolution: watch real frame times; drop the pixel ratio when slower than ~45 fps,
// raise it again under ~70 fps (checked every 2 s, so it never oscillates frame to frame)
let dynT = 0, dynN = 0, dynSum = 0;
const DYN = !params0.has('nodyn');
function dynamicResolution(raw: number) {
  if (!DYN || quality === 'low') return;
  dynSum += raw;
  dynN++;
  dynT += raw;
  if (dynT < 2) return;
  const avg = dynSum / dynN;
  dynT = dynSum = dynN = 0;
  const next = avg > 1 / 45 ? Math.max(0.6, dynScale - 0.1) : avg < 1 / 70 ? Math.min(1, dynScale + 0.1) : dynScale;
  if (Math.abs(next - dynScale) > 1e-3) {
    dynScale = next;
    applySize();
  }
}

function frame() {
  const raw = clock.getDelta();
  const dt = Math.min(0.05, raw);
  if (!document.hidden) dynamicResolution(Math.min(raw, 0.5));
  time += dt;
  if (lab) {
    lab.controls.update();
    lab.level.update(dt, camera.position, time);
    lighting.update(dt, lab.controls.target);
    weather.update(dt, lab.controls.target);
    updateDetail(camera.position, 60);
    draw();
    requestAnimationFrame(frame);
    return;
  }
  if (memTrackerOn() && ++memTick % 120 === 0) memTrackChildren(scene);
  if (level && !transitioning) {
    const active = started || coarse;
    player.update(dt, seam.colliders(level.colliders(player.pos), player.pos), !active || infoOpen);
    const movingInput = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].some((key) => player.keys.has(key)) || player.touchMove.lengthSq() > 0;
    inspectionZoom.update(dt, active && !infoOpen && player.onGround && !movingInput && Math.hypot(player.vel.x, player.vel.z) < 0.15 && player.keys.has('KeyZ'));
    level.update(dt, player.pos, time);
    minimap.update(level, player.pos, player.yaw, time); // [minimap] 2D overlay, throttled, no WebGL
    const walked = seam.update(dt, level, player.pos); // seamless.ts: prebuild, previews, walking through doors
    if (active && walked.enter) enter(walked.enter);
    else if (active && walked.exit && !transitioning) {
      transitioning = true;
      goBack(true).then(() => (transitioning = false));
    }
    // ---- vertical.ts hook: walking up/down stairs and arriving by lift switch floors in this frame
    const vsw = !transitioning ? vert.update(dt, level, active && !infoOpen) : null;
    if (vsw) {
      const t0 = performance.now();
      const vel = player.vel.clone(), onGround = player.onGround;
      toWorld = floorWorld(toWorld, currentDesc, vsw.desc);
      seamFloorStack(currentDesc, vsw.desc);
      currentDesc = vsw.desc;
      seamSwitch(seam.take(vsw.desc), vsw.pos, vsw.yaw);
      player.vel.copy(vel);
      player.onGround = onGround;
      camera.position.y += vsw.dy;
      vert.afterSwitch(level, vsw);
      vert.stats.maxSwitchMs = Math.max(vert.stats.maxSwitchMs, performance.now() - t0);
      if (vsw.why === 'lift' || (currentDesc.kind === 'floor' && currentDesc.floor >= currentDesc.floors)) toast(descName(currentDesc));
    }
    // ---- end vertical hook
    // ---- windowview.ts: the real city in the windows of the room you are in
    {
      const cityDesc = cityDescIn();
      const city = cityDesc && seam.ready(cityDesc) ? seam.slots.get(descKey(cityDesc))?.level : undefined;
      const hulls = city && 'hulls' in city ? [...(city as unknown as { hulls(): Map<string, Hullish[]> }).hulls().values()].flat() : null;
      views.setLevel(level, toWorld, currentDesc.kind === 'nyc');
      views.update(city && hulls ? { group: city.group, hulls, level: city } : null);
    }
    const auto = active ? autoPortal() : null;
    if (auto) enter(auto);
    aimed = active && !infoOpen ? target() : null;
    aimedNow = aimed;
    lazy.update(dt, camera, level);
    const box = active && !infoOpen ? lazy.aim(ray, 2.4, level) : null; // ray was set by target()
    aimedBox = box && (!aimed || box.d < 1.6) ? box.c : null;
    if (aimedBox) {
      outline.box.copy(aimedBox.box);
      outline.visible = true;
      outlineMat.opacity = 0.55 + 0.35 * Math.sin(time * 6);
      hud.promptKey.textContent = 'E';
      hud.promptLabel.textContent = `${aimedBox.open ? 'Close' : 'Open'} the ${aimedBox.label}`;
      hud.promptSub.textContent = '';
      hud.prompt.classList.add('show');
    } else if (aimed) {
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
    if (PROBE_PEDCAR) probePedCar(level, time); // ?probe=pedcar (src/probe.ts)
    lighting.update(dt, player.pos);
    weather.update(dt, player.pos);
    updateDetail(player.pos, mode === 'museum' ? 40 : 30);
    draw();
    // boot timing (perf checks): the first frame drawn in play, ms since page start
    if (!bootTimes.firstFrame) bootTimes.firstFrame = Math.round(performance.now());
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- start

const params = new URLSearchParams(location.search);
mark('modules loaded');
const ready = timed('ready', Promise.all([timed('manifest', loadManifest()), timed('museum data', loadMuseum()), timed('pbr', loadPbr(renderer)), timed('rebuilt index', loadRebuiltIndex())]));

async function startMode(m: Mode) {
  inspectionZoom.reset();
  mode = m;
  await ready;
  stack.length = 0;
  scale = 1;
  roomsVisited = 0;
  document.body.dataset.mode = m;
  hud.help.innerHTML = m === 'museum'
    ? '<kbd>WASD</kbd> walk · hold <kbd>Z</kbd> zoom while still · <kbd>B</kbd> collections · <kbd>E</kbd> inspect · <kbd>Q</kbd> back'
    : '<kbd>WASD</kbd> move · <kbd>Shift</kbd> run · hold <kbd>Z</kbd> zoom while still · <kbd>E</kbd> enter / shrink in · <kbd>Q</kbd> back · <kbd>T</kbd> time · <kbd>Y</kbd> weather · <kbd>C</kbd> credits';
  if (m === 'museum') currentDesc = { kind: 'atrium' };
  else {
    const seed = params.has('seed') ? Number(params.get('seed')) || hashStr(params.get('seed')!) : 20261105;
    currentDesc = params.get('biome') ? { kind: 'city', seed, biome: params.get('biome')!, name: 'The World' } : { kind: 'nyc', seed, name: 'Manhattan' };
    // vertical.ts: ?building=walkup|prewar|office|loft&floors=n&floor=n starts inside a building (testing)
    if (params.get('building')) currentDesc = testBuilding(params);
  }
  if (level) scene.remove(level.group);
  toWorld = currentDesc.kind === 'nyc' ? new THREE.Matrix4() : null;
  seam.clear();
  museumRoutes.reset(museum().wings.map((w) => ({ kind: 'gallery', theme: w.theme, page: 0 })));
  mark('level build start');
  setLevel(seam.take(currentDesc));
  mark('level built');
  if (FLAGS.fast || params.get('precompile') !== '0') {
    // (?precompile=0 skips it, for A/B timing)
    // compile every program up front while the start screen is still up, in parallel where
    // KHR_parallel_shader_compile allows, instead of one blocking compile after another inside the
    // first frames. The lighting runs once first so outdoor materials get their CSM (cascade) variant
    // and the light rig is padded to LIGHT_BUDGET: the programs compiled here are the ones drawn.
    transitioning = true;
    if (FLAGS.fast) stripTextures(scene);
    lighting.update(0, player.pos);
    camera.position.set(player.pos.x, player.pos.y + 1.65, player.pos.z);
    camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
    await renderer.compileAsync(scene, camera).catch(() => {});
    transitioning = false;
    mark(`programs compiled (${renderer.info.programs?.length ?? 0})`);
  }
  started = true;
  hud.start.classList.add('hidden');
  hud.start.classList.remove('paused');
  lock();
  toast(m === 'museum' ? 'Six wings. Walk through any doorway — each leads to rooms of similar objects, forever.' : 'Walk into any shop or door. Look at anything and press E.');
}

/** ?lab=<scene>: one model or a small scene with an orbit camera, for fast iteration */
async function startLab(name: string) {
  const sc = labScenes().find((x) => x.name === name) ?? labScenes().find((x) => x.name === 'index')!;
  hud.start.classList.add('hidden');
  document.body.classList.add('lab');
  const lv = new LabLevel(sc);
  if (params.get('env')) lv.env = (await import('./lab')).LAB_ENVS[params.get('env')!] ?? lv.env;
  level = lv;
  scene.add(lv.group);
  const envName = params.get('env') ?? sc.env ?? 'studio';
  if (envName === 'night') lighting.setTime('night');
  applyEnv(lv.env, envName === 'nyc' || envName === 'night' ? 'outdoor' : envName === 'museum' ? 'museum' : 'studio');
  camera.position.copy(vec(params.get('cam'), sc.cam ?? [3, 2, 4]));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(vec(params.get('look'), sc.look ?? [0, 0.6, 0]));
  controls.enableDamping = true;
  controls.autoRotate = params.has('spin');
  lab = { controls, level: lv };
  hud.crumbs.textContent = `lab · ${sc.name}`;
  const done = Promise.resolve(sc.build({ params, group: lv.group, renderer, camera }))
    .then(() => {
      // a scene may hand over its own environment and a camera (e.g. a whole interior level)
      const u = lv.group.userData;
      if (u.env) applyEnv((lv.env = u.env), u.place);
      if (u.cam && !params.has('cam')) camera.position.copy(u.cam);
      if (u.look && !params.has('look')) controls.target.copy(u.look);
    })
    .then(() => mark('lab built'))
    .then(() => lighting.ready)
    .then(() => mark('lighting ready'))
    .then(() => new Promise((r) => setTimeout(r, Number(params.get('settle') ?? 1500))));
  (window as unknown as { __labReady: Promise<unknown> }).__labReady = done;
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
mark('quality applied');
ready.then(() => {
  // after the world is up and you have been playing a while (boot memory/time: e2e finding 4)
  if (!params.has('lab') && seam.enabled && !FLAGS.fast) setTimeout(prewarmShops, 20000);
  // lazy-furniture.ts: compile the furniture-opening code on a tiny chest, so the first real cut isn't cold
  if ('requestIdleCallback' in window) requestIdleCallback(() => warmUp(), { timeout: 3000 });
  else setTimeout(warmUp, 1000);
  hud.loading.classList.add('hidden');
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => (b.disabled = false));
  $('museum-count').textContent = museum().total.toLocaleString();
  setupTouch();
  const pm = params.get('mode');
  if (params.has('lab')) startLab(params.get('lab')!);
  else if (pm === 'museum' || pm === 'world') startMode(pm);
  frame();
});

// [minimap] a click on the large map teleports the player (the same path the e2e journeys use)
minimap.onTeleport = (x, z, yaw) => player.place(new THREE.Vector3(x, 0, z), yaw);

Object.assign(window, {
  __world: { seam, vert, renderer, lighting, weather, scene, camera, gtao, bloom, player, enter, goBack, get level() { return level; }, get aimed() { return aimed; }, startMode,
    // scripts/e2e: read-only views of the journey state
    lazy, views, get toWorld() { return toWorld; }, get stack() { return stack; },
    /** e2e: the stair / lift floor switch (vertical hook below) to floor n of the building you are in */
    goFloor(n: number) {
      if (currentDesc.kind !== 'floor') return false;
      const to: LevelDesc = { ...currentDesc, floor: n };
      toWorld = floorWorld(toWorld, currentDesc, to);
      seamFloorStack(currentDesc, to);
      currentDesc = to;
      seamSwitch(seam.take(to), undefined, undefined);
      return true;
    }, get desc() { return currentDesc; }, get started() { return started; }, get transitioning() { return transitioning; }, get aimedBox() { return aimedBox; }, get infoOpen() { return infoOpen; }, get mode() { return mode; } },
});

// ---- WP1 perf hook (src/perf.ts): whole-frame/per-pass counts, window.__world.perf(), ?perf=1 overlay ----
import('./perf').then((m) => m.installPerf({ renderer, composer, scene, camera, level: () => level }));
// ---- end perf hook ----
