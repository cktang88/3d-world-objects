import * as THREE from 'three';
import type { Env, Level, LevelDesc, Portal, Rect } from './level';
import { rect } from './level';
import { box, cyl, mat, glow, plane } from './build';
import { museum, themeMembers, type Theme } from './museumData';
import { loadRemote, animate, disposeModel, clearQueue, DATASET_LABEL, type RemoteEntry, type RemoteModel } from './remote';
import { Rng, hashN } from './rng';
import { trackForDetail } from './detail';
import { surface } from './pbr';
import { realScale } from './realscale';

export const PAGE = 25; // 8 cases x 3 + 1 hero

const PALETTE = ['#7d2e2e', '#2e4d7d', '#2e6b55', '#6b4a2e', '#4d2e6b', '#7d6a2e', '#2e6b7d', '#5b5b5b', '#8a3d5c', '#3d5c2e'];

function collectionColor(c: string) {
  let h = 0;
  for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function titleCase(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------- text

function textPlane(lines: { text: string; size: number; color?: string; weight?: number; font?: string }[], w: number, h: number, bg: string | null, px = 256, align: CanvasTextAlign = 'center') {
  const c = document.createElement('canvas');
  c.width = Math.round(w * px);
  c.height = Math.round(h * px);
  const g = c.getContext('2d')!;
  if (bg) {
    g.fillStyle = bg;
    g.fillRect(0, 0, c.width, c.height);
  }
  const total = lines.reduce((s, l) => s + l.size * px * 1.25, 0);
  let y = (c.height - total) / 2;
  g.textAlign = align;
  g.textBaseline = 'top';
  const x = align === 'center' ? c.width / 2 : align === 'left' ? c.width * 0.06 : c.width * 0.94;
  for (const l of lines) {
    g.fillStyle = l.color ?? '#fff';
    g.font = `${l.weight ?? 600} ${Math.round(l.size * px)}px ${l.font ?? "Georgia, 'Times New Roman', serif"}`;
    let text = l.text;
    while (g.measureText(text).width > c.width * 0.9 && text.length > 4) text = text.slice(0, -2);
    if (text !== l.text) text = text.trimEnd() + '…';
    g.fillText(text, x, y);
    y += l.size * px * 1.25;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, transparent: !bg, toneMapped: false }));
  m.userData.owned = true;
  m.userData.tex = t;
  return m;
}

// ---------------------------------------------------------------- exhibits

interface Slot {
  entry: RemoteEntry;
  holder: THREE.Group; // turntable
  fit: THREE.Vector3; // max box the model may occupy
  at: THREE.Vector3;
  model?: RemoteModel;
  spin: number;
  placeholder: THREE.Mesh;
}

const phMat = new THREE.MeshBasicMaterial({ color: '#ffe9b0', wireframe: true, transparent: true, opacity: 0.35 });
const phGeo = new THREE.IcosahedronGeometry(0.18, 1);
const glassMat = new THREE.MeshStandardMaterial({ color: '#dff3ff', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.12, depthWrite: false, envMapIntensity: 1.5 });
const brass = mat('#b8975a', { metal: 0.85, rough: 0.3 });

abstract class MuseumBase implements Level {
  abstract name: string;
  group = new THREE.Group();
  spawn = { pos: new THREE.Vector3(), yaw: 0 };
  env: Env = {
    skyTop: '#16130f', skyBottom: '#211c16', stars: false, fog: null, fogNear: 0, fogFar: 0, sun: null,
    hemi: { sky: '#fff6e8', ground: '#4a4036', intensity: 0.85 }, ambient: 0.12, envIntensity: 0.55, exposure: 1.0,
  };
  protected cols: Rect[] = [];
  protected ports: Portal[] = [];
  protected slots: Slot[] = [];
  private alive = true;


  colliders() {
    return this.cols;
  }
  portals() {
    return this.ports;
  }

