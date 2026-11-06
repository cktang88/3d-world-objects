import * as THREE from 'three';
import { canvasTex } from './common';
import type { Rng } from '../rng';

/**
 * An MTA New York City Transit New Flyer Xcelsior XD40 in the current (2016+) blue livery, built procedurally:
 * 12.5 m x 2.59 m x 3.3 m, wheelbase 7.15 m, curb-side doors on the right (+x when the nose points -z),
 * black window band, white roof with HVAC/hybrid pods, amber LED destination signs, bike rack, bug-eye mirrors.
 * The body is the side profile (with wheel arches) extruded across the width with rounded edges; the
 * livery is a canvas texture mapped in metres onto both flanks. Wheels are separate so traffic can spin them.
 */
export const BUS = { len: 12.5, wid: 2.59, h: 3.05, r: 0.5, front: -3.9, rear: 3.25 };
const HL = 6.25; // half length of the body
const ROUTES = ['M15 SOUTH FERRY', 'M5 WASHINGTON HTS', 'M86 +SBS WEST SIDE', 'M23 +SBS CHELSEA PIERS', 'M14A ABINGDON SQ', 'M101 HARLEM 125 ST', 'M34 +SBS JAVITS CTR', 'M7 COLUMBUS AV'];

let shared: ReturnType<typeof build> | null = null;

function profile() {
  const s = new THREE.Shape();
  const y0 = 0.34, top = BUS.h, ar = 0.66, ay = 0.5;
  s.moveTo(-HL + 0.05, y0);
  // bottom edge, front to rear, with the two wheel arches
  const a0 = Math.asin((ay - y0) / ar);
  for (const c of [BUS.front, BUS.rear]) {
    s.lineTo(c - ar * Math.cos(a0), y0);
    s.absarc(c, ay, ar, Math.PI + a0, -a0, true);
  }
  s.lineTo(HL - 0.05, y0);
  // rear face, roof, raked front with rounded corners
  s.lineTo(HL, y0 + 0.15);
  s.lineTo(HL, top - 0.25);
  s.quadraticCurveTo(HL, top, HL - 0.25, top);
  s.lineTo(-HL + 0.4, top);
  s.quadraticCurveTo(-HL + 0.02, top, -HL - 0.02, top - 0.4);
  s.lineTo(-HL - 0.08, 1.1);
  s.lineTo(-HL - 0.05, y0 + 0.1);
  s.closePath();
  return s;
}

