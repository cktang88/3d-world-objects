import * as THREE from 'three';
import { canvasTex } from './common';
import { Rng } from '../rng';

/** Canvas textures and shared materials for the open districts (lawns, paths, water, aprons). */

const cache = new Map<string, THREE.Material>();
function once<T extends THREE.Material>(key: string, make: () => T): T {
  let m = cache.get(key) as T | undefined;
  if (!m) cache.set(key, (m = make()));
  return m;
}

function noise(g: CanvasRenderingContext2D, W: number, H: number, amp: number, r: Rng) {
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r.next() - 0.5) * amp;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

/** mown lawn: mottled greens with blade strokes and the odd bare patch; tiles every 4 m */
export function grassMat() {
  return once('grass', () => {
    const r = new Rng(11);
    const t = canvasTex(512, 512, (g) => {
      g.fillStyle = '#4d6b2c';
      g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 260; i++) {
        g.fillStyle = `rgba(${r.int(50, 110)},${r.int(90, 130)},${r.int(30, 55)},0.25)`;
        g.beginPath();
        g.arc(r.range(0, 512), r.range(0, 512), r.range(8, 50), 0, Math.PI * 2);
        g.fill();
      }
      for (let i = 0; i < 9000; i++) {
        const x = r.range(0, 512), y = r.range(0, 512);
        g.strokeStyle = `rgba(${r.int(40, 140)},${r.int(80, 160)},${r.int(20, 60)},${r.range(0.3, 0.7)})`;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + r.range(-2, 2), y - r.range(3, 8));
        g.stroke();
      }
      for (let i = 0; i < 6; i++) {
        g.fillStyle = 'rgba(120,100,70,0.18)';
        g.beginPath();
        g.ellipse(r.range(0, 512), r.range(0, 512), r.range(10, 30), r.range(6, 16), r.range(0, 3), 0, Math.PI * 2);
        g.fill();
      }
      noise(g, 512, 512, 18, r);
    }, true);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 });
  });
}

/** park path asphalt: grey-brown hexagonal-paver-ish speckle */
export function pathMat() {
  return once('path', () => {
    const r = new Rng(12);
    const t = canvasTex(256, 256, (g) => {
      g.fillStyle = '#6d6a64';
      g.fillRect(0, 0, 256, 256);
      noise(g, 256, 256, 30, r);
      g.strokeStyle = 'rgba(40,38,34,0.25)';
      for (let i = 0; i < 8; i++) {
        g.beginPath();
        g.moveTo(r.range(0, 256), r.range(0, 256));
        g.lineTo(r.range(0, 256), r.range(0, 256));
        g.stroke();
      }
    }, true);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.92 });
  });
}

/** hexagonal asphalt pavers of Central Park's paths */
export function hexPaverMat() {
  return once('hex', () => {
    const r = new Rng(13);
    const t = canvasTex(256, 256, (g) => {
      g.fillStyle = '#5a5853';
      g.fillRect(0, 0, 256, 256);
      const s = 16;
      for (let row = -1; row < 256 / (s * 1.5) + 1; row++)
        for (let col = -1; col < 256 / (s * 1.732) + 1; col++) {
          const cx = col * s * 1.732 + (row % 2 ? s * 0.866 : 0), cy = row * s * 1.5;
          const v = r.int(78, 104);
          g.fillStyle = `rgb(${v},${v - 2},${v - 6})`;
          g.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = Math.PI / 6 + (k * Math.PI) / 3;
            g.lineTo(cx + Math.cos(a) * (s - 1.2), cy + Math.sin(a) * (s - 1.2));
          }
          g.fill();
        }
      noise(g, 256, 256, 14, r);
    }, true);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 });
  });
}

/** dark river water: low roughness, scrolling ripple normal map */
export const waterTex: THREE.Texture[] = [];
export function waterMat(color = '#22363b') {
  return once(`water${color}`, () => {
    const r = new Rng(14);
    const t = canvasTex(256, 256, (g) => {
      g.fillStyle = 'rgb(128,128,255)';
      g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 900; i++) {
        const x = r.range(0, 256), y = r.range(0, 256), w = r.range(6, 26);
        const dx = r.range(-40, 40);
        g.fillStyle = `rgba(${128 + dx},${128 + r.range(-40, 40)},255,0.35)`;
        g.beginPath();
        g.ellipse(x, y, w, w * 0.25, 0, 0, Math.PI * 2);
        g.fill();
      }
    }, true);
    t.colorSpace = THREE.NoColorSpace;
    waterTex.push(t);
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.12, metalness: 0.15, normalMap: t, normalScale: new THREE.Vector2(0.6, 0.6) });
    return m;
  });
}
export function tickWater(time: number) {
  for (const t of waterTex) t.offset.set(time * 0.004, time * 0.011);
}

/** airport apron concrete: large slab joints, tyre and oil stains */
export function apronMat() {
  return once('apron', () => {
    const r = new Rng(15);
    const t = canvasTex(512, 512, (g) => {
      g.fillStyle = '#a7a59e';
      g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 40; i++) {
        g.fillStyle = `rgba(${r.int(60, 110)},${r.int(60, 105)},${r.int(55, 100)},${r.range(0.05, 0.16)})`;
        g.beginPath();
        g.ellipse(r.range(0, 512), r.range(0, 512), r.range(10, 80), r.range(5, 30), r.range(0, 3), 0, Math.PI * 2);
        g.fill();
      }
      noise(g, 512, 512, 16, r);
      // slab joints every 128 px (= 5 m)
      g.strokeStyle = 'rgba(50,50,50,0.55)';
      g.lineWidth = 2;
      for (let k = 0; k <= 512; k += 128) {
        g.beginPath(); g.moveTo(k, 0); g.lineTo(k, 512); g.stroke();
        g.beginPath(); g.moveTo(0, k); g.lineTo(512, k); g.stroke();
      }
    }, true);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 });
  });
}

/** plain coloured materials used across districts */
export function flat(color: string, rough = 0.8, metal = 0) {
  return once(`flat${color}|${rough}|${metal}`, () => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
}

/** a horizontal plane mesh covering a local rect at height y, uv in metres / tile */
export function slab(m: THREE.Material, x0: number, x1: number, z0: number, z1: number, y: number, tile = 4) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / tile, -p.getZ(i) / tile);
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  mesh.userData.owned = true;
  return mesh;
}

/** a flat disc / ellipse */
export function ellipse(m: THREE.Material, x: number, z: number, rx: number, rz: number, y: number, tile = 4, seg = 40) {
  const g = new THREE.CircleGeometry(1, seg);
  g.rotateX(-Math.PI / 2);
  g.scale(rx, 1, rz);
  g.translate(x, y, z);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / tile, -p.getZ(i) / tile);
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  mesh.userData.owned = true;
  return mesh;
}