  update(dt: number, player: THREE.Vector3, time: number) {

    for (const s of this.slots) {
      if (!s.model) {
        s.placeholder.rotation.y += dt;
        s.placeholder.rotation.x += dt * 0.6;
        continue;
      }
      s.holder.rotation.y += dt * s.spin;
      const near = s.at.distanceToSquared(player) < 400;
      if (s.model.animator && near) animate(s.model.animator, time);
      const sc = s.holder.userData.fade as number | undefined;
      if (sc !== undefined && sc < 1) {
        const v = Math.min(1, sc + dt * 2.5);
        s.holder.userData.fade = v;
        const base = s.holder.userData.baseScale as number;
        s.holder.scale.setScalar(base * (0.6 + 0.4 * easeOut(v)));
      }
    }
  }

  dispose() {
    this.alive = false;
    clearQueue();
    this.group.traverse((o) => {
      o.userData.disposed = true;
      const m = o as THREE.Mesh;
      if (m.isMesh && m.userData.owned) {
        m.geometry.dispose();
        (m.material as THREE.MeshBasicMaterial).map?.dispose();
      }
    });
    for (const s of this.slots) if (s.model) disposeModel(s.model.object);
  }

  /** An exhibit slot: shows a placeholder, then the streamed object scaled to fit. */
  protected exhibit(entry: RemoteEntry, at: THREE.Vector3, fit: THREE.Vector3, prio: number, spin = 0.25) {
    const holder = new THREE.Group();
    holder.position.copy(at);
    const placeholder = new THREE.Mesh(phGeo, phMat);
    placeholder.position.y = Math.min(fit.y / 2, 0.4);
    holder.add(placeholder);
    this.group.add(holder);
    const slot: Slot = { entry, holder, fit, at: at.clone(), spin, placeholder };
    this.slots.push(slot);
    const bx = new THREE.Box3(new THREE.Vector3(at.x - fit.x / 2, at.y, at.z - fit.z / 2), new THREE.Vector3(at.x + fit.x / 2, at.y + fit.y, at.z + fit.z / 2));
    this.ports.push({
      box: bx,
      label: entry.title,
      sub: `${DATASET_LABEL[entry.ds] ?? entry.ds}${entry.author ? ` · by ${entry.author}` : ''}${entry.joints ? ` · ${entry.joints} joint${entry.joints > 1 ? 's' : ''}` : ''} — E for details & its program`,
      target: 'inspect',
      inspect: entry,
    });
    loadRemote(entry, { prio, shadows: false })
      .then((m) => {
        if (!this.alive) {
          disposeModel(m.object);
          return;
        }
        // realistic scale: show the object at its true size when it fits, otherwise scaled down
        const k = realScale(entry.title, entry.entry, entry.family, Math.max(m.size.x, m.size.y, m.size.z), entry.ds);
        const fitS = Math.min(fit.x / Math.max(1e-4, Math.hypot(m.size.x, m.size.z)), fit.y / Math.max(1e-4, m.size.y), 1e4);
        const s = Math.min(k, fitS);
        const real = m.size.clone().multiplyScalar(k);
        const shown = s / k;
        const dims = `${fmtLen(real.x)} × ${fmtLen(real.y)} × ${fmtLen(real.z)}`;
        holder.remove(placeholder);
        holder.add(m.object);
        // the original, textured model takes over when it arrives
        trackForDetail(holder, m.object, entry.id, entry.og, m.size);
        holder.userData.baseScale = s;
        holder.userData.fade = 0;
        holder.scale.setScalar(s * 0.6);
        slot.model = m;
        slot.entry.attribution = `${dims}${shown > 0.98 ? ' · shown at actual size' : ` · shown at 1:${Math.round(1 / shown)}`}${Math.abs(k - 1) > 0.01 ? ' · rescaled from the source to a realistic size' : ''} · ${m.tris.toLocaleString()} triangles`;
      })
      .catch(() => {
        if (!this.alive) return;
        placeholder.material = new THREE.MeshBasicMaterial({ color: '#884444', wireframe: true });
      });
  }