function livery() {
  // canvas covers u in [-6.4, 6.4] (front -> rear), v in [0, 3.2]; 160 px per metre
  const W = 2048, H = 512, ppm = 160;
  const t = canvasTex(W, H, (g) => {
    const X = (u: number) => (u + 6.4) * ppm, Y = (v: number) => H - v * ppm;
    // base blue
    g.fillStyle = '#1748a3';
    g.fillRect(0, 0, W, H);
    // lighter blue sweep rising from the front wheel to the rear roof
    const grad = g.createLinearGradient(X(-6), 0, X(6), 0);
    grad.addColorStop(0, '#2f7ee0');
    grad.addColorStop(1, '#3d93f0');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(X(-6.4), Y(0.9));
    g.bezierCurveTo(X(-2), Y(0.75), X(2), Y(1.05), X(6.4), Y(1.32));
    g.lineTo(X(6.4), Y(0.62));
    g.bezierCurveTo(X(2), Y(0.55), X(-2), Y(0.5), X(-6.4), Y(0.55));
    g.closePath();
    g.fill();
    // yellow accent swoosh near the front
    g.strokeStyle = '#f4c20d';
    g.lineWidth = 0.07 * ppm;
    g.beginPath();
    g.moveTo(X(-6.4), Y(1.02));
    g.bezierCurveTo(X(-4.5), Y(0.95), X(-2.5), Y(1.02), X(-0.5), Y(1.2));
    g.stroke();
    // dark skirt
    g.fillStyle = '#20252b';
    g.fillRect(0, Y(0.5), W, H);
    // white roof edge
    g.fillStyle = '#e9ecef';
    g.fillRect(0, 0, W, Y(2.86));
    // window band: dark glass with slim mullions; the driver's window is taller
    const wb = 1.36, wt = 2.7;
    g.fillStyle = '#0a0d11';
    g.fillRect(X(-6.3), Y(wt), X(6.05) - X(-6.3), Y(wb) - Y(wt));
    g.fillRect(X(-6.3), Y(wt), X(-4.55) - X(-6.3), Y(0.95) - Y(wt));
    g.fillStyle = '#1b2026';
    for (let u = -4.55; u < 6.05; u += 1.38) g.fillRect(X(u) - 0.05 * ppm, Y(wt), 0.1 * ppm, Y(wb) - Y(wt));
    // horizontal transom of the hopper windows
    g.fillRect(X(-4.55), Y(2.38) - 3, X(6.05) - X(-4.55), 6);
    // subtle reflection gradient in the glass
    const rg = g.createLinearGradient(0, Y(wt), 0, Y(wb));
    rg.addColorStop(0, 'rgba(255,255,255,0.10)');
    rg.addColorStop(0.5, 'rgba(255,255,255,0.0)');
    g.fillStyle = rg;
    g.fillRect(X(-6.3), Y(wt), X(6.05) - X(-6.3), Y(wb) - Y(wt));
    // panel seams
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 2;
    for (const u of [-3.0, -0.3, 2.3, 4.6]) {
      g.beginPath();
      g.moveTo(X(u), Y(1.3));
      g.lineTo(X(u), Y(0.5));
      g.stroke();
    }
    g.beginPath();
    g.moveTo(0, Y(1.3));
    g.lineTo(W, Y(1.3));
    g.stroke();
    // fleet number under the driver's window
    g.fillStyle = '#ffffff';
    g.font = `bold ${0.13 * ppm}px Arial`;
    g.fillText('7' + String(100 + ((Math.random() * 800) | 0)), X(-6.0), Y(0.72));
  });
  t.repeat.set(1 / 12.8, 1 / 3.2);
  t.offset.set(6.4 / 12.8, 0);
  t.anisotropy = 8;
  return t;
}

function ledSign(text: string, w: number, h: number) {
  return canvasTex(w, h, (g) => {
    g.fillStyle = '#050505';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffb21a';
    g.font = `bold ${h * 0.62}px "Arial Narrow", Arial`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 2, w * 0.94);
    // LED dot mask
    g.fillStyle = 'rgba(0,0,0,0.45)';
    for (let x = 0; x < w; x += 4) g.fillRect(x, 0, 1, h);
    for (let y = 0; y < h; y += 4) g.fillRect(0, y, w, 1);
  });
}

