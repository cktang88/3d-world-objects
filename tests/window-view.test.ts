/**
 * The real city in apartment windows (src/windowview.ts): the capture camera stands where the
 * window is in the city (street door -> lobby -> 4th floor -> apartment, the way main.ts chains the
 * frames) at that floor's height; the cubemap is rendered one face a frame, put on the windows,
 * reused when you come back to the room, and freed when you leave the building.
 */
import * as THREE from 'three';
import { test, expect, between, fmt } from './qa';
import './env';
import { FloorLevel, SPECS, type FloorDesc } from '../src/rooms/vertical';
import { InteriorLevel } from '../src/interior';
import { doorOf, entryOf } from '../src/seamless';
import { WindowViews, captureSpot, enterWorld, floorWorld, windowCentre, windowMeshes, ViewCache, type Hullish } from '../src/windowview';
import type { Level, LevelDesc } from '../src/level';

const lobbyDesc: FloorDesc = { kind: 'floor', seed: 77, name: '212 Test St', type: 'walkup', floor: 0, floors: 6 };
// a street door in the city: facade facing +x at (100, 0, 40); walking in faces -x
const street = { pos: new THREE.Vector3(100, 0, 40), yaw: Math.PI / 2 }; // forward is (-sin yaw, 0, -cos yaw)

function chain() {
  const lobby = new FloorLevel(lobbyDesc);
  const wLobby = enterWorld(new THREE.Matrix4(), street, entryOf(lobby) ?? null)!;
  const d3 = { ...lobbyDesc, floor: 3 };
  const w3 = floorWorld(wLobby, lobbyDesc, d3)!;
  const floor = new FloorLevel(d3);
  const door = floor.portals().find((p) => typeof p.target === 'object' && p.target.kind === 'interior')!;
  const apt = new InteriorLevel(door.target as Extract<LevelDesc, { kind: 'interior' }>);
  const wApt = enterWorld(w3, doorOf(door), entryOf(apt) ?? null)!;
  return { lobby, wLobby, floor, w3, apt, wApt };
}

test('the window view is captured where the window is in the city, at its floor height (4th floor)', () => {
  const { lobby, wLobby, floor, apt, wApt } = chain();
  // the lobby's own street door lands on the city's street door
  const e = entryOf(lobby)!.pos.clone().applyMatrix4(wLobby);
  between(e.distanceTo(street.pos), 0, 0.001, 'lobby entry to the street door (m)');
  const meshes = windowMeshes(apt.group);
  expect(meshes.length > 0, 'the apartment has window backdrops');
  const local = windowCentre(meshes)!;
  const win = local.clone().applyMatrix4(wApt);
  const H = SPECS.walkup.H;
  console.log(`   window: local y ${fmt(local.y)} -> city (${fmt(win.x)}, ${fmt(win.y)}, ${fmt(win.z)}); floor 4 at ${fmt(3 * H)} m`);
  between(win.y - local.y, 3 * H - 0.001, 3 * H + 0.001, 'window raised by three storeys (m)');
  expect(win.x < street.pos.x, 'the window is behind the facade (inside the building), not out in the street');
  // the building the window is in, and one across the street
  const hulls: Hullish[] = [
    { rect: { minX: win.x - 7, maxX: win.x + 3, minZ: win.z - 12, maxZ: win.z + 8 }, top: 20 },
    { rect: { minX: win.x + 20, maxX: win.x + 35, minZ: win.z - 10, maxZ: win.z + 10 }, top: 40 },
  ];
  const s = captureSpot(win, hulls);
  expect(s.hull === hulls[0], 'captured from the building the window is in');
  between(s.pos.y, win.y - 1e-6, win.y + 1e-6, 'capture height = the window world height');
  between(s.pos.x, win.x - 2.001, win.x - 1.999, 'capture x (the building centre)');
  // near planes just past its own facades (5 m half width, 10 m half depth) and roof
  between(s.near[0], 5.3, 5.4, '+x near (m)');
  between(s.near[4], 10.3, 10.4, '+z near (m)');
  between(s.near[2], 20 - win.y + 0.3, 20 - win.y + 0.4, 'up near: past the roof (m)');
  expect(s.boxMin.y === 0 && s.boxMax.x > hulls[0].rect.maxX + 10, 'parallax box: the street below and across');
  void floor;
});