  /** Glass vitrine on a plinth along a wall; returns the case's inner floor positions. */
  protected vitrine(x: number, z: number, alongZ: boolean, len: number, wallColor: string) {
    const g = this.group;
    const dep = 1.2, ph = 0.95, gh = 1.35;
    const w = alongZ ? dep : len, d = alongZ ? len : dep;
    g.add(box(mat(shade(wallColor, 0.55), { rough: 0.7 }), w, ph, d, x, 0, z));
    g.add(box(brass, w + 0.04, 0.04, d + 0.04, x, ph, z, false));
    const glass = box(glassMat, w, gh, d, x, ph + 0.02, z, false);
    glass.renderOrder = 2;
    g.add(glass);
    // frame posts + top
    const frame = mat('#2a2a2a', { metal: 0.7, rough: 0.35 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(frame, 0.04, gh, 0.04, x + (sx * w) / 2, ph, z + (sz * d) / 2, false));
    g.add(box(frame, w + 0.04, 0.06, d + 0.04, x, ph + gh, z, false));
    // light strip inside the lid
    g.add(box(mat('#fff4dc', { emissive: '#fff4dc', ei: 1.6 }), w * 0.8, 0.02, d * 0.8, x, ph + gh - 0.04, z, false));
    this.cols.push(rect(x, z, w + 0.1, d + 0.1));
    return { y: ph + 0.03, inner: new THREE.Vector3(w - 0.25, gh - 0.2, d - 0.25) };
  }

  /** Room shell with doorways. Doors: {wall, offset, width}. */
  protected shell(W: number, D: number, H: number, wallColor: string, floor: 'wood' | 'stone', doors: { wall: 'N' | 'S' | 'E' | 'W'; at: number; w: number; h: number }[]) {
    const g = this.group;
    const T = 0.3;
    const wallM = mat(wallColor, { rough: 0.95 });
    const trim = mat('#efe7d6', { rough: 0.6 });
    // photo-scanned floors, tiled at their real size (floor UVs below are in units of 2.5 m)
    const fm = floor === 'wood' ? surface('floor_parquet', [2.5, 2.5], { roughness: 0.8, normalScale: 0.8 }) : surface('floor_marble', [2.5, 2.5], { roughness: 0.6, normalScale: 0.5 });
    const fl = plane(fm, W, D);
    const uv = fl.geometry.getAttribute('uv');
    // separate geometry so floor UVs can be scaled in metres
    fl.geometry = new THREE.PlaneGeometry(W, D);
    fl.scale.set(1, 1, 1);
    const uv2 = fl.geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv2.count; i++) uv2.setXY(i, (uv2.getX(i) * W) / 2.5, (uv2.getY(i) * D) / 2.5);
    void uv;
    fl.userData.owned = true;
    g.add(fl);
    const ceil = plane(mat('#f2ede4', { rough: 1 }), W, D, 0, H, 0);
    ceil.rotation.x = Math.PI / 2;
    g.add(ceil);
    // skylight
    g.add(box(mat('#fffaf0', { emissive: '#fff6e6', ei: 1.1 }), W * 0.5, 0.05, D * 0.6, 0, H - 0.06, 0, false));

    const walls: Record<string, { axis: 'x' | 'z'; c: number; a0: number; a1: number }> = {
      N: { axis: 'z', c: -D / 2, a0: -W / 2, a1: W / 2 },
      S: { axis: 'z', c: D / 2, a0: -W / 2, a1: W / 2 },
      W: { axis: 'x', c: -W / 2, a0: -D / 2, a1: D / 2 },
      E: { axis: 'x', c: W / 2, a0: -D / 2, a1: D / 2 },
    };
    for (const [k, wl] of Object.entries(walls)) {
      const ds = doors.filter((d) => d.wall === k).sort((a, b) => a.at - b.at);
      let cur = wl.a0;
      const seg = (s0: number, s1: number, y0: number, y1: number) => {
        if (s1 - s0 < 0.01) return;
        const mid = (s0 + s1) / 2, len = s1 - s0;
        const m = wl.axis === 'z' ? box(wallM, len, y1 - y0, T, mid, y0, wl.c, false) : box(wallM, T, y1 - y0, len, wl.c, y0, mid, false);
        g.add(m);
      };
      for (const d of ds) {
        seg(cur, d.at - d.w / 2, 0, H);
        seg(d.at - d.w / 2, d.at + d.w / 2, d.h, H);
        // door frame
        const fx = (o: number) => (wl.axis === 'z' ? box(trim, 0.14, d.h, T + 0.08, o, 0, wl.c, false) : box(trim, T + 0.08, d.h, 0.14, wl.c, 0, o, false));
        g.add(fx(d.at - d.w / 2 - 0.07), fx(d.at + d.w / 2 + 0.07));
        g.add(wl.axis === 'z' ? box(trim, d.w + 0.28, 0.16, T + 0.08, d.at, d.h, wl.c, false) : box(trim, T + 0.08, 0.16, d.w + 0.28, wl.c, d.h, d.at, false));
        cur = d.at + d.w / 2;
      }
      seg(cur, wl.a1, 0, H);
      // collisions for wall pieces (gaps left open)
      let c0 = wl.a0;
      for (const d of ds) {
        this.wallCol(wl.axis, wl.c, c0, d.at - d.w / 2);
        c0 = d.at + d.w / 2;
      }
      this.wallCol(wl.axis, wl.c, c0, wl.a1);
      // skirting + picture rail
      g.add(wl.axis === 'z' ? box(trim, W, 0.18, T + 0.04, 0, 0, wl.c, false) : box(trim, T + 0.04, 0.18, D, wl.c, 0, 0, false));
      g.add(wl.axis === 'z' ? box(trim, W, 0.08, T + 0.06, 0, H - 0.9, wl.c, false) : box(trim, T + 0.06, 0.08, D, wl.c, H - 0.9, 0, false));
    }
    // corridors beyond doors (a short dark passage you walk into)
    for (const d of doors) {
      const wl = walls[d.wall];
      const out = d.wall === 'N' || d.wall === 'W' ? -1 : 1;
      const L = 2.4;
      const cc = wl.c + out * (T / 2 + L / 2);
      const dark = mat('#14110d', { rough: 1 });
      if (wl.axis === 'z') {
        g.add(box(dark, 0.1, d.h, L, d.at - d.w / 2 - 0.05, 0, cc, false), box(dark, 0.1, d.h, L, d.at + d.w / 2 + 0.05, 0, cc, false));
        g.add(box(dark, d.w + 0.2, 0.1, L, d.at, d.h, cc, false), box(dark, d.w + 0.2, d.h, 0.1, d.at, 0, cc + (out * L) / 2, false));
        this.cols.push(rect(d.at, cc + (out * L) / 2, d.w + 0.4, 0.3), rect(d.at - d.w / 2 - 0.1, cc, 0.2, L), rect(d.at + d.w / 2 + 0.1, cc, 0.2, L));
      } else {
        g.add(box(dark, L, d.h, 0.1, cc, 0, d.at - d.w / 2 - 0.05, false), box(dark, L, d.h, 0.1, cc, 0, d.at + d.w / 2 + 0.05, false));
        g.add(box(dark, L, 0.1, d.w + 0.2, cc, d.h, d.at, false), box(dark, 0.1, d.h, d.w + 0.2, cc + (out * L) / 2, 0, d.at, false));
        this.cols.push(rect(cc + (out * L) / 2, d.at, 0.3, d.w + 0.4), rect(cc, d.at - d.w / 2 - 0.1, L, 0.2), rect(cc, d.at + d.w / 2 + 0.1, L, 0.2));
      }
      g.add(plane(mat('#1c1813'), wl.axis === 'z' ? d.w : L, wl.axis === 'z' ? L : d.w, wl.axis === 'z' ? d.at : cc, 0.005, wl.axis === 'z' ? cc : d.at));
    }
    // lights
    const n = Math.max(2, Math.round(D / 8));
    for (let i = 0; i < n; i++) {
      const z = -D / 2 + ((i + 0.5) * D) / n;
      const l = new THREE.PointLight('#fff0dc', 6 + W * 0.6, Math.max(W, D) * 1.2, 1.4);
      l.position.set(0, H - 0.6, z);
      g.add(l);
    }
  }