function build() {
  const body = new THREE.ExtrudeGeometry(profile(), { depth: BUS.wid - 0.16, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 3, curveSegments: 10 });
  body.translate(0, 0, -(BUS.wid - 0.16) / 2);
  body.rotateY(-Math.PI / 2);
  const paint = (map?: THREE.Texture, color = '#ffffff') =>
    new THREE.MeshPhysicalMaterial({ color, map: map ?? null, metalness: 0.15, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.08 });
  const mats = {
    side: paint(livery()),
    shell: paint(undefined, '#1748a3'),
    roof: paint(undefined, '#e6e9ec'),
    pod: new THREE.MeshStandardMaterial({ color: '#c9ccd0', roughness: 0.6, metalness: 0.1 }),
    glass: new THREE.MeshPhysicalMaterial({ color: '#080b0e', roughness: 0.03, metalness: 0.2, clearcoat: 1, envMapIntensity: 1.6 }),
    black: new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.7 }),
    rubber: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.92 }),
    steel: new THREE.MeshStandardMaterial({ color: '#2a2d31', roughness: 0.45, metalness: 0.7 }),
    rim: new THREE.MeshStandardMaterial({ color: '#c3c7cc', roughness: 0.28, metalness: 1 }),
    head: new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff3d6', emissiveIntensity: 1.2, roughness: 0.1 }),
    tail: new THREE.MeshStandardMaterial({ color: '#7a0b0b', emissive: '#ff2216', emissiveIntensity: 0.9, roughness: 0.2 }),
    amber: new THREE.MeshStandardMaterial({ color: '#7a4a00', emissive: '#ffa21a', emissiveIntensity: 0.6, roughness: 0.2 }),
  };
  // tyre: lathe profile with rounded sidewalls; rim: dished disc with hub and lug ring
  const tyrePts: THREE.Vector2[] = [];
  const R = BUS.r, w = 0.3;
  for (let i = 0; i <= 12; i++) {
    const a = -Math.PI / 2 + (i / 12) * Math.PI;
    tyrePts.push(new THREE.Vector2(R - 0.07 + Math.cos(a) * 0.07, (Math.sin(a) * w) / 2));
  }
  tyrePts.unshift(new THREE.Vector2(0.29, -w / 2 + 0.01));
  tyrePts.push(new THREE.Vector2(0.29, w / 2 - 0.01));
  const tyre = new THREE.LatheGeometry(tyrePts, 28);
  tyre.rotateZ(Math.PI / 2);
  const rimPts = [new THREE.Vector2(0.001, 0.02), new THREE.Vector2(0.09, 0.03), new THREE.Vector2(0.12, 0.0), new THREE.Vector2(0.2, -0.02), new THREE.Vector2(0.27, -0.06), new THREE.Vector2(0.3, -0.04), new THREE.Vector2(0.31, -0.12)];
  const rim = new THREE.LatheGeometry(rimPts, 24);
  rim.rotateZ(-Math.PI / 2);
  return { body, mats, tyre, rim };
}

function box(g: THREE.Object3D, m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, shadow = false) {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z);
  o.castShadow = shadow;
  g.add(o);
  return o;
}
function plane(g: THREE.Object3D, m: THREE.Material, w: number, h: number, x: number, y: number, z: number, ry: number) {
  const o = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
  o.position.set(x, y, z);
  o.rotation.y = ry;
  g.add(o);
  return o;
}