test('the window cubemap: one face a frame, reused, recaptured when the time changes, freed when you leave', () => {
  const { floor, apt, wApt, w3 } = chain();
  const win = windowCentre(windowMeshes(apt.group))!.applyMatrix4(wApt);
  const hulls: Hullish[] = [{ rect: { minX: win.x - 7, maxX: win.x + 3, minZ: win.z - 12, maxZ: win.z + 8 }, top: 20 }];
  let renders = 0;
  const renderer = {
    getRenderTarget: () => null, getActiveCubeFace: () => 0, setRenderTarget() {}, clear() {}, render: () => renders++,
    shadowMap: { autoUpdate: true }, xr: { enabled: false }, toneMappingExposure: 1,
  } as unknown as THREE.WebGLRenderer;
  const scene = new THREE.Scene();
  const cityGroup = new THREE.Group();
  const lamp = new THREE.PointLight();
  cityGroup.add(lamp);
  let streamed = 0;
  const city = { group: cityGroup, hulls, level: { update: () => void streamed++ } };
  let outdoor = 0, fog = 0, released = 0, asked = 0, refreshed = 0;
  let tod = 'day', stale = false;
  const views = new WindowViews({
    renderer, scene, asOutdoor: (fn, f) => (outdoor++, (fog = f), fn(), true), outdoorKey: () => tod, gain: () => 1.2,
    stale: () => stale, refresh: () => (refreshed++, (stale = false), (tod = 'dusk'), Promise.resolve(true)),
    release: () => void released++, needCity: () => void asked++,
  });
  views.setLevel(apt, wApt);
  for (let i = 0; i < 6; i++) views.update(city);
  expect(renders === 6 && outdoor === 6, `one face a frame with the outdoor light (renders ${renders})`);
  between(fog, 0.2, 0.5, 'capture fog (x the street fog)');
  expect(!cityGroup.parent && lamp.visible && apt.group.position.y === 0, 'the city and the room are put back after each face');
  let real = 0;
  apt.group.traverse((o) => { if ((o as THREE.Mesh).isMesh && ((o as THREE.Mesh).material as THREE.Material).userData?.realView) real++; });
  expect(real > 0 && !windowMeshes(apt.group).length, 'the window planes show the capture');
  expect(released === 1, 'the street level may go once captured');
  views.update(null);
  expect(renders === 6 && asked === 0, 'nothing more per frame once captured, and no city needed');
  // out to the hall and back in, the city gone: the capture is reused
  views.setLevel(floor as Level, w3);
  views.update(null);
  const apt2 = chain().apt;
  views.setLevel(apt2, wApt);
  views.update(null);
  expect(views.stats.hits === 1 && renders === 6 && asked === 0, `same building, floor and light: cached (hits ${views.stats.hits}, renders ${renders})`);
  // the time of day changes indoors: the outdoor light is recomputed, the city rebuilt and streamed at the building, then recaptured
  stale = true;
  views.update(null);
  expect(refreshed === 1, 'outdoor light recomputed');
  views.update(null);
  expect(asked === 1, 'the city is asked for (rebuilt lazily)');
  for (let i = 0; i < 60; i++) views.update(city);
  expect(streamed === 30 && renders === 12 && released === 2, `streamed ${streamed} frames, then 6 more faces (renders ${renders}), released again`);
  // back on the street: freed
  views.setLevel({ group: cityGroup } as unknown as Level, new THREE.Matrix4(), true);
  expect(views.cache.map.size === 0 && views.stats.freed === 2, `freed on leaving the building (${views.stats.freed})`);
});

test('the window view cache keeps a few captures and disposes the oldest', () => {
  const c = new ViewCache(2);
  const gone: string[] = [];
  const mk = (k: string) => ({ key: k, faces: 6, spot: captureSpot(new THREE.Vector3(), []), rt: { texture: new THREE.Texture(), dispose: () => gone.push(k) } });
  c.add(mk('a'));
  c.add(mk('b'));
  c.get('a');
  c.add(mk('c'));
  expect(gone.join() === 'b' && c.map.size === 2, `least recently used goes first (${gone})`);
  c.clear();
  expect(gone.length === 3, 'clear frees the rest');
});

