import * as THREE from 'three';
import type { Env, Level, LevelDesc, Portal, Rect } from './level';
import { rect } from './level';
import { box, mat, plane, glow } from './build';
import { tileFloorTex, woodFloorTex, signTex } from './textures';
import { Rng, hashN } from './rng';
import { loadPools } from './museumData';
import { loadRemote, clearQueue, disposeModel, DATASET_LABEL, type RemoteEntry, type RemoteModel } from './remote';
import { SHOPS } from './nyc';
import { loadOriginal, trackForDetail } from './detail';

const H = 3.6;
const SHOWROOM = new Set(['furniture', 'lighting', 'music', 'models', 'garden']);

interface Facing {
  entry: RemoteEntry;
  /** slot centres (bottom centre of the cell) */
  slots: THREE.Vector3[];
  /** cell size the product must fit */
  cell: THREE.Vector3;
  rotY: number;
}

export class ShopLevel implements Level {
  name: string;
  group = new THREE.Group();
  spawn = { pos: new THREE.Vector3(), yaw: 0 };
  env: Env = {
    skyTop: '#1a1a1a', skyBottom: '#222', stars: false, fog: null, fogNear: 0, fogFar: 0, sun: null,
    hemi: { sky: '#f4f8ff', ground: '#6a6458', intensity: 0.5 }, ambient: 0.06, envIntensity: 0.5, exposure: 0.82,
  };
  private cols: Rect[] = [];
  private ports: Portal[] = [];
  private alive = true;
  private models: RemoteModel[] = [];

