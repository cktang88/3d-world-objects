import * as THREE from 'three';
import { disposeObject } from './dispose';
import type { Biome } from './biomes';
import type { ModelEntry } from './assets';
import type { RemoteEntry } from './remote';

export interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** a vehicle's footprint (parked, showcase): pedestrians treat it like a car (people.ts Pedestrians.cars) */
  vehicle?: boolean;
}

/** tag a collider as a vehicle's footprint */
export function vehicleRect(r: Rect): Rect {
  r.vehicle = true;
  return r;
}

export type LevelDesc =
  | { kind: 'city'; seed: number; biome: string; name: string; source?: ModelEntry; sourceScale?: number }
  | { kind: 'interior'; seed: number; name: string; style: string; floor: number; floors: number; biome: string; shop?: string }
  | { kind: 'nyc'; seed: number; name: string }
  | { kind: 'atrium' }
  | { kind: 'gallery'; theme: number; page: number; wing?: string }
  /** a storey of a building (src/rooms/vertical.ts): floor 0 is the lobby, floor === floors the roof */
  | { kind: 'floor'; seed: number; name: string; type: string; floor: number; floors: number }
  /** the world inside a small object, built from the object (src/macro.ts): garden, vessel, circuit, food, surface */
  | { kind: 'macro'; seed: number; name: string; mode: string; title: string; source?: ModelEntry; sourceScale: number };

export interface Portal {
  box: THREE.Box3;
  label: string;
  sub?: string;
  /** a level to enter, 'back' to climb out, or 'inspect' to open the info panel */
  target: LevelDesc | 'back' | 'inspect';
  inspect?: RemoteEntry;
  /** walk-through doorways trigger by themselves */
  auto?: boolean;
  /** where to stand (and face) when you come back through this portal */
  returnPos?: THREE.Vector3;
  returnYaw?: number;
  /** relative size of the thing being entered (for the scale counter) */
  shrink?: number;
  /**
   * seamless doors (src/seamless.ts): the doorway in world space. `pos` is a point on the
   * threshold at floor level, `yaw` the player yaw of someone walking IN through it. `see`: the
   * door/windows are glass, so the prebuilt level is shown behind it; `hole` is the world box of
   * glass (fake-interior shader) to cut away while the real interior shows.
   */
  door?: { pos: THREE.Vector3; yaw: number; see?: boolean; hole?: THREE.Box3; range?: number };
  /** told when the level behind this door starts / stops being shown through it (museum doorways hide their end wall) */
  onPreview?: (shown: boolean) => void;
}

export interface Env {
  skyTop: string;
  skyBottom: string;
  stars: boolean;
  fog: string | null;
  fogNear: number;
  fogFar: number;
  sun: { color: string; intensity: number; elev: number; azim: number } | null;
  hemi: { sky: string; ground: string; intensity: number };
  ambient: number;
  envIntensity: number;
  exposure: number;
  /** use the physical sky (and bake it into reflections) instead of a gradient */
  physicalSky?: boolean;
}

export interface Level {
  name: string;
  group: THREE.Group;
  spawn: { pos: THREE.Vector3; yaw: number };
  env: Env;
  biome?: Biome;
  colliders(near: THREE.Vector3): Rect[];
  portals(): Portal[];
  update(dt: number, player: THREE.Vector3, time: number): void;
  dispose(): void;
  /**
   * seamless doors (src/seamless.ts): the level's own entry doorway (threshold point at floor
   * level, yaw of the player walking in). `hide` lists objects (e.g. the shop front wall seen from
   * outside) to hide while the level is shown through a street door. Optional: without it the
   * 'back' portal (its box centre and returnYaw) is used.
   */
  doorway?: { pos: THREE.Vector3; yaw: number; hide?: THREE.Object3D[] };
  /**
   * staged construction (src/seamless.ts): a level built with `{ staged: true }` leaves the rest
   * of its construction here; each next() does one slice (a room, a fixture run). Whoever built
   * it must drain it (seamless.ts does so within a per-frame ms budget) before using the level.
   */
  staging?: Iterator<unknown>;
  /** seamless.ts: other levels to prebuild now (e.g. the floors above and below when near a stair; src/rooms/vertical.ts) */
  prefetch?(player: THREE.Vector3): LevelDesc[];
}

/** run a staged level's remaining construction at once */
export function finishBuilding<T extends Level>(lv: T): T {
  if (lv.staging) {
    while (!lv.staging.next().done);
    lv.staging = undefined;
  }
  return lv;
}

export function rect(cx: number, cz: number, w: number, d: number): Rect {
  return { minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 };
}

export function overlaps(a: Rect, b: Rect, pad = 0): boolean {
  return a.minX < b.maxX + pad && a.maxX > b.minX - pad && a.minZ < b.maxZ + pad && a.maxZ > b.minZ - pad;
}

/**
 * Free a level / chunk subtree: owned geometry (`userData.owned`), instance and batch buffers, and
 * materials/textures tagged `userData.owned` (per-object signs, labels); shared caches are left
 * alone. See src/dispose.ts.
 */
export function disposeTree(o: THREE.Object3D, keep?: Set<unknown>) {
  disposeObject(o, { keep });
}
