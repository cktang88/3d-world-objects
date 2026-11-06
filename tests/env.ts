/**
 * Game-side setup for qa tests (after tests/shim.ts has provided the browser globals):
 * the shared GLTF loader is created against a fake renderer so modules that stream models
 * get a loader whose fetches 404 (no models) and fall back to their stand-ins.
 * Import this from a test before importing level modules.
 */
import * as THREE from 'three';
import { initDetail } from '../src/detail';

const fakeRenderer = {
  capabilities: { getMaxAnisotropy: () => 1, isWebGL2: true, maxTextureSize: 4096 },
  extensions: { has: () => false, get: () => null },
  isWebGLRenderer: true,
} as unknown as THREE.WebGLRenderer;
initDetail(fakeRenderer);

export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
/** let pending promises (manifest/json loads, rejected model fetches) settle */
export const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** let local GLBs whose public/ path matches `re` load (e.g. /assets\/people\//); remote ones stay blocked */
export function allowModels(re: RegExp | boolean) {
  (globalThis as unknown as { __QA: { models: RegExp | boolean } }).__QA.models = re;
}
/** set URL flags (?people=40&pfar=0) before dynamically importing modules that read them at load */
export function setSearch(q: string) {
  (globalThis as unknown as { location: { search: string } }).location.search = q ? `?${q.replace(/^\?/, '')}` : '';
}