  constructor(desc: Extract<LevelDesc, { kind: 'interior' }>) {
    this.name = desc.name;
    const r = new Rng(hashN(desc.seed, 31));
    const type = desc.shop ?? 'deli';
    const show = SHOWROOM.has(type);
    const W = r.range(10, 14), D = r.range(14, 20);
    const g = this.group;

    // shell
    const floorMat = show ? mat('#ffffff', { map: woodFloorTex(r.pick(['#a8754a', '#c8955f', '#6e4a32'])), rough: 0.5 }) : mat('#ffffff', { map: tileFloorTex(r.pick(['#e9e6df', '#efe3c9', '#dfe6ea']), r.pick(['#b9b2a2', '#2f3a44', '#9a3a2a', '#c9c3b8'])), rough: 0.3 });
    const fl = plane(floorMat, W, D);
    fl.geometry = new THREE.PlaneGeometry(W, D);
    fl.scale.set(1, 1, 1);
    const uv = fl.geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * W) / 2, (uv.getY(i) * D) / 2);
    fl.userData.owned = true;
    g.add(fl);
    const ceil = plane(mat('#eceae4', { rough: 1 }), W, D, 0, H, 0);
    ceil.rotation.x = Math.PI / 2;
    g.add(ceil);
    const wallM = mat(r.pick(['#ece6da', '#e2e8e4', '#efe9df', '#d9d4ca', '#f2efe8']), { rough: 0.95 });
    const T = 0.2;
    g.add(box(wallM, W, H, T, 0, 0, -D / 2, false));
    g.add(box(wallM, T, H, D, -W / 2, 0, 0, false));
    g.add(box(wallM, T, H, D, W / 2, 0, 0, false));
    this.cols.push(rect(0, -D / 2, W, 0.4), rect(-W / 2, 0, 0.4, D), rect(W / 2, 0, 0.4, D));
    // shop front: windows onto the street, door in the middle
    const doorX = 0;
    const pane = mat('#dfeaf2', { emissive: '#e8f0f6', ei: 0.9, rough: 0.1 });
    for (const [a, b] of [[-W / 2, doorX - 0.8], [doorX + 0.8, W / 2]]) {
      g.add(box(mat('#2a2a2a', { metal: 0.4, rough: 0.5 }), b - a, 0.6, T, (a + b) / 2, 0, D / 2, false));
      g.add(box(pane, b - a, 2.4, 0.05, (a + b) / 2, 0.6, D / 2, false));
      g.add(box(wallM, b - a, H - 3.0, T, (a + b) / 2, 3.0, D / 2, false));
      this.cols.push(rect((a + b) / 2, D / 2, b - a, 0.4));
    }
    g.add(box(wallM, 1.6, H - 2.6, T, doorX, 2.6, D / 2, false));
    g.add(box(mat('#3a3f44', { rough: 0.3, metal: 0.5 }), 1.5, 2.55, 0.06, doorX, 0, D / 2 + 0.08, false));
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.26), new THREE.MeshBasicMaterial({ map: signTex('EXIT', '#0c5a2a', '#e8ffe8') }));
    sign.userData.owned = true;
    sign.position.set(doorX, 2.85, D / 2 - 0.12);
    sign.rotation.y = Math.PI;
    g.add(sign);
    this.ports.push({ box: new THREE.Box3(new THREE.Vector3(doorX - 0.8, 0, D / 2 - 0.7), new THREE.Vector3(doorX + 0.8, 2.6, D / 2 + 0.3)), label: 'Back to the street', target: 'back' });
    this.spawn.pos.set(doorX, 0, D / 2 - 1.2);
    // lights: fluorescent strips
    for (let x = -W / 2 + 2; x <= W / 2 - 2; x += 3) {
      for (let z = -D / 2 + 2.5; z < D / 2 - 1; z += 4.5) g.add(box(mat('#ffffff', { emissive: '#f4f8ff', ei: 1.4 }), 0.3, 0.06, 2.2, x, H - 0.08, z, false));
    }
    for (const z of [-D / 4, D / 4]) {
      const l = new THREE.PointLight('#f2f6ff', 6 + W * D * 0.035, Math.max(W, D) * 1.2, 1.4);
      l.position.set(0, H - 0.4, z);
      g.add(l);
    }
    // counter with a register
    const cx = W / 2 - 1.6, cz = D / 2 - 3.2;
    const counterM = mat(r.pick(['#5a3a24', '#2f3a44', '#7a1d1d', '#d9d2c4']), { rough: 0.5 });
    g.add(box(counterM, 1.0, 1.0, 3.0, cx, 0, cz));
    g.add(box(mat('#d8d2c4', { rough: 0.3 }), 1.1, 0.05, 3.1, cx, 1.0, cz));
    g.add(box(mat('#1a1a1a', { rough: 0.4 }), 0.45, 0.25, 0.4, cx, 1.05, cz - 0.6));
    g.add(box(mat('#3a3f44', { emissive: '#3aff8a', ei: 0.4 }), 0.35, 0.18, 0.04, cx - 0.05, 1.32, cz - 0.6, false));
    this.cols.push(rect(cx, cz, 1.1, 3.1));
    const shopInfo = SHOPS.find((s) => s.type === type);
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.6), new THREE.MeshBasicMaterial({ map: signTex(desc.name.toUpperCase(), shopInfo?.colors[0] ?? '#222', '#ffffff') }));
    banner.userData.owned = true;
    banner.position.set(0, H - 0.7, -D / 2 + 0.12);
    g.add(banner);

    // fixtures and the facings they hold
    const facings: { cell: THREE.Vector3; slots: THREE.Vector3[]; rotY: number }[] = [];
    const shelfM = mat(r.pick(['#e8e8e4', '#d9d4ca', '#5a5f66', '#8a6a4a']), { rough: 0.6, metal: 0.2 });
    const levels = [0.12, 0.6, 1.08, 1.56];
    const cell = new THREE.Vector3(0.4, 0.4, 0.36);
    const shelfRun = (x0: number, z0: number, x1: number, z1: number, rotY: number, depth: number, single: boolean) => {
      // a run of shelves from (x0,z0) to (x1,z1), facing rotY
      const len = Math.hypot(x1 - x0, z1 - z0);
      const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      const w = alongX ? len : depth, d = alongX ? depth : len;
      g.add(box(shelfM, w, 0.1, d, mx, 0, mz));
      g.add(box(mat('#3a3a3a'), alongX ? len : 0.04, 1.95, alongX ? 0.04 : len, mx, 0, mz, false));
      for (const y of levels) g.add(box(shelfM, w, 0.03, d, mx, y - 0.03, mz, false));
      g.add(box(shelfM, w, 0.04, d, mx, 1.95, mz, false));
      this.cols.push(rect(mx, mz, w + 0.05, d + 0.05));
      const faces = single ? [rotY] : [rotY, rotY + Math.PI];
      for (const fr of faces) {
        const nx = Math.sin(fr), nz = Math.cos(fr);
        const n = Math.floor(len / (cell.x + 0.05));
        for (const y of levels) {
          // runs of 2-4 identical products
          let k = 0;
          while (k < n) {
            const run = Math.min(n - k, r.int(2, 4));
            const slots: THREE.Vector3[] = [];
            for (let j = 0; j < run; j++) {
              const t = -len / 2 + ((k + j + 0.5) * len) / n;
              const off = single ? 0 : depth / 4;
              slots.push(alongX ? new THREE.Vector3(mx + t, y, mz + Math.round(nz) * off) : new THREE.Vector3(mx + Math.round(nx) * off, y, mz + t));
            }
            facings.push({ cell: cell.clone(), slots, rotY: fr });
            k += run;
          }
        }
      }
    };

    const pedestals: { at: THREE.Vector3; size: number }[] = [];
    if (show) {
      // showroom: low platforms with one product each, at (roughly) real size
      const pm = mat(r.pick(['#f2efe8', '#2b2b2e', '#d8cbb3']), { rough: 0.4 });
      for (let x = -W / 2 + 2; x <= W / 2 - 2.5; x += 2.6)
        for (let z = -D / 2 + 2; z <= D / 2 - 5; z += 2.8) {
          g.add(box(pm, 1.6, 0.25, 1.6, x, 0, z));
          this.cols.push(rect(x, z, 1.6, 1.6));
          pedestals.push({ at: new THREE.Vector3(x, 0.25, z), size: 1.5 });
        }
      shelfRun(-W / 2 + 0.35, -D / 2 + 1, -W / 2 + 0.35, D / 2 - 3, Math.PI / 2, 0.5, true);
    } else {
      const aisles = Math.max(1, Math.floor((W - 4) / 2.6));
      for (let i = 0; i < aisles; i++) {
        const x = -W / 2 + 2.4 + i * 2.6;
        if (x > W / 2 - 3.2) break;
        shelfRun(x, -D / 2 + 2.2, x, D / 2 - 5, Math.PI / 2, 0.9, false);
      }
      shelfRun(-W / 2 + 1.5, -D / 2 + 0.35, W / 2 - 1.5, -D / 2 + 0.35, 0, 0.5, true);
    }

    // stock it from the sand3d pools for this kind of shop
    loadPools().then((pools) => {
      if (!this.alive) return;
      const info = SHOPS.find((s) => s.type === type) ?? SHOPS[0];
      const stock: RemoteEntry[] = [];
      for (const key of info.pools) stock.push(...(pools[key] ?? []));
      if (!stock.length) return;
      const pr = new Rng(hashN(desc.seed, 5));
      pr.shuffle(stock);
      const products = stock.slice(0, show ? Math.min(stock.length, pedestals.length + 8) : 26);
      // showroom pieces
      pedestals.forEach((p, i) => {
        const e = products[i % products.length];
        this.showpiece(e, p.at, p.size, i);
      });
      const shelfProducts = show ? products.slice(pedestals.length) : products;
      if (!shelfProducts.length) return;
      const byProduct = new Map<RemoteEntry, Facing[]>();
      facings.forEach((f, i) => {
        const e = shelfProducts[(i * 7 + pr.int(0, 3)) % shelfProducts.length];
        if (!byProduct.has(e)) byProduct.set(e, []);
        byProduct.get(e)!.push({ entry: e, ...f });
      });
      let prio = 0;
      for (const [e, fs] of byProduct) this.stockShelf(e, fs, prio++);
    });
    void glow;
  }

  private portalFor(e: RemoteEntry, b: THREE.Box3) {
    this.ports.push({
      box: b,
      label: e.title,
      sub: `${DATASET_LABEL[e.ds] ?? e.ds}${e.author ? ` · by ${e.author}` : ''} — E for details & its program`,
      target: 'inspect',
      inspect: e,
    });
  }

  private showpiece(e: RemoteEntry, at: THREE.Vector3, size: number, prio: number) {
    loadRemote(e, { prio }).then((m) => {
      if (!this.alive) return disposeModel(m.object);
      const s = Math.min(size / Math.max(1e-3, Math.hypot(m.size.x, m.size.z)), 1.9 / Math.max(1e-3, m.size.y));
      const holder = new THREE.Group();
      holder.position.copy(at);
      holder.scale.setScalar(s);
      holder.rotation.y = Math.random() * Math.PI * 2;
      holder.add(m.object);
      trackForDetail(holder, m.object, e.id, e.og, m.size);
      this.group.add(holder);
      this.models.push(m);
      this.portalFor(e, new THREE.Box3(at.clone().add(new THREE.Vector3(-0.8, 0, -0.8)), at.clone().add(new THREE.Vector3(0.8, m.size.y * s + 0.1, 0.8))));
    }).catch(() => {});
  }

  /** One product, many facings: every mesh becomes an InstancedMesh. */
  private stockShelf(e: RemoteEntry, facings: Facing[], prio: number) {
    loadRemote(e, { prio, shadows: false }).then((m) => {
      if (!this.alive) return disposeModel(m.object);
      this.models.push(m);
      const cell = facings[0].cell;
      const s = Math.min(cell.x / Math.max(1e-4, m.size.x), (cell.y - 0.04) / Math.max(1e-4, m.size.y), cell.z / Math.max(1e-4, m.size.z));
      const slots: { p: THREE.Vector3; rot: number }[] = [];
      for (const f of facings) for (const p of f.slots) slots.push({ p, rot: f.rotY });
      const sand = this.instance(m.object, slots, s);
      // then the original textured model, if this product has one
      loadOriginal(e.id, e.og, m.size, { prio: 50 + prio, texMax: 512 }).then((orig) => {
        if (!orig || !this.alive) return;
        for (const im of sand) this.group.remove(im);
        this.instance(orig, slots, s);
      });
      for (const f of facings) {
        const b = new THREE.Box3();
        for (const p of f.slots) b.expandByPoint(p).expandByPoint(p.clone().add(new THREE.Vector3(0, m.size.y * s, 0)));
        b.expandByScalar(0.18);
        this.portalFor(e, b);
      }
    }).catch(() => {});
  }

  /** every mesh under root becomes one InstancedMesh across all slots */
  private instance(root: THREE.Object3D, slots: { p: THREE.Vector3; rot: number }[], s: number) {
    root.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    root.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
    const tmp = new THREE.Matrix4();
    const place = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const sc = new THREE.Vector3(s, s, s);
    const out: THREE.InstancedMesh[] = [];
    for (const mesh of meshes) {
      const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, slots.length);
      slots.forEach((sl, i) => {
        place.compose(sl.p, q.setFromAxisAngle(up, sl.rot), sc);
        tmp.multiplyMatrices(place, mesh.matrixWorld);
        im.setMatrixAt(i, tmp);
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.receiveShadow = true;
      this.group.add(im);
      out.push(im);
    }
    return out;
  }

  colliders() {
    return this.cols;
  }
  portals() {
    return this.ports;
  }
  update() {}
  dispose() {
    this.alive = false;
    clearQueue();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.userData.owned) m.geometry.dispose();
    });
    for (const m of this.models) disposeModel(m.object);
  }
}
