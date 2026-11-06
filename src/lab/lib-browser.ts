import * as THREE from 'three';
import type { LabScene } from '../lab';
import { LIBRARY_SOURCES, loadCatalog, loadLibraryModel, searchLibrary, type LibraryEntry, type LibrarySource } from '../libraries';

/**
 * ?lab=lib-browser — models from each third-party library at real scale, one row per source, labelled.
 *   &source=gso&category=shoe&q=mug&n=24&seed=3   one source as a wrapped grid instead
 *   &id=<entry id> with &source=                   one model
 * Small things stand on 0.9 m plinths so they read next to furniture.
 */

const SHOWCASE: Record<LibrarySource, string[]> = {
  polyhaven: ['ArmChair_01', 'CashRegister_01', 'fire_hydrant', 'Television_01', 'potted_plant_01', 'korean_public_payphone_01', 'marble_bust_01', 'Barrel_01', 'concrete_road_barrier', 'brass_vase_01'],
  gso: [],
  smithsonian: [],
  khronos: ['SheenChair', 'GlamVelvetSofa', 'CommercialRefrigerator', 'AntiqueCamera', 'Lantern', 'WaterBottle', 'BoomBox', 'IridescenceLamp', 'ABeautifulGame'],
};
const GSO_CATS = ['shoe', 'kitchen', 'toy', 'electronics', 'food and drink', 'bottles and cups', 'bag', 'household', 'board game', 'health and beauty'];
const SI_CATS = ['air-space', 'american-history', 'design', 'art', 'portraits', 'african-american', 'asian-art', 'fossil', 'shell', 'coral'];

async function showcase(src: LibrarySource, n: number): Promise<LibraryEntry[]> {
  if (src === 'gso') {
    const all = await loadCatalog('gso');
    return GSO_CATS.map((c, i) => all.filter((e) => e.category === c)[(i * 7) % 5]).filter(Boolean).slice(0, n);
  }
  if (src === 'smithsonian') {
    const out: LibraryEntry[] = [];
    for (const c of SI_CATS) {
      const hits = await searchLibrary({ source: 'smithsonian', category: c, maxSize: 3, minSize: 0.05, seed: 7 });
      const one = hits.find((e) => (e.kb ?? 0) < 12000 && !(e.parts && e.parts.length > 4));
      if (one) out.push(one);
    }
    return out.slice(0, n);
  }
  const all = await loadCatalog(src);
  return SHOWCASE[src].map((id) => all.find((e) => e.id === id)).filter((e): e is LibraryEntry => !!e).slice(0, n);
}

function label(text: string[], width = 1.2): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64 * text.length;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(20,20,24,0.85)';
  g.fillRect(0, 0, c.width, c.height);
  text.forEach((t, i) => {
    g.fillStyle = i === 0 ? '#ffffff' : '#c8c8c8';
    g.font = `${i === 0 ? 'bold 30' : '24'}px sans-serif`;
    g.fillText(t.length > 34 ? t.slice(0, 33) + '…' : t, 12, 42 + i * 64);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(width, (width * c.height) / c.width), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  m.rotation.x = -Math.PI / 2.6;
  return m;
}

const plinthMat = new THREE.MeshStandardMaterial({ color: '#e9e6e0', roughness: 0.7 });

async function row(group: THREE.Group, entries: LibraryEntry[], z: number, title: string, wrap = 0) {
  const hdr = label([title], 2.4);
  hdr.position.set(-2.2, 0.02, z + 0.4);
  group.add(hdr);
  let x = 0;
  let zz = z;
  let col = 0;
  const results = await Promise.allSettled(entries.map((e) => loadLibraryModel(e)));
  results.forEach((r, i) => {
    const e = entries[i];
    if (r.status !== 'fulfilled') {
      console.warn('library load failed', e.source, e.id, r.reason);
      return;
    }
    const obj = r.value;
    const size = obj.userData.size as THREE.Vector3;
    const w = Math.max(size.x, 0.5);
    const small = Math.max(size.x, size.y, size.z) < 0.45;
    const cell = new THREE.Group();
    let base = 0;
    if (small) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(Math.max(size.x + 0.1, 0.35), 0.9, Math.max(size.z + 0.1, 0.35)), plinthMat);
      p.position.y = 0.45;
      p.castShadow = p.receiveShadow = true;
      cell.add(p);
      base = 0.9;
    }
    obj.position.y = base;
    cell.add(obj);
    const dims = `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m`;
    const l = label([e.title, `${e.category} · ${e.licence}`, dims], 0.9);
    l.position.set(0, 0.02, Math.max(size.z, 0.35) / 2 + 0.45);
    cell.add(l);
    cell.position.set(x + w / 2, 0, zz);
    group.add(cell);
    x += w + 0.6;
    col++;
    if (wrap && col >= wrap) {
      col = 0;
      x = 0;
      zz += 3.2;
    }
  });
}

const scene: LabScene = {
  name: 'lib-browser',
  description: 'third-party model libraries at real scale: &source=&category=&q=&n=&id=',
  cam: [9, 7.5, 13],
  look: [9, 0.5, 2.5],
  env: 'studio',
  async build({ group, params }) {
    const src = params.get('source') as LibrarySource | null;
    const n = Number(params.get('n') ?? 10);
    if (src && params.get('id')) {
      const e = (await loadCatalog(src)).find((x) => x.id === params.get('id'));
      if (e) await row(group, [e], 0, `${src}: ${e.title}`);
    } else if (src) {
      const hits = await searchLibrary({
        source: src,
        category: params.get('category') ?? undefined,
        text: params.get('q') ?? undefined,
        maxSize: Number(params.get('max') ?? 4),
        seed: params.has('seed') ? Number(params.get('seed')) : undefined,
        limit: n,
      });
      await row(group, hits, 0, `${src} ${params.get('category') ?? ''} ${params.get('q') ?? ''}`, Number(params.get('wrap') ?? 8));
    } else {
      const names: Record<LibrarySource, string> = { polyhaven: 'Poly Haven · CC0', gso: 'Google Scanned Objects · CC BY', smithsonian: 'Smithsonian 3D · CC0', khronos: 'Khronos samples · CC0/CC BY' };
      const sources = LIBRARY_SOURCES;
      await Promise.all(sources.map(async (s, i) => row(group, await showcase(s, n), i * 3.4 - 2, names[s])));
    }
    const box = new THREE.Box3().setFromObject(group);
    group.userData.bounds = box;
  },
};
export default scene;