  private wallCol(axis: 'x' | 'z', c: number, a0: number, a1: number) {
    if (a1 - a0 < 0.01) return;
    this.cols.push(axis === 'z' ? rect((a0 + a1) / 2, c, a1 - a0, 0.5) : rect(c, (a0 + a1) / 2, 0.5, a1 - a0));
  }

  /** an auto-portal box inside a door's corridor, plus where to stand when you come back */
  protected doorPortal(d: { wall: 'N' | 'S' | 'E' | 'W'; at: number; w: number; h: number }, W: number, D: number, label: string, sub: string, target: LevelDesc | 'back') {
    const T = 0.3;
    let bx: THREE.Box3, ret: THREE.Vector3, yaw: number;
    if (d.wall === 'N') {
      bx = new THREE.Box3(new THREE.Vector3(d.at - d.w / 2, 0, -D / 2 - T / 2 - 2.4), new THREE.Vector3(d.at + d.w / 2, d.h, -D / 2 - T / 2 - 0.5));
      ret = new THREE.Vector3(d.at, 0, -D / 2 + 1.6);
      yaw = Math.PI;
    } else if (d.wall === 'S') {
      bx = new THREE.Box3(new THREE.Vector3(d.at - d.w / 2, 0, D / 2 + T / 2 + 0.5), new THREE.Vector3(d.at + d.w / 2, d.h, D / 2 + T / 2 + 2.4));
      ret = new THREE.Vector3(d.at, 0, D / 2 - 1.6);
      yaw = 0;
    } else if (d.wall === 'W') {
      bx = new THREE.Box3(new THREE.Vector3(-W / 2 - T / 2 - 2.4, 0, d.at - d.w / 2), new THREE.Vector3(-W / 2 - T / 2 - 0.5, d.h, d.at + d.w / 2));
      ret = new THREE.Vector3(-W / 2 + 1.6, 0, d.at);
      yaw = -Math.PI / 2;
    } else {
      bx = new THREE.Box3(new THREE.Vector3(W / 2 + T / 2 + 0.5, 0, d.at - d.w / 2), new THREE.Vector3(W / 2 + T / 2 + 2.4, d.h, d.at + d.w / 2));
      ret = new THREE.Vector3(W / 2 - 1.6, 0, d.at);
      yaw = Math.PI / 2;
    }
    this.ports.push({ box: bx, label, sub, target, auto: true, returnPos: ret, returnYaw: yaw });
  }