/** a new bus object (body geometry/materials shared); userData.wheels spin with speed */
export function busMesh(rng: Rng): THREE.Group {
  const S = (shared ??= build());
  const { mats } = S;
  const g = new THREE.Group();
  const body = new THREE.Mesh(S.body, [mats.side, mats.shell]);
  body.castShadow = true;
  g.add(body);
  const W = BUS.wid / 2, top = BUS.h;
  // roof cap, HVAC pod (rear) and hybrid battery pod (front)
  box(g, mats.roof, BUS.wid - 0.3, 0.05, BUS.len - 0.9, 0, top + 0.02, 0.1);
  const hvac = box(g, mats.pod, 2.1, 0.3, 2.3, 0, top + 0.17, 4.2, true);
  hvac.scale.set(1, 1, 1);
  box(g, mats.pod, 2.0, 0.24, 3.4, 0, top + 0.14, -1.6, true);
  box(g, mats.black, 1.6, 0.04, 1.2, 0, top + 0.33, 4.2); // condenser grille
  // windshield, destination sign, front lights, bumper, bike rack
  const fz = -HL - 0.09;
  plane(g, mats.glass, BUS.wid - 0.22, 1.62, 0, 1.92, fz - 0.02, Math.PI).rotation.x = -0.02;
  const route = rng.pick(ROUTES);
  const sign = new THREE.MeshStandardMaterial({ color: '#000', emissive: '#ffffff', emissiveMap: ledSign(route, 512, 64), emissiveIntensity: 1.1, map: null });
  plane(g, sign, BUS.wid - 0.5, 0.26, 0, 2.86, fz - 0.03, Math.PI);
  for (const s of [-1, 1]) {
    box(g, mats.head, 0.26, 0.14, 0.04, s * 0.92, 0.82, fz - 0.07);
    box(g, mats.head, 0.18, 0.12, 0.04, s * 0.62, 0.82, fz - 0.07);
    box(g, mats.amber, 0.14, 0.08, 0.04, s * 1.12, 0.98, fz - 0.06);
    // bug-eye mirrors on arms
    const arm = box(g, mats.black, 0.05, 0.05, 0.6, s * 1.18, 2.6, fz - 0.25);
    arm.rotation.y = s * 0.3;
    box(g, mats.black, 0.2, 0.42, 0.12, s * 1.32, 2.35, fz - 0.55, true);
    // rear lights
    box(g, mats.tail, 0.16, 0.5, 0.04, s * 1.05, 1.0, HL + 0.09);
    box(g, mats.amber, 0.16, 0.12, 0.04, s * 1.05, 0.66, HL + 0.09);
  }
  box(g, mats.black, BUS.wid + 0.02, 0.28, 0.16, 0, 0.5, fz + 0.02, true);
  box(g, mats.steel, 1.9, 0.05, 0.05, 0, 0.62, fz - 0.42);
  box(g, mats.steel, 1.9, 0.05, 0.05, 0, 0.98, fz - 0.42);
  for (const x of [-0.85, 0, 0.85]) box(g, mats.steel, 0.05, 0.42, 0.05, x, 0.8, fz - 0.42);
  for (const x of [-0.9, 0.9]) box(g, mats.steel, 0.05, 0.05, 0.4, x, 0.6, fz - 0.22);
  // rear: engine grille, bumper, rear route sign
  box(g, mats.black, BUS.wid - 0.5, 0.7, 0.03, 0, 1.0, HL + 0.09);
  for (let k = 0; k < 7; k++) box(g, mats.steel, BUS.wid - 0.6, 0.025, 0.04, 0, 0.72 + k * 0.09, HL + 0.1);
  box(g, mats.black, BUS.wid + 0.02, 0.3, 0.16, 0, 0.45, HL + 0.05, true);
  const num = route.split(' ')[0];
  plane(g, new THREE.MeshStandardMaterial({ color: '#000', emissive: '#fff', emissiveMap: ledSign(num, 128, 64) }), 0.5, 0.25, 0, 2.6, HL + 0.1, 0);
  // curb-side doors (+x): front door ahead of the front axle, rear door mid-ship; glass with black frames
  for (const [u, dw] of [[-5.3, 1.05], [0.95, 1.2]] as const) {
    box(g, mats.black, 0.03, 2.35, dw + 0.1, W + 0.07, 0.34 + 1.2, u);
    for (const k of [-1, 1]) plane(g, mats.glass, dw / 2 - 0.08, 2.0, W + 0.09, 0.4 + 1.05, u + (k * dw) / 4, Math.PI / 2);
    box(g, mats.steel, 0.02, 2.2, 0.03, W + 0.1, 1.5, u);
  }
  // side destination sign over the front door
  plane(g, sign, 1.5, 0.2, W + 0.09, 2.62, -3.6, Math.PI / 2);
  // wheel arch liners
  for (const z of [BUS.front, BUS.rear]) for (const s of [-1, 1]) box(g, mats.black, 0.4, 0.7, 1.32, s * (W - 0.25), 0.82, z);
  // wheels: front single, rear dual
  const wheels: THREE.Object3D[] = [];
  for (const z of [BUS.front, BUS.rear])
    for (const s of [-1, 1]) {
      const wg = new THREE.Group();
      wg.position.set(s * (W - 0.2), BUS.r, z);
      const t = new THREE.Mesh(S.tyre, mats.rubber);
      t.castShadow = true;
      wg.add(t);
      if (z === BUS.rear) {
        const t2 = new THREE.Mesh(S.tyre, mats.rubber);
        t2.position.x = -s * 0.32;
        wg.add(t2);
      }
      const r = new THREE.Mesh(S.rim, mats.rim);
      r.scale.x = s;
      r.position.x = s * 0.1;
      wg.add(r);
      g.add(wg);
      wheels.push(wg);
    }
  g.userData.wheels = wheels;
  g.userData.wheelR = BUS.r;
  g.userData.len = BUS.len;
  g.userData.wid = BUS.wid;
  g.traverse((o) => (o.userData.owned = false));
  return g;
}