test('office suites and lobbies have window-view planes too, and window panes are clear glass', async () => {
  const { OfficeLevel, OFFICE_TYPES } = await import('../src/rooms/office');
  const { M } = await import('../src/rooms/mats');
  const t = (OFFICE_TYPES as unknown as string[])[0];
  const office = new OfficeLevel({ kind: 'interior', seed: 5, name: 'Suite', style: 'office', floor: 3, floors: 8, biome: 'town', office: t } as unknown as Extract<LevelDesc, { kind: 'interior' }>);
  const lobby = new FloorLevel(lobbyDesc);
  const n = { office: windowMeshes(office.group).length, lobby: windowMeshes(lobby.group).length };
  expect(n.office > 0 && n.lobby > 0, `window-view planes: office ${n.office}, lobby ${n.lobby}`);
  // the lobby's plane is outside its street door (beyond the door, away from the room)
  const c = windowCentre(windowMeshes(lobby.group))!;
  const door = entryOf(lobby)!.pos;
  expect(c.z > door.z, `lobby view plane outside the street door (z ${fmt(c.z)} vs door ${fmt(door.z)})`);
  const g = M.windowGlass();
  expect(g.color.getHex() === 0 && g.opacity <= 0.08, 'window glass: unlit base, faint');
  const { apt } = chain();
  let panes = 0;
  apt.group.traverse((o) => { if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).material === g) panes++; });
  expect(panes > 0, 'apartment windows use the clear window glass');
});

test('after capture no painted backdrop remains, also in rooms built after you entered', async () => {
  const { finishBuilding } = await import('../src/level');
  const lobby = new FloorLevel(lobbyDesc);
  const w3 = floorWorld(enterWorld(new THREE.Matrix4(), street, entryOf(lobby) ?? null), lobbyDesc, { ...lobbyDesc, floor: 3 })!;
  const floor = new FloorLevel({ ...lobbyDesc, floor: 3 });
  const door = floor.portals().find((p) => typeof p.target === 'object' && p.target.kind === 'interior')!;
  const apt = new InteriorLevel(door.target as Extract<LevelDesc, { kind: 'interior' }>, { staged: true });
  // a few construction slices only: some rooms (and their windows) do not exist yet
  for (let i = 0; i < 3 && apt.staging; i++) apt.staging.next();
  const wApt = enterWorld(w3, doorOf(door), entryOf(apt) ?? null) ?? enterWorld(w3, doorOf(door), { pos: new THREE.Vector3(), yaw: 0 })!;
  const renderer = {
    getRenderTarget: () => null, getActiveCubeFace: () => 0, setRenderTarget() {}, clear() {}, render() {},
    shadowMap: { autoUpdate: true }, xr: { enabled: false }, toneMappingExposure: 1,
  } as unknown as THREE.WebGLRenderer;
  const views = new WindowViews({ renderer, scene: new THREE.Scene(), asOutdoor: (fn) => (fn(), true), outdoorKey: () => 'night', gain: () => 1 });
  const hulls: Hullish[] = [{ rect: { minX: -200, maxX: 200, minZ: -200, maxZ: 200 }, top: 30 }];
  const city = { group: new THREE.Group(), hulls };
  views.setLevel(apt, wApt);
  const early = windowMeshes(apt.group).length;
  for (let i = 0; i < 40; i++) views.update(city);
  finishBuilding(apt);
  const late = windowMeshes(apt.group).length;
  for (let i = 0; i < 40; i++) views.update(city);
  const left = windowMeshes(apt.group).length;
  let real = 0;
  apt.group.traverse((o) => { if ((o as THREE.Mesh).isMesh && ((o as THREE.Mesh).material as THREE.Material).userData?.realView) real++; });
  console.log(`   painted backdrops: ${early} when entered, ${late} once built, ${left} left; ${real} on the capture`);
  expect(late > 0 && real > 0, 'the finished apartment has windows on the capture');
  expect(left === 0, `${left} painted backdrops left after capture`);
});
