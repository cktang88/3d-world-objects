import type { FacadeStyle } from './textures';

export interface Biome {
  id: string;
  name: string;
  skyTop: string;
  skyBottom: string;
  fog: string;
  fogNear: number;
  fogFar: number;
  asphalt: string;
  line: string;
  sidewalk: string;
  grass: string;
  sun: { color: string; intensity: number; elev: number; azim: number };
  hemi: { sky: string; ground: string; intensity: number };
  night: boolean;
  floors: [number, number];
  styles: FacadeStyle[];
  walls: string[];
  roofs: string[];
  gableChance: number;
  parkChance: number;
  landmarkChance: number;
  windowLit: number;
  neon?: string[];
  snow?: boolean;
  circuit?: boolean;
  exposure: number;
}

export const BIOMES: Record<string, Biome> = {
  town: {
    id: 'town', name: 'Old Town', skyTop: '#4f8fd6', skyBottom: '#cfe3f2', fog: '#cfe0ee', fogNear: 60, fogFar: 230,
    asphalt: '#47494d', line: '#e8d27a', sidewalk: '#b8b2a7', grass: '#5b8a3c',
    sun: { color: '#fff3dd', intensity: 2.6, elev: 50, azim: 35 }, hemi: { sky: '#cfe6ff', ground: '#6b5e4a', intensity: 0.9 },
    night: false, floors: [2, 6], styles: ['brick', 'plaster', 'timber'], walls: ['#b5583f', '#d9c9a8', '#e6dccb', '#9c6b4e', '#c7a27a', '#8fa3a8'],
    roofs: ['#6b3a2a', '#4a4f57', '#7a4a32'], gableChance: 0.5, parkChance: 0.16, landmarkChance: 0.16, windowLit: 0.15, exposure: 1.0,
  },
  metropolis: {
    id: 'metropolis', name: 'Metropolis', skyTop: '#3d4f8f', skyBottom: '#f2b48a', fog: '#e6b79a', fogNear: 70, fogFar: 260,
    asphalt: '#3a3c40', line: '#f0f0f0', sidewalk: '#a7a7a2', grass: '#4f7a3a',
    sun: { color: '#ffc58f', intensity: 2.3, elev: 16, azim: 250 }, hemi: { sky: '#ffd8b8', ground: '#4a4040', intensity: 0.8 },
    night: false, floors: [6, 22], styles: ['glass', 'panel', 'glass', 'brick'], walls: ['#8b9aa6', '#c9c4bb', '#6d7680', '#a8b4bd', '#d4cfc7'],
    roofs: ['#3a3c40'], gableChance: 0, parkChance: 0.1, landmarkChance: 0.12, windowLit: 0.35, exposure: 1.0,
  },
  neon: {
    id: 'neon', name: 'Neon Night', skyTop: '#06061a', skyBottom: '#2a1240', fog: '#1d0f2e', fogNear: 30, fogFar: 170,
    asphalt: '#1c1c22', line: '#ff4fd8', sidewalk: '#3a3a44', grass: '#1f3a2a',
    sun: { color: '#8fa0ff', intensity: 0.5, elev: 40, azim: 120 }, hemi: { sky: '#5a3cff', ground: '#200a2a', intensity: 0.55 },
    night: true, floors: [4, 16], styles: ['glass', 'panel', 'brick'], walls: ['#2b2d3a', '#3a2f45', '#24303a', '#40404a'],
    roofs: ['#15151a'], gableChance: 0, parkChance: 0.08, landmarkChance: 0.14, windowLit: 0.55, neon: ['#ff2fd0', '#2ff3ff', '#ffe02f', '#7a5cff', '#3dff8f'], exposure: 1.1,
  },
  snow: {
    id: 'snow', name: 'Snowfall Village', skyTop: '#9fb4c8', skyBottom: '#e9eef2', fog: '#e4eaef', fogNear: 25, fogFar: 150,
    asphalt: '#d9dde2', line: '#9aa5b0', sidewalk: '#eef2f5', grass: '#f4f7f9',
    sun: { color: '#e9f0ff', intensity: 1.6, elev: 25, azim: 160 }, hemi: { sky: '#e8f0ff', ground: '#b8c4cc', intensity: 1.1 },
    night: false, floors: [1, 3], styles: ['timber', 'plaster', 'brick'], walls: ['#7a3b2e', '#3e5a6b', '#d8c7a5', '#5f6b3a', '#8a5a3a'],
    roofs: ['#f4f7fa'], gableChance: 0.9, parkChance: 0.2, landmarkChance: 0.14, windowLit: 0.4, snow: true, exposure: 1.0,
  },
  desert: {
    id: 'desert', name: 'Dune Market', skyTop: '#3f86c9', skyBottom: '#f4dcb0', fog: '#efd8ae', fogNear: 60, fogFar: 240,
    asphalt: '#c9a978', line: '#f5ead2', sidewalk: '#dcc29a', grass: '#b8a25c',
    sun: { color: '#fff0c9', intensity: 3.0, elev: 62, azim: 80 }, hemi: { sky: '#ffe9c4', ground: '#a07a4a', intensity: 0.9 },
    night: false, floors: [1, 4], styles: ['adobe', 'plaster'], walls: ['#d9b48a', '#e8cfa6', '#c89b6d', '#e0b98f', '#f0dcc0'],
    roofs: ['#b98a5a'], gableChance: 0, parkChance: 0.14, landmarkChance: 0.18, windowLit: 0.1, exposure: 0.95,
  },
  toyland: {
    id: 'toyland', name: 'Toyland', skyTop: '#5ab0ff', skyBottom: '#d8f1ff', fog: '#d8efff', fogNear: 50, fogFar: 200,
    asphalt: '#5a5f7a', line: '#ffffff', sidewalk: '#f4e1a0', grass: '#58c96a',
    sun: { color: '#ffffff', intensity: 2.6, elev: 55, azim: 300 }, hemi: { sky: '#d6ecff', ground: '#8a6aa0', intensity: 1.0 },
    night: false, floors: [1, 5], styles: ['plaster', 'panel'], walls: ['#ff5a5f', '#ffd23f', '#3bceac', '#4d9de0', '#ee964b', '#b07bff'],
    roofs: ['#e83f6f', '#2274a5', '#ffbf00', '#32936f'], gableChance: 0.7, parkChance: 0.2, landmarkChance: 0.16, windowLit: 0.1, exposure: 1.0,
  },
  candy: {
    id: 'candy', name: 'Sugar Quarter', skyTop: '#ff9ccf', skyBottom: '#ffe3f1', fog: '#ffd9ec', fogNear: 40, fogFar: 180,
    asphalt: '#9a5b74', line: '#fff3a8', sidewalk: '#ffd0e4', grass: '#a6f0c6',
    sun: { color: '#fff0f6', intensity: 2.4, elev: 45, azim: 200 }, hemi: { sky: '#ffe0f0', ground: '#b06a8a', intensity: 1.0 },
    night: false, floors: [2, 7], styles: ['plaster', 'panel', 'brick'], walls: ['#ffb3d1', '#c9a0ff', '#a0e7ff', '#fff1a0', '#ffc8a0', '#8be0b8'],
    roofs: ['#ff6fa8', '#8a5cff', '#ffffff'], gableChance: 0.5, parkChance: 0.18, landmarkChance: 0.16, windowLit: 0.2, exposure: 1.0,
  },
  circuit: {
    id: 'circuit', name: 'Circuit City', skyTop: '#010309', skyBottom: '#0a2433', fog: '#061722', fogNear: 25, fogFar: 160,
    asphalt: '#06090f', line: '#19e3ff', sidewalk: '#0d1a24', grass: '#07141c',
    sun: { color: '#6fd8ff', intensity: 0.6, elev: 60, azim: 20 }, hemi: { sky: '#1a6a8a', ground: '#020408', intensity: 0.6 },
    night: true, floors: [3, 14], styles: ['glass', 'panel'], walls: ['#0f1820', '#14222c', '#0c121a'],
    roofs: ['#0a0f14'], gableChance: 0, parkChance: 0.06, landmarkChance: 0.16, windowLit: 0.6, neon: ['#19e3ff', '#2fff9a', '#ffb52f'], circuit: true, exposure: 1.1,
  },
};

/** Where the world inside an object of a given role tends to lead. */
export const ROLE_BIOMES: Record<string, string[]> = {
  electronics: ['circuit', 'neon'],
  toy: ['toyland'],
  sports: ['toyland', 'town'],
  food: ['candy'],
  tableware: ['candy', 'town'],
  appliance: ['metropolis', 'circuit'],
  container: ['desert', 'town'],
  instrument: ['neon', 'town'],
  craft: ['metropolis', 'desert'],
  gear: ['snow', 'town'],
  tool: ['metropolis', 'desert'],
  machine: ['metropolis', 'circuit'],
  storage: ['town', 'snow'],
  stationery: ['snow', 'town'],
  plant: ['town', 'toyland'],
  lamp: ['neon'],
  painting: ['town', 'metropolis', 'snow', 'desert', 'candy', 'neon', 'toyland'],
};