  /** sign above a doorway, readable from inside the room */
  protected doorSign(d: { wall: 'N' | 'S' | 'E' | 'W'; at: number; w: number; h: number }, W: number, D: number, top: string, main: string, color: string) {
    const s = textPlane([{ text: top, size: 0.1, color: '#d9c9a3', weight: 500, font: 'system-ui, sans-serif' }, { text: main, size: 0.22, color: '#fff' }], Math.max(3.0, d.w + 1.0), 0.66, color);
    const off = 0.17;
    if (d.wall === 'N') s.position.set(d.at, d.h + 0.55, -D / 2 + off);
    else if (d.wall === 'S') { s.position.set(d.at, d.h + 0.55, D / 2 - off); s.rotation.y = Math.PI; }
    else if (d.wall === 'W') { s.position.set(-W / 2 + off, d.h + 0.55, d.at); s.rotation.y = Math.PI / 2; }
    else { s.position.set(W / 2 - off, d.h + 0.55, d.at); s.rotation.y = -Math.PI / 2; }
    this.group.add(s);
  }
}

function fmtLen(m: number) {
  return m >= 1 ? `${m.toFixed(2)} m` : m >= 0.01 ? `${(m * 100).toFixed(1)} cm` : `${(m * 1000).toFixed(1)} mm`;
}

function shade(hex: string, f: number) {
  return `#${new THREE.Color(hex).multiplyScalar(f).getHexString()}`;
}
function easeOut(t: number) {
  return 1 - (1 - t) ** 3;
}

