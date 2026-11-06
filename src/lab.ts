import * as THREE from 'three';
import type { Env, Level, Portal, Rect } from './level';
import { surface } from './pbr';

/**
 * The lab: render one model or one small scene with an orbit camera, for fast iteration.
 *
 *   /?lab=<scene>&cam=x,y,z&look=x,y,z&env=studio|nyc|museum|night&quality=ultra|high|low
 *
 * Scenes live in src/lab/*.ts (one file per scene, picked up automatically) and default-export
 * a LabScene. build() may return a promise: the screenshot script waits for window.__labReady.
 */
export interface LabContext {
  params: URLSearchParams;
  /** add to this group */
  group: THREE.Group;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
}
export interface LabScene {
  name: string;
  description?: string;
  /** default camera position and look-at target */
  cam?: [number, number, number];
  look?: [number, number, number];
  env?: 'studio' | 'nyc' | 'museum' | 'night';
  /** add a ground plane (default true) */
  ground?: boolean;
  build(ctx: LabContext): void | Promise<void>;
  update?(dt: number, time: number): void;
}

const modules = import.meta.glob<{ default: LabScene }>('./lab/*.ts', { eager: true });
export function labScenes(): LabScene[] {
  return Object.values(modules).map((m) => m.default).filter(Boolean);
}

export const LAB_ENVS: Record<string, Env> = {
  studio: {
    skyTop: '#9aa4ae', skyBottom: '#d8dde2', stars: false, fog: null, fogNear: 0, fogFar: 0,
    sun: { color: '#fff4e6', intensity: 3.0, elev: 50, azim: 35 }, hemi: { sky: '#e8eef5', ground: '#8a8478', intensity: 0.9 },
    ambient: 0.05, envIntensity: 0.8, exposure: 0.9,
  },
  nyc: {
    skyTop: '#5d8cc4', skyBottom: '#e9dcc8', stars: false, fog: '#aab6c2', fogNear: 110, fogFar: 420,
    sun: { color: '#ffd9a8', intensity: 4.2, elev: 30, azim: 235 }, hemi: { sky: '#cfdcec', ground: '#5a5046', intensity: 0.9 },
    ambient: 0.05, envIntensity: 0.55, exposure: 0.62, physicalSky: true,
  },
  museum: {
    skyTop: '#16130f', skyBottom: '#211c16', stars: false, fog: null, fogNear: 0, fogFar: 0, sun: null,
    hemi: { sky: '#fff6e8', ground: '#4a4036', intensity: 0.85 }, ambient: 0.12, envIntensity: 0.55, exposure: 1.0,
  },
  night: {
    skyTop: '#05070f', skyBottom: '#1a1f33', stars: true, fog: '#141826', fogNear: 40, fogFar: 260,
    sun: { color: '#9fb4ff', intensity: 0.4, elev: 40, azim: 120 }, hemi: { sky: '#3a4a7a', ground: '#141018', intensity: 0.35 },
    ambient: 0.05, envIntensity: 0.3, exposure: 1.1,
  },
};

/** A Level wrapper so the lab can reuse the renderer's environment handling. */
export class LabLevel implements Level {
  name: string;
  group = new THREE.Group();
  spawn = { pos: new THREE.Vector3(), yaw: 0 };
  env: Env;
  constructor(public scene: LabScene) {
    this.name = `Lab · ${scene.name}`;
    this.env = LAB_ENVS[scene.env ?? 'studio'];
    if (scene.ground !== false) {
      const g = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), surface('floor_concrete', [40, 40], { roughness: 1 }));
      g.rotation.x = -Math.PI / 2;
      g.receiveShadow = true;
      this.group.add(g);
    }
  }
  colliders(): Rect[] {
    return [];
  }
  portals(): Portal[] {
    return [];
  }
  update(dt: number, _p: THREE.Vector3, time: number) {
    this.scene.update?.(dt, time);
  }
  dispose() {}
}

export function vec(s: string | null, fallback: [number, number, number]): THREE.Vector3 {
  if (!s) return new THREE.Vector3(...fallback);
  const v = s.split(',').map(Number);
  return new THREE.Vector3(v[0] || 0, v[1] || 0, v[2] || 0);
}
