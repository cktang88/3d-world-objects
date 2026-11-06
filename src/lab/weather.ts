import * as THREE from 'three';
import type { LabScene } from '../lab';
import { streetLightMarker, wetSurface } from '../lighting';
import { NycLevel } from '../nyc';

/**
 * ?lab=weather — a cheap street canyon for tuning src/weather.ts: road + kerbs + pavements,
 * brick and stone walk-ups with roofs, AC units and a fire escape, an awning and an arcade (must
 * stay dry), two parked "cars", a tree, and Midtown towers up to 330 m (to lose in low cloud).
 *   &weather=clear|partly|overcast|lightrain|rain|fog|snow   &tod=day|golden|dusk|night
 *   &nyc=1  the real NYC blocks instead (heavier)
 * Y cycles the weather.
 */
let level: NycLevel | null = null;
const focus = new THREE.Vector3(50.5, 0, 22);

function std(color: string, roughness: number, metalness = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

const scene: LabScene = {
  name: 'weather',
  description: 'street canyon for clouds, rain, snow, fog, wetness',
  cam: [3, 1.7, 16],
  look: [-1, 5, -10],
  env: 'nyc',
  ground: false,
  build({ group, params }) {
    if (params.get('nyc')) {
      level = new NycLevel({ kind: 'nyc', seed: Number(params.get('seed') ?? 20261105), name: 'lab' });
      group.add(level.group);
      for (let i = 0; i < 20; i++) level.update(0.016, focus, i * 0.016);
      group.userData.cam = new THREE.Vector3(50.5, 1.7, 24);
      group.userData.look = new THREE.Vector3(53, 9, -30);
      return;
    }
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
      const o = new THREE.Mesh(geo, m);
      o.position.set(x, y, z);
      o.castShadow = o.receiveShadow = true;
      group.add(o);
      return o;
    };
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => add(new THREE.BoxGeometry(w, h, d), m, x, y + h / 2, z);

    // street running along z: road 11 m wide, pavements 4.5 m at +15 cm
    const road = wetSurface(std('#3c3d40', 0.92));
    const g = new THREE.Mesh(new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2), road);
    g.receiveShadow = true;
    group.add(g);
    const pave = wetSurface(std('#9a968e', 0.85), 0.55);
    const brick = std('#8a4b3a', 0.88), brick2 = std('#9a5a44', 0.9), stone = std('#c8bca8', 0.8), tar = std('#2b2b2d', 0.95);
    const glass = std('#6e7f90', 0.06, 0.9), steel = std('#2a2a2a', 0.6, 0.6), metal = std('#b8bcc0', 0.45, 0.5);
    for (const sx of [-1, 1]) {
      box(4.5, 0.15, 200, pave, sx * 7.75, 0, 0);
      box(0.15, 0.15, 200, stone, sx * 5.55, 0, 0);
    }
    // walk-ups on both sides (fronts at x = ±10), flat tar roofs with parapets
    const fronts: [number, number, number, THREE.Material][] = [
      [-1, -30, 18, brick], [-1, -10, 22, brick2], [-1, 10, 16, stone], [-1, 30, 20, brick],
      [1, -30, 24, stone], [1, -10, 16, brick2], [1, 10, 20, brick], [1, 30, 18, brick2],
    ];
    for (const [sx, z, h, m] of fronts) {
      box(14, h, 19.6, m, sx * 17, 0, z);
      box(14, 0.05, 19.6, tar, sx * 17, h, z);
      box(0.3, 1, 19.6, m, sx * 10.15, h, z);
      // AC units in windows and on the roof
      for (let f = 1; f < h / 3.2 - 1; f++) box(0.7, 0.45, 0.55, metal, sx * 9.72, f * 3.2 + 0.2, z - 4 + (f % 3) * 3);
      box(2, 1.4, 1.6, metal, sx * 19, h, z + 4);
    }
    // fire escape on the left building: platforms and a ladder
    for (let f = 1; f < 5; f++) box(1.2, 0.06, 6, steel, -9.3, f * 3.2 + 0.8, -10);
    // an awning over the right pavement (pavement under it must stay dry) and an arcade on the left
    box(3, 0.08, 6, std('#2b5e3c', 0.7), 8.6, 3, 10);
    box(4.2, 0.4, 8, stone, -7.9, 4, 30);
    for (const z of [26.2, 33.8]) box(0.4, 4, 0.4, stone, -6, 0, z);
    // parked cars (boxes) and a tree
    const paint = std('#7c1d1d', 0.25, 0.6), paint2 = std('#e0c234', 0.3, 0.5);
    for (const [z, m] of [[-4, paint], [6, paint2]] as [number, THREE.Material][]) {
      box(1.85, 0.8, 4.6, m, -4.5, 0.3, z);
      box(1.6, 0.6, 2.4, m, -4.5, 1.1, z - 0.2);
    }
    add(new THREE.CylinderGeometry(0.15, 0.2, 3), std('#4a3a2c', 0.9), 7, 1.5, -2);
    add(new THREE.IcosahedronGeometry(2.2, 2), std('#3d5a2a', 0.85), 7, 5, -2);
    // Midtown behind: towers to 330 m
    const towers: [number, number, number, number, number, THREE.Material][] = [
      [-30, -110, 30, 260, 30, glass], [25, -150, 35, 330, 35, stone], [-70, -180, 30, 200, 30, brick], [60, -90, 25, 150, 25, glass], [0, -230, 40, 290, 40, glass],
    ];
    for (const [x, z, w, h, d, m] of towers) box(w, h, d, m, x, 0, z);
    // a few lamps for night rain
    for (const z of [-20, 0, 20]) group.add(streetLightMarker(5.2, 8.5, z));
    for (const z of [-20, 0, 20]) box(0.18, 8.5, 0.18, steel, 5.4, 0.15, z);
  },
  update(dt, time) {
    level?.update(dt, focus, time);
  },
};
export default scene;
