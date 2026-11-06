import * as THREE from 'three';
import { mat, box as boxMesh } from '../build';
import { loadCatalog, type LibraryEntry } from '../libraries';
import { museum, themeMembers } from '../museumData';
import { Rng } from '../rng';
import { Frame, MuseumBase, shade, WORLD } from './base';
import { bench, cluster, labelPanel, makeMats, platform, plinth, type Ctx, type Unit } from './displays';
import type { Door, Plan } from './plan';
import { buildShell, doorPortal, doorSign } from './shell';
import { loadThemeSizes, measure, measuredFromCache, type Measured } from './sizes';
import { siEntries, siMeasured, SI_BASE, SI_ROOMS } from './smithsonian';
import { STYLES, type Style } from './style';
import { descKeyOf, markVisited, registerRoom } from './map';
import { textPlane, SANS, SERIF } from './text';
import { prewarm } from './looks';

const PALETTE = ['#7d2e2e', '#2e4d7d', '#2e6b55', '#6b4a2e', '#4d2e6b', '#7d6a2e', '#2e6b7d', '#5b5b5b', '#8a3d5c', '#3d5c2e'];
export function collectionColor(c: string) {
  let h = 0;
  for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const W = 30, D = 30, H = 13;
const CENTRE = new THREE.Vector3(0, 0, -16);

/**
 * The great hall (after the British Museum's Great Court, the Met's Great Hall and the Smithsonian
 * Castle): a coffered ceiling round a skylight, a real Apollo 11 capsule on the central plinth, the
 * Bell X-1 and the Wright Flyer overhead, six wing doorways each opening onto a lit vestibule framing the wing's
 * best object, banners and text panels per wing, an information desk and benches.
 */
export class AtriumLevel extends MuseumBase {
  name = 'Atrium';
  /** per door: what stands in its vestibule (hidden while the room behind shows through) */
  private framedAt: THREE.Object3D[][] = [];
  private doorsList: Door[] = [];
  private seeing = new Set<number>();
  constructor() {
    super();
    // the museum's exhibit shader variants, compiled with the atrium on entering museum mode (looks.ts)
    this.group.add(prewarm());
    const m = museum();
    const wings = m.wings.slice(0, 6);
    const st: Style = { ...STYLES.period, walls: ['#e8dcc6'], trim: '#f1e8d6', plinth: ['#2b2b2e', '#e8e0d0'], dark: false };
    const colors = wings.map((w) => collectionColor(m.themes[w.theme].collection));
    const vest = (c: string) => ({ depth: 5.2, color: shade(c, 1.35) });
    const doors: Door[] = [
      { wall: 'N', at: -7, w: 3, h: 4.4, vest: vest(colors[0]) },
      { wall: 'N', at: 7, w: 3, h: 4.4, vest: vest(colors[1]) },
      { wall: 'W', at: -21, w: 3, h: 4.4, vest: vest(colors[2]) },
      { wall: 'W', at: -9, w: 3, h: 4.4, vest: vest(colors[3]) },
      { wall: 'E', at: -21, w: 3, h: 4.4, vest: vest(colors[4]) },
      { wall: 'E', at: -9, w: 3, h: 4.4, vest: vest(colors[5]) },
      // behind you as you arrive: the Smithsonian rooms (real museum scans)
      { wall: 'S', at: -8, w: 3, h: 4.4, vest: { depth: 5.2, color: '#d9d2c4' } },
      { wall: 'S', at: 8, w: 3, h: 4.4, vest: { depth: 5.2, color: '#d9d2c4' } },
    ];
    const plan: Plan = { W, D, H, Hw: H, floor: [], wall: [], hang: [], doors, ceiling: 'coffer', floorKind: 'marble', wallColor: '#e8dcc6', rows: [], columns: [], pilasters: [] };
    const parts = buildShell(this, plan, st, { see: true });
    // a doorway's vestibule (end wall, framed object) gives way to the real room once it shows through
    this.doorsList = doors;
    const seeThrough = (di: number) => (shown: boolean) => {
      if (shown) this.seeing.add(di);
      else this.seeing.delete(di);
      const end = parts.ends[di];
      if (end) end.visible = !shown;
      for (const o of this.framedAt[di] ?? []) o.visible = !shown;
    };
    // warm, daylit hall
    this.env.hemi = { sky: '#fff0d8', ground: '#5a4a38', intensity: 1.0 };
    this.env.exposure = 1.05;
    this.spawn.pos.set(0, 0, -3.5);
    this.spawn.yaw = 0;
    // deterministic: the same atrium on every visit
    const r = new Rng(20261106);
    const mats = makeMats(st, r);
    let prio = 0;
    const ctx: Ctx = { lv: this, st, r, m: mats, prio: () => prio++, labelBg: '#f3ede1', labelInk: '#1f1b16', labelSub: '#5d5446' };

    // the heroes start streaming before anything else in the hall
    const heroes = [
      this.centrepiece(ctx),
      this.flyer(ctx, /bell x-1/i, 1.5, -10.5, 0.55, 0.06, 2.2),
      // the Wright Flyer, as it hung in the Smithsonian's Arts and Industries hall
      this.flyer(ctx, /wright flyer/i, 0, -23.5, 0, -0.04, 1.4),
    ];
    this.architecture();
    this.dressing(wings.map((w) => w.name), colors);

    // the museum's name across the north wall, between the two north banners; credits on the south
    const title = textPlane([
      { text: 'THE SAND3D MUSEUM', size: 0.6, color: '#2b2217' },
      { text: `${m.total.toLocaleString()} objects, each written as a short program, each at its real size`, size: 0.2, color: '#5a4a35', weight: 400 },
      { text: 'Every doorway leads to rooms of similar things. There is no last room.', size: 0.18, color: '#6b5a42', weight: 400 },
    ], 11.2, 2.3, null, 128);
    title.position.set(0, 8.2, -D + 0.03);
    this.group.add(title);
    const credit = textPlane([
      { text: 'Objects: sand3d by Sandflow (CC BY 4.0) · Smithsonian 3D Open Access (CC0)', size: 0.1, color: '#5a4a35', weight: 400, font: SANS },
      { text: 'Look at anything and press E to read about it', size: 0.1, color: '#5a4a35', weight: 400, font: SANS },
    ], 8, 0.7, null);
    credit.position.set(0, 5.6, -0.03);
    credit.rotation.y = Math.PI;
    this.group.add(credit);

    // the wings: sign, walk-through, banner, text panel, a framed object in the vestibule, previews by the door
    const previewAt: Frame[] = [new Frame(-12, -26.5, Math.PI / 4), new Frame(12, -26.5, -Math.PI / 4), new Frame(-12.6, -15, Math.PI / 2), new Frame(-12.6, -3.6, Math.PI / 2), new Frame(12.6, -15, -Math.PI / 2), new Frame(12.6, -3.6, -Math.PI / 2)];
    const loads: Promise<unknown>[] = [];
    wings.forEach((w, i) => {
      const d = doors[i];
      const theme = m.themes[w.theme];
      doorSign(this, d, W, D, `Wing ${i + 1} · ${theme.collection}`, w.name, colors[i]);
      doorPortal(this, d, W, D, `Enter the ${w.name} wing`, w.blurb, { kind: 'gallery', theme: w.theme, page: 0, wing: w.name }, seeThrough(i), 34);
      this.banner(d, w.name, `Wing ${i + 1}`, colors[i]);
      this.wallText(d, i, w.name, w.blurb, theme.size, colors[i]);
      loads.push(
        // the wing's first room, with its offline sizes: pick what shows it best
        themeMembers(w.theme)
          .then((all) => loadThemeSizes(theme.shard, theme.id, all).then(() => all))
          .then(async (all) => {
            if (!this.alive) return;
            let ms = all.slice(0, 40).map(measuredFromCache).filter((x): x is Measured => !!x);
            if (!ms.length) ms = (await Promise.allSettled(w.preview.map((e, k) => measure(e, k)))).filter((x): x is PromiseFulfilledResult<Measured> => x.status === 'fulfilled').map((x) => x.value);
            if (!this.alive) return;
            this.wingPreview(ctx, d, previewAt[i], ms);
            this.flush();
          }),
      );
    });
    // the two Smithsonian doorways frame one of their objects too
    const siDoors: [number, number][] = [[6, 0], [7, 3]];
    for (const [di, k] of siDoors) {
      doorSign(this, doors[di], W, D, 'Smithsonian · real museum scans', SI_ROOMS[k].name, '#2b2a28');
      doorPortal(this, doors[di], W, D, SI_ROOMS[k].name, SI_ROOMS[k].blurb, { kind: 'gallery', theme: SI_BASE + k, page: 0, wing: 'Smithsonian' }, seeThrough(di), 34);
      loads.push(
        siEntries(SI_BASE + k).then((es) => {
          if (!this.alive) return;
          const fit = es.find((e) => e.size && Math.max(e.size[0], e.size[2]) <= 3.2 && e.size[1] <= 3.6 && Math.max(...e.size) >= 0.6);
          if (fit) this.framed(ctx, doors[di], siMeasured(fit, false));
          this.flush();
        }),
      );
    }

    loads.push(...heroes);
    // on the museum's floor plan (the minimap)
    this.mapKey = descKeyOf({ kind: 'atrium' });
    markVisited(this.mapKey);
    registerRoom({
      key: this.mapKey, desc: { kind: 'atrium' }, name: 'Atrium', color: '#b89a5a', W, D, doors,
      exits: doors.map((_, i) => (i < 6 ? { kind: 'gallery', theme: wings[i].theme, page: 0, wing: wings[i].name } : { kind: 'gallery', theme: SI_BASE + siDoors[i - 6][1], page: 0, wing: 'Smithsonian' })),
      dots: [[CENTRE.x, CENTRE.z], ...previewAt.map((f) => [f.x, f.z] as [number, number])],
    });
    this.flush();
    this.markBuilt();
    this.ready = Promise.allSettled(loads).then(() => this.settle());
  }

  // ---------------------------------------------------------------- architecture

  private architecture() {
    const stone = mat('#efe6d6', { rough: 0.6 });
    // a colonnade
    for (const x of [-8.5, 8.5]) for (const z of [-24, -15, -6]) {
      this.cy(stone, 0.5, H, x, 0, z);
      this.bx(stone, 1.3, 0.45, 1.3, x, 0, z);
      this.bx(stone, 1.2, 0.1, 1.2, x, 0.45, z);
      this.bx(stone, 1.4, 0.55, 1.4, x, H - 0.55, z);
      this.cols.push({ minX: x - 0.65, maxX: x + 0.65, minZ: z - 0.65, maxZ: z + 0.65 });
    }
    // a skylight over the centre: a glazed lantern on a deep frame
    const glaze = mat('#f4f8ff', { emissive: '#f6f8ff', ei: 1.5 });
    const frame = mat('#e9e1d2', { rough: 0.7 });
    const s = 9;
    this.bx(glaze, s, 0.05, s, CENTRE.x, H + 1.6, CENTRE.z);
    for (const k of [-1, 1]) {
      this.bx(frame, s + 0.4, 1.6, 0.25, CENTRE.x, H - 0.005, CENTRE.z + (k * (s + 0.2)) / 2);
      this.bx(frame, 0.24, 1.6, s + 0.38, CENTRE.x + (k * (s + 0.2)) / 2, H - 0.005, CENTRE.z);
    }
    for (let i = 1; i < 6; i++) {
      const o = -s / 2 + (s * i) / 6;
      this.bx(frame, 0.08, 0.14, s, CENTRE.x + o, H + 1.46, CENTRE.z);
      this.bx(frame, s, 0.14, 0.08, CENTRE.x, H + 1.46, CENTRE.z + o);
    }
    // floor inlay: rings and a compass star round the plinth
    const dark = mat('#5a4636', { rough: 0.4 });
    const light = mat('#e3d6bf', { rough: 0.4 });
    const ring = (rIn: number, rOut: number, m: THREE.Material, y: number) => {
      const g = new THREE.RingGeometry(rIn, rOut, 64);
      g.rotateX(-Math.PI / 2);
      this.geo(m, g, new THREE.Matrix4().makeTranslation(CENTRE.x, y, CENTRE.z));
    };
    // decal layers a visible few millimetres apart (no z-fighting with the floor or each other)
    ring(4.2, 4.5, dark, 0.008);
    ring(5.6, 5.75, dark, 0.008);
    ring(4.5, 5.6, light, 0.004);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const len = i % 2 ? 1.0 : 2.2;
      const f = new Frame(CENTRE.x + Math.sin(a) * (2.9 + len / 2), CENTRE.z + Math.cos(a) * (2.9 + len / 2), a);
      this.bx(i % 2 ? light : dark, 0.12, 0.012, len, 0, 0, 0, f);
    }
    // a warm fill under the coffers
    // one point light (the rig's fill; each light costs every lit pixel), as bright as the two it replaces
    this.point(new THREE.Vector3(0, H - 2.5, -11), '#ffe2bd', 130, 34, 1.2);
  }

  /** a tall banner in the wing's colour over its doorway */
  private banner(d: Door, name: string, top: string, color: string) {
    const b = textPlane([
      { text: top.toUpperCase(), size: 0.16, color: shade('#ffffff', 0.85), weight: 600, font: SANS },
      { text: name, size: 0.3, color: '#ffffff', font: SERIF },
    ], 1.7, 3.6, color, 220);
    const y = d.h + 1.6 + 1.8 + 0.4;
    const { p, rot } = onWall(d.wall, d.at, 0.06);
    b.position.set(p.x, y, p.z);
    b.rotation.y = rot;
    this.group.add(b);
    // rod and cords
    const rodM = mat('#8a6a2a', { metal: 0.7, rough: 0.35 });
    const f = new Frame(p.x, p.z, rot);
    this.bx(rodM, 2.0, 0.05, 0.05, 0, y + 1.82, 0.02, f);
  }

  /** a wall text panel beside a wing's doorway */
  private wallText(d: Door, i: number, name: string, blurb: string, size: number, color: string) {
    const side = d.wall === 'N' ? (d.at < 0 ? 1 : -1) : -1;
    const { p, rot } = onWall(d.wall, d.at + side * (d.w / 2 + 1.3), 0.04);
    const t = textPlane([
      { text: `WING ${i + 1}`, size: 0.07, color: color, weight: 700, font: SANS },
      { text: name, size: 0.16, color: '#1f1b16', font: SERIF },
      { text: blurb, size: 0.06, color: '#3a3128', weight: 400, font: SANS },
      { text: `Begins with “${museum().themes[museum().wings[i].theme].name}”, ${size} objects; every doorway leads on.`, size: 0.05, color: '#5d5446', weight: 400, font: SANS },
    ], 1.6, 0.9, '#f6f0e4', 420, 'left');
    t.position.set(p.x, 1.55, p.z);
    t.rotation.y = rot;
    this.group.add(t);
  }

  /** information desk, benches round the centre */
  private dressing(_names: string[], _colors: string[]) {
    const wood = mat('#4a3426', { rough: 0.5 });
    const top = mat('#efe6d6', { rough: 0.35 });
    // the desk, off to the right as you come in
    const f = new Frame(5.6, -10.2, -0.5);
    this.bx(wood, 3.2, 1.0, 0.7, 0, 0, 0, f);
    this.bx(top, 3.4, 0.06, 0.85, 0, 1.0, 0, f);
    this.bx(wood, 0.7, 1.0, 1.4, -1.25, 0, -0.75, f);
    this.bx(top, 0.85, 0.06, 1.55, -1.25, 1.0, -0.75, f);
    this.cols.push(f.rect(0, -0.3, 3.6, 1.8));
    const sign = textPlane([{ text: 'Information', size: 0.16, color: '#fff', font: SERIF }, { text: 'maps · audio guides · tickets', size: 0.07, color: '#e8dcc3', weight: 400, font: SANS }], 1.6, 0.42, '#2b2a28');
    sign.position.copy(f.point(0, 1.55, -0.1));
    sign.rotation.y = f.rot;
    this.group.add(sign);
    this.bx(mat('#1f1d1b'), 0.04, 0.55, 0.04, -0.6, 1.06, -0.12, f);
    this.bx(mat('#1f1d1b'), 0.04, 0.55, 0.04, 0.6, 1.06, -0.12, f);
    // benches round the plinth, facing it
    const ctxless = { lv: this, m: makeMats(STYLES.period, new Rng(3)) } as unknown as Ctx;
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      bench().build(ctxless, new Frame(CENTRE.x + Math.sin(a) * 6.6, CENTRE.z + Math.cos(a) * 6.6, a));
    }
  }

  // ---------------------------------------------------------------- exhibits

  /** the centrepiece: Apollo 11's command module (Smithsonian scan) at real size, spot-lit */
  private async centrepiece(ctx: Ctx) {
    const stone = mat('#efe6d6', { rough: 0.6 });
    this.cy(stone, 2.7, 0.35, CENTRE.x, 0, CENTRE.z);
    this.cy(mat('#2b2b2e', { rough: 0.3, metal: 0.4 }), 2.45, 0.5, CENTRE.x, 0.35, CENTRE.z);
    this.cols.push({ minX: -2.8, maxX: 2.8, minZ: CENTRE.z - 2.8, maxZ: CENTRE.z + 2.8 });
    const es = await loadCatalog('smithsonian', 'air-space').catch(() => [] as LibraryEntry[]);
    if (!this.alive) return;
    // the capsule's exterior scan (the other record is its interior)
    const e = es.find((x) => /command module/i.test(x.title) && x.size && Math.hypot(x.size[0], x.size[2]) <= 5.6 && (x.parts ?? []).some((p) => /exterior/.test(p.url))) ?? es.find((x) => x.size && Math.max(x.size[0], x.size[2]) <= 4.6);
    if (!e) return;
    const mm = siMeasured(e, false);
    const top = 0.85;
    this.exhibit(mm, new Frame(CENTRE.x, CENTRE.z), 0, top, 0, Math.PI, { prio: -2, progressive: true });
    this.spot(new THREE.Vector3(CENTRE.x, H - 0.5, CENTRE.z + 6), new THREE.Vector3(CENTRE.x, top + mm.real.y / 2, CENTRE.z), { angle: 0.36, boost: 10, color: '#fff1dc' });
    this.pool(CENTRE.x, 0.85, CENTRE.z, 2.4, '#ffe9c8', 0.25);
    const lab = labelPanel(ctx, [mm], 0.62, true);
    lab.position.set(CENTRE.x, 0.62, CENTRE.z + 2.47);
    this.group.add(lab);
    this.flush();
  }

  /**
   * An aircraft overhead at real size (low detail first, then the full scan), on cables:
   * the Bell X-1 banking between the entrance and the capsule, the Wright Flyer high over the north half.
   */
  private async flyer(ctx: Ctx, pick: RegExp, x: number, z: number, yaw: number, bank: number, below: number) {
    const es = await loadCatalog('smithsonian', 'air-space').catch(() => [] as LibraryEntry[]);
    if (!this.alive) return;
    const e = es.find((q) => pick.test(q.title) && q.size);
    if (!e) return;
    const mm = siMeasured(e, false);
    const y = H - below - mm.real.y;
    const f = new Frame(x, z, yaw, y);
    const slot = this.exhibit(mm, f, 0, 0, 0, mm.real.x >= mm.real.z ? 0 : Math.PI / 2, { prio: -1, progressive: true });
    slot.holder.rotation.z = bank;
    for (const [sx, sz] of [[-0.35, -0.3], [0.35, -0.3], [0, 0.35]]) {
      const p = f.point(sx * Math.max(mm.real.x, mm.real.z), mm.real.y * 0.7, sz * Math.min(mm.real.x, mm.real.z));
      this.rod(ctx.m.cable, p, new THREE.Vector3(p.x, H, p.z), 0.006);
    }
    this.spot(new THREE.Vector3(x - 6, H - 0.4, z + 6), new THREE.Vector3(x, y + mm.real.y / 2, z), { angle: 0.45, boost: 6 });
    this.flush();
  }

  /** a wing's previews: its best object framed in the vestibule, the rest on plinths by the door */
  private wingPreview(ctx: Ctx, d: Door, f: Frame, ms: Measured[]) {
    // the showpiece by the door: the biggest thing that fits a platform there; the vestibule frames the next biggest
    const vol = (x: Measured) => x.real.x * x.real.y * x.real.z;
    const byVol = [...ms].filter((x) => Math.max(x.real.x, x.real.y, x.real.z) >= 0.25).sort((a, b) => vol(b) - vol(a));
    const big = byVol.find((x) => Math.max(x.real.x, x.real.z) > 1.2 && Math.max(x.real.x, x.real.z) <= 4.2 && x.real.y <= 5);
    const fitsVest = (x: Measured) => x !== big && Math.max(x.real.x, x.real.z) <= d.w + 1.4 && x.real.y <= d.h + 0.2 && Math.max(x.real.x, x.real.y, x.real.z) >= 0.35;
    const best = byVol.find(fitsVest);
    if (best) this.framed(ctx, d, best);
    const rest = byVol.filter((x) => x !== best && x !== big);
    const medium = rest.filter((x) => Math.max(x.real.x, x.real.z) <= 1.9 && x.real.y <= 2.2 && Math.max(x.real.x, x.real.y, x.real.z) >= 0.3);
    let u: Unit | null = null;
    if (big) u = platform({ st: ctx.st, r: ctx.r }, big, false, 'rope');
    else if (medium.length >= 2) u = cluster(medium.slice(0, 3), ctx.r, medium.slice(0, 3).every((x) => Math.max(x.real.x, x.real.z) < 0.6));
    else if (medium.length) u = plinth(medium[0], Math.max(medium[0].real.x, medium[0].real.z) < 0.6, true);
    if (!u) return;
    u.build(ctx, f);
    const t = f.point(u.focus.x, u.focus.y, u.focus.z);
    this.spot(new THREE.Vector3(t.x * 0.75, H - 1, t.z + (t.z < -15 ? 4 : -4) * 0), t, { angle: 0.3, boost: 7 });
    this.pool(f.x, 0, f.z, u.glow + 0.3, '#ffe7c2', 0.18);
  }

  /** one object on a low plinth at the back of a doorway's vestibule, framed by the opening */
  private framed(ctx: Ctx, d: Door, mm: Measured) {
    const L = d.vest?.depth ?? 2.4;
    const back = 0.3 + L - 1.2; // from the wall line
    const { p, rot } = onWall(d.wall, d.at, -back);
    const f = new Frame(p.x, p.z, rot);
    const ph = mm.real.y < 1 ? 0.75 : 0.25;
    const pw = Math.max(0.6, Math.max(mm.real.x, mm.real.z) + 0.3);
    const ped = boxMesh(mat('#f3efe7', { rough: 0.6 }), pw, ph, Math.max(0.6, Math.min(mm.real.x, mm.real.z) + 0.3), p.x, 0, p.z, false);
    ped.rotation.y = rot;
    this.group.add(ped);
    const a = mm.real.x >= mm.real.z ? 0 : Math.PI / 2;
    const slot = this.exhibit(mm, f, 0, ph + 0.002, 0, a, { prio: 2 });
    const lab = labelPanel(ctx, [mm], 0.4);
    lab.position.copy(f.point(Math.min(pw / 2 + 0.4, d.w / 2 + 0.6), 1.1, 0.1));
    lab.rotation.y = f.rot;
    this.group.add(lab);
    const di = this.doorsList.indexOf(d);
    (this.framedAt[di] ??= []).push(ped, slot.holder, lab);
    // already looking through? stay hidden
    if (this.seeing.has(di)) for (const o of this.framedAt[di]) o.visible = false;
    void WORLD;
  }
}

/** a point on the inner face of a wall (`off` metres into the room; negative = beyond it), and the rotation facing the room */
function onWall(wall: Door['wall'], at: number, off: number): { p: THREE.Vector3; rot: number } {
  switch (wall) {
    case 'N': return { p: new THREE.Vector3(at, 0, -D + off), rot: 0 };
    case 'S': return { p: new THREE.Vector3(at, 0, -off), rot: Math.PI };
    case 'W': return { p: new THREE.Vector3(-W / 2 + off, 0, at), rot: Math.PI / 2 };
    case 'E': return { p: new THREE.Vector3(W / 2 - off, 0, at), rot: -Math.PI / 2 };
  }
}