// ---------------------------------------------------------------- the atrium

export class AtriumLevel extends MuseumBase {
  name = 'Atrium';
  constructor() {
    super();
    const W = 30, D = 30, H = 10;
    const m = museum();
    const wings = m.wings.slice(0, 6);
    const doors: { wall: 'N' | 'S' | 'E' | 'W'; at: number; w: number; h: number }[] = [
      { wall: 'N', at: -6.5, w: 3, h: 4.2 },
      { wall: 'N', at: 6.5, w: 3, h: 4.2 },
      { wall: 'W', at: -5, w: 3, h: 4.2 },
      { wall: 'W', at: 7, w: 3, h: 4.2 },
      { wall: 'E', at: -5, w: 3, h: 4.2 },
      { wall: 'E', at: 7, w: 3, h: 4.2 },
    ];
    this.shell(W, D, H, '#e6dccb', 'stone', doors);
    this.env.hemi.intensity = 1.0;
    this.spawn.pos.set(0, 0, 11);
    this.spawn.yaw = 0;
    const g = this.group;

    // columns
    const stone = mat('#efe8db', { rough: 0.6 });
    for (const x of [-10, 10]) for (const z of [-10, 0, 10]) {
      g.add(cyl(stone, 0.55, H, x, 0, z));
      g.add(box(stone, 1.5, 0.4, 1.5, x, 0, z));
      g.add(box(stone, 1.5, 0.4, 1.5, x, H - 0.4, z));
      this.cols.push(rect(x, z, 1.3, 1.3));
    }

    // title wall (south, behind you as you enter: visible when you turn around) and the north frieze
    const title = textPlane([
      { text: 'THE SAND3D MUSEUM', size: 0.62, color: '#2b2217' },
      { text: `${m.total.toLocaleString()} objects, each one written as a short program`, size: 0.24, color: '#5a4a35', weight: 400 },
      { text: 'Every doorway leads to rooms of similar things. There is no last room.', size: 0.19, color: '#6b5a42', weight: 400 },
    ], 18, 2.4, '#e6dccb', 128);
    title.position.set(0, 6.6, -D / 2 + 0.17);
    g.add(title);
    const credit = textPlane([
      { text: 'Objects: sand3d by Sandflow · datasets on Hugging Face under CC BY 4.0', size: 0.1, color: '#5a4a35', weight: 400, font: 'system-ui, sans-serif' },
      { text: 'Look at anything and press E to read its program', size: 0.1, color: '#5a4a35', weight: 400, font: 'system-ui, sans-serif' },
    ], 8, 0.7, '#e6dccb');
    credit.position.set(0, 3.4, D / 2 - 0.17);
    credit.rotation.y = Math.PI;
    g.add(credit);

    // the six wings
    wings.forEach((w, i) => {
      const d = doors[i];
      const theme = m.themes[w.theme];
      const color = collectionColor(theme.collection);
      this.doorSign(d, W, D, `Wing ${i + 1}`, w.name, color);
      this.doorPortal(d, W, D, `Enter the ${w.name} wing`, w.blurb, { kind: 'gallery', theme: w.theme, page: 0, wing: w.name });
      // a banner and a preview case beside each door
      const side = d.wall === 'N' ? { x: d.at + (d.at < 0 ? -3.4 : 3.4), z: -D / 2 + 1.3, alongZ: false } : { x: d.wall === 'W' ? -W / 2 + 1.3 : W / 2 - 1.3, z: d.at - 3.4, alongZ: true };
      const v = this.vitrine(side.x, side.z, side.alongZ, 2.6, color);
      w.preview.slice(0, 2).forEach((e, k) => {
        const off = (k - 0.5) * 1.2;
        const at = new THREE.Vector3(side.x + (side.alongZ ? 0 : off), v.y, side.z + (side.alongZ ? off : 0));
        this.exhibit(e, at, new THREE.Vector3(1.0, v.inner.y, 1.0), 0);
      });
      const blurb = textPlane([{ text: w.name, size: 0.16, color: '#fff' }, { text: w.blurb, size: 0.085, color: '#e9dcc3', weight: 400, font: 'system-ui, sans-serif' }], 2.6, 0.7, color);
      if (side.alongZ) {
        blurb.position.set(side.x + (d.wall === 'W' ? 0.62 : -0.62), 0.5, side.z);
        blurb.rotation.y = d.wall === 'W' ? Math.PI / 2 : -Math.PI / 2;
      } else {
        blurb.position.set(side.x, 0.5, side.z + 0.62);
      }
      blurb.scale.setScalar(0.5);
      g.add(blurb);
    });

    // centrepiece: a rotating giant from a random wing
    g.add(cyl(stone, 2.6, 0.5, 0, 0, -1));
    g.add(cyl(mat('#2b2b2e', { rough: 0.3, metal: 0.4 }), 2.3, 0.55, 0, 0, -1));
    this.cols.push(rect(0, -1, 4.6, 4.6));
    const pool = wings.flatMap((w) => w.preview);
    const hero = pool[Math.floor(Math.random() * pool.length)];
    if (hero) this.exhibit(hero, new THREE.Vector3(0, 0.55, -1), new THREE.Vector3(3.6, 3.4, 3.6), -1, 0.15);
    g.add(glow('#fff4dc', 6, 0, 5.5, -1, 0.25));
  }
}

