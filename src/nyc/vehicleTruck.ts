import * as THREE from 'three';
import { canvasTex } from './common';
import type { Rng } from '../rng';

/**
 * A 16 ft cab-over box truck (Isuzu NPR / Hino class), the typical Manhattan delivery truck: 7.0 m x 2.4 m x 3.45 m,
 * white tilt cab with a raked windshield, black grille, west-coast mirrors on arms, frame rails, front single and
 * rear dual wheels, aluminium-ribbed box with a roll-up rear door and a fleet sign. Wheels are separate so traffic
 * can spin them. Nose toward -z.
 */
export const TRUCK = { len: 7.0, wid: 2.4, r: 0.43, front: -2.6, rear: 1.5 };
const FLEETS = [
  ['BROADWAY FRESH PRODUCE', '#1d6b34'],
  ['HUDSON LINEN SUPPLY', '#1f3f8a'],
  ['EMPIRE BEVERAGE CO.', '#a3171b'],
  ['KNICKERBOCKER MOVERS', '#c26a00'],
  ['', '#000'],
] as const;

let shared: ReturnType<typeof build> | null = null;

function cabProfile() {
  // side profile of the tilt cab (u along length, v up); front at u=-3.5
  const s = new THREE.Shape();
  s.moveTo(-3.5, 0.55);
  s.lineTo(-1.62, 0.55);
  s.lineTo(-1.62, 2.5);
  s.lineTo(-3.18, 2.5);
  s.quadraticCurveTo(-3.33, 2.5, -3.36, 2.38);
  s.lineTo(-3.5, 1.45);
  s.lineTo(-3.52, 0.62);
  s.closePath();
  return s;
}

function boxTex(name: string, color: string) {
  return canvasTex(1024, 512, (g) => {
    g.fillStyle = '#f2f3f1';
    g.fillRect(0, 0, 1024, 512);
    // vertical posts of the aluminium box
    g.fillStyle = 'rgba(0,0,0,0.07)';
    for (let x = 0; x < 1024; x += 64) g.fillRect(x, 0, 6, 512);
    g.fillStyle = '#c9ccd0';
    g.fillRect(0, 0, 1024, 18);
    g.fillRect(0, 494, 1024, 18);
    if (name) {
      g.fillStyle = color;
      g.fillRect(0, 300, 1024, 46);
      g.font = 'bold 64px Arial';
      g.textAlign = 'center';
      g.fillText(name, 512, 250, 960);
    }
  });
}
function doorTex() {
  return canvasTex(256, 256, (g) => {
    g.fillStyle = '#e6e8ea';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 8; y < 256; y += 18) g.fillRect(0, y, 256, 3);
    g.fillStyle = '#555';
    g.fillRect(110, 236, 36, 10);
  });
}

function build() {
  const cab = new THREE.ExtrudeGeometry(cabProfile(), { depth: 2.1, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 3, curveSegments: 6 });
  cab.translate(0, 0, -1.05);
  cab.rotateY(-Math.PI / 2);
  const tyrePts: THREE.Vector2[] = [];
  const R = TRUCK.r, w = 0.24;
  tyrePts.push(new THREE.Vector2(0.24, -w / 2 + 0.01));
  for (let i = 0; i <= 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * Math.PI;
    tyrePts.push(new THREE.Vector2(R - 0.06 + Math.cos(a) * 0.06, (Math.sin(a) * w) / 2));
  }
  tyrePts.push(new THREE.Vector2(0.24, w / 2 - 0.01));
  const tyre = new THREE.LatheGeometry(tyrePts, 24);
  tyre.rotateZ(Math.PI / 2);
  const rim = new THREE.LatheGeometry([new THREE.Vector2(0.001, 0.02), new THREE.Vector2(0.08, 0.03), new THREE.Vector2(0.11, 0), new THREE.Vector2(0.22, -0.04), new THREE.Vector2(0.25, -0.1)], 20);
  rim.rotateZ(-Math.PI / 2);
  const mats = {
    cab: new THREE.MeshPhysicalMaterial({ color: '#f4f4f2', roughness: 0.35, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.08 }),
    glass: new THREE.MeshPhysicalMaterial({ color: '#0b1014', roughness: 0.04, metalness: 0.2, clearcoat: 1, envMapIntensity: 1.5 }),
    black: new THREE.MeshStandardMaterial({ color: '#141618', roughness: 0.65 }),
    rubber: new THREE.MeshStandardMaterial({ color: '#151515', roughness: 0.92 }),
    steel: new THREE.MeshStandardMaterial({ color: '#8c9095', roughness: 0.35, metalness: 0.9 }),
    rim: new THREE.MeshStandardMaterial({ color: '#d5d8db', roughness: 0.3, metalness: 1 }),
    head: new THREE.MeshStandardMaterial({ color: '#fff', emissive: '#fff3d6', emissiveIntensity: 1.0, roughness: 0.1 }),
    tail: new THREE.MeshStandardMaterial({ color: '#7a0b0b', emissive: '#ff2216', emissiveIntensity: 0.8 }),
    amber: new THREE.MeshStandardMaterial({ color: '#7a4a00', emissive: '#ffa21a', emissiveIntensity: 0.5 }),
    door: new THREE.MeshStandardMaterial({ map: doorTex(), roughness: 0.45, metalness: 0.3 }),
  };
  return { cab, tyre, rim, mats, boxes: new Map<string, THREE.Material>() };
}