// ---------------------------------------------------------------- galleries

export class GalleryLevel extends MuseumBase {
  name: string;
  private theme: Theme;

  constructor(desc: Extract<LevelDesc, { kind: 'gallery' }>) {
    super();
    const m = museum();
    this.theme = m.themes[desc.theme];
    const t = this.theme;
    const pages = Math.max(1, Math.ceil(t.size / PAGE));
    this.name = `${t.name}${desc.page ? ` · ${roman(desc.page + 1)}` : ''}`;
    const W = 14, D = 24, H = 5.2;
    const color = collectionColor(t.collection);
    const r = new Rng(hashN(desc.theme, desc.page, 7));

    // exits: next page of this theme (if any), then the most similar themes
    const exits: { label: string; top: string; target: LevelDesc }[] = [];
    if (desc.page + 1 < pages) exits.push({ top: 'continue', label: `${t.name} ${roman(desc.page + 2)}`, target: { kind: 'gallery', theme: t.id, page: desc.page + 1, wing: desc.wing } });
    for (const n of t.neighbors) {
      if (exits.length >= 3) break;
      const nt = m.themes[n];
      if (!nt) continue;
      exits.push({ top: nt.collection === t.collection ? 'similar' : `similar · ${nt.collection}`, label: nt.name, target: { kind: 'gallery', theme: n, page: 0, wing: desc.wing } });
    }
    while (exits.length < 3) {
      const n = r.int(0, m.themes.length - 1);
      exits.push({ top: 'somewhere else', label: m.themes[n].name, target: { kind: 'gallery', theme: n, page: 0, wing: desc.wing } });
    }
    r.shuffle(exits);
    const doorAt = [-4.4, 0, 4.4];
    const doors = [
      { wall: 'S' as const, at: 0, w: 2.4, h: 3.2 },
      ...exits.map((_, i) => ({ wall: 'N' as const, at: doorAt[i], w: 2.2, h: 3.0 })),
    ];
    const wallColor = shade(color, 1.25);
    this.shell(W, D, H, wallColor, r.chance(0.5) ? 'wood' : 'stone', doors);
    this.spawn.pos.set(0, 0, D / 2 - 1.4);
    this.spawn.yaw = 0;
    this.doorPortal(doors[0], W, D, 'Go back', 'to the previous room', 'back');
    exits.forEach((ex, i) => {
      this.doorSign(doors[i + 1], W, D, ex.top, ex.label, shade(color, 0.7));
      this.doorPortal(doors[i + 1], W, D, ex.label, ex.top, ex.target);
    });

    // room title over the exits, and the wall text by the entrance
    const tt = textPlane([
      { text: t.name, size: 0.5, color: '#fff' },
      { text: `${t.collection} · ${t.size} object${t.size === 1 ? '' : 's'}${pages > 1 ? ` · room ${desc.page + 1} of ${pages}` : ''}`, size: 0.12, color: '#f0e4cc', weight: 400, font: 'system-ui, sans-serif' },
    ], 12, 1.2, wallColor, 160);
    tt.position.set(0, H - 0.72, -D / 2 + 0.17);
    this.group.add(tt);
    if (t.words.length) {
      const wt = textPlane([
        { text: 'What these objects share', size: 0.11, color: '#3a2f22', weight: 700, font: 'system-ui, sans-serif' },
        { text: t.words.slice(0, 6).join(' · '), size: 0.1, color: '#4a3d2c', weight: 400, font: 'ui-monospace, monospace' },
        { text: 'words found in their sand3d programs and titles', size: 0.075, color: '#6b5a42', weight: 400, font: 'system-ui, sans-serif' },
      ], 4.2, 0.7, '#efe6d2');
      wt.position.set(-3.6, 1.6, D / 2 - 0.17);
      wt.rotation.y = Math.PI;
      this.group.add(wt);
    }

    // cases: 4 along each long wall, hero in the middle
    const cases: { x: number; z: number }[] = [];
    for (const x of [-W / 2 + 1.0, W / 2 - 1.0]) for (const z of [-7.8, -2.6, 2.6, 7.8]) cases.push({ x, z });
    themeMembers(t.id).then((all) => {
      if (this.group.userData.disposed) return;
      const items = all.slice(desc.page * PAGE, desc.page * PAGE + PAGE);
      if (!items.length) return;
      const hero = items[0];
      const rest = items.slice(1);
      const g = this.group;
      g.add(cyl(mat('#2b2b2e', { rough: 0.35, metal: 0.3 }), 1.0, 0.6, 0, 0, 0));
      g.add(cyl(brass, 1.05, 0.04, 0, 0.6, 0));
      this.cols.push(rect(0, 0, 2.0, 2.0));
      this.exhibit(hero, new THREE.Vector3(0, 0.64, 0), new THREE.Vector3(1.9, 2.2, 1.9), 0, 0.2);
      g.add(glow('#fff2d0', 4, 0, 3.6, 0, 0.18));
      const heroLabel = textPlane([{ text: hero.title, size: 0.13, color: '#2a2218' }, { text: hero.author ? `by ${hero.author}` : DATASET_LABEL[hero.ds], size: 0.08, color: '#5a4a35', weight: 400, font: 'system-ui, sans-serif' }], 1.6, 0.42, '#efe6d2');
      heroLabel.position.set(0, 0.32, 1.02);
      heroLabel.rotation.x = -0.25;
      g.add(heroLabel);
      for (let c = 0; c < cases.length; c++) {
        const group = rest.slice(c * 3, c * 3 + 3);
        if (!group.length) break;
        const { x, z } = cases[c];
        const v = this.vitrine(x, z, true, 3.4, wallColor);
        group.forEach((e, k) => {
          const off = (k - (group.length - 1) / 2) * 1.05;
          this.exhibit(e, new THREE.Vector3(x, v.y, z + off), new THREE.Vector3(0.95, v.inner.y, 0.95), c + 1);
        });
        const inward = x < 0 ? 1 : -1;
        const lab = textPlane(
          group.map((e, k) => ({ text: `${k + 1}. ${e.title}${e.author ? ` — ${e.author}` : ''}`, size: 0.085, color: '#2a2218', weight: 500, font: 'system-ui, sans-serif' })),
          2.6, 0.5, '#efe6d2', 256, 'left',
        );
        lab.position.set(x + inward * 0.61, 0.6, z);
        lab.rotation.y = inward > 0 ? Math.PI / 2 : -Math.PI / 2;
        lab.rotation.x = 0;
        g.add(lab);
      }
    });
  }
}

function roman(n: number) {
  const map: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of map) while (n >= v) { s += r; n -= v; }
  return s;
}