function box(g: THREE.Object3D, m: THREE.Material | THREE.Material[], w: number, h: number, d: number, x: number, y: number, z: number, shadow = false) {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z);
  o.castShadow = shadow;
  g.add(o);
  return o;
}

export function truckMesh(rng: Rng): THREE.Group {
  const S = (shared ??= build());
  const { mats } = S;
  const g = new THREE.Group();
  const cab = new THREE.Mesh(S.cab, mats.cab);
  cab.castShadow = true;
  g.add(cab);
  const W = TRUCK.wid / 2;
  // windshield (raked) and door windows
  const ws = new THREE.Mesh(new THREE.PlaneGeometry(1.95, 0.95), mats.glass);
  ws.position.set(0, 1.93, -3.535);
  ws.rotation.set(0.15, Math.PI, 0);
  g.add(ws);
  for (const s of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.75), mats.glass);
    win.position.set(s * (1.05 + 0.095), 1.98, -2.55);
    win.rotation.y = (s * Math.PI) / 2;
    g.add(win);
    // door seam and handle
    box(g, mats.black, 0.01, 1.5, 0.02, s * 1.14, 1.4, -1.75);
    box(g, mats.black, 0.02, 0.04, 0.18, s * 1.15, 1.45, -2.0);
    // west-coast mirror on two arms
    box(g, mats.black, 0.4, 0.03, 0.03, s * 1.3, 2.15, -3.0);
    box(g, mats.black, 0.4, 0.03, 0.03, s * 1.3, 1.65, -3.0);
    box(g, mats.black, 0.08, 0.55, 0.2, s * 1.5, 1.9, -3.0, true);
    // headlights, indicators
    box(g, mats.head, 0.36, 0.2, 0.04, s * 0.72, 1.0, -3.6);
    box(g, mats.amber, 0.16, 0.12, 0.04, s * 0.98, 1.0, -3.6);
    // step
    box(g, mats.black, 0.22, 0.06, 0.6, s * 1.13, 0.5, -2.3);
    // tail lights, fuel tank (one side)
    box(g, mats.tail, 0.12, 0.3, 0.04, s * 1.0, 0.72, 3.53);
  }
  box(g, mats.black, 1.5, 0.42, 0.04, 0, 1.0, -3.58); // grille
  for (let k = 0; k < 4; k++) box(g, mats.steel, 1.4, 0.03, 0.02, 0, 0.86 + k * 0.1, -3.61);
  box(g, mats.black, 2.25, 0.26, 0.2, 0, 0.55, -3.55, true); // bumper
  box(g, mats.steel, 0.45, 0.4, 0.6, -0.95, 0.75, -0.5); // fuel tank
  // frame rails and rear ICC bumper
  for (const s of [-1, 1]) box(g, mats.black, 0.1, 0.25, 6.6, s * 0.45, 0.7, -0.1, true);
  box(g, mats.steel, 2.2, 0.12, 0.12, 0, 0.55, 3.45);
  // box body: sides carry the fleet sign; front/top plain; rear is the roll-up door
  const [name, col] = rng.pick(FLEETS);
  let side = S.boxes.get(name);
  if (!side) {
    side = new THREE.MeshStandardMaterial({ map: boxTex(name, col), roughness: 0.5, metalness: 0.1 });
    S.boxes.set(name, side);
  }
  const plain = new THREE.MeshStandardMaterial({ color: '#eef0ee', roughness: 0.5, metalness: 0.1 });
  const bx = box(g, [side, side, plain, plain, mats.door, plain], 2.42, 2.4, 5.0, 0, 0.92 + 1.2, 1.0, true);
  bx.castShadow = true;
  box(g, mats.steel, 2.44, 0.06, 5.02, 0, 0.92, 1.0); // aluminium base rail
  box(g, mats.steel, 2.44, 0.06, 5.02, 0, 3.32, 1.0); // top rail
  // wheels: front single, rear dual
  const wheels: THREE.Object3D[] = [];
  for (const z of [TRUCK.front, TRUCK.rear])
    for (const s of [-1, 1]) {
      const wg = new THREE.Group();
      wg.position.set(s * (W - 0.22), TRUCK.r, z);
      const t = new THREE.Mesh(S.tyre, mats.rubber);
      t.castShadow = true;
      wg.add(t);
      if (z > 0) {
        const t2 = new THREE.Mesh(S.tyre, mats.rubber);
        t2.position.x = -s * 0.26;
        wg.add(t2);
      }
      const r = new THREE.Mesh(S.rim, mats.rim);
      r.scale.x = s;
      r.position.x = s * 0.08;
      wg.add(r);
      g.add(wg);
      wheels.push(wg);
    }
  // black wheel-well shadows under the box and cab
  box(g, mats.black, 2.3, 0.35, 1.2, 0, 0.75, TRUCK.rear);
  g.userData.wheels = wheels;
  g.userData.wheelR = TRUCK.r;
  g.userData.len = TRUCK.len;
  g.userData.wid = TRUCK.wid;
  g.traverse((o) => (o.userData.owned = false));
  return g;
}
