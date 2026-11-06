import * as THREE from 'three';
import type { LevelDesc, Rect } from '../level';
import { mat } from '../build';
import { museum, themeMembers, type Theme } from '../museumData';
import { Rng, hashN } from '../rng';
import { MuseumBase, shade } from './base';
import { makeMats, type Ctx, type Unit } from './displays';
import { assemble, partitionRooms, planRoom, type Plan } from './plan';
import { buildShell, doorPortal, doorSign, ENTRY_Z } from './shell';
import { descKeyOf, registerRoom } from './map';
import { loadThemeSizes, measure, measuredFromCache, prefetchSizes, type Measured } from './sizes';
import { pageSize, styleFor, STYLES, type Style } from './style';
import { isSi, siEntries, siMeasured, siTheme, SI_BASE, SI_ROOMS } from './smithsonian';

const SI_PAGE = 16;
import { roman, textPlane, SANS, SERIF } from './text';

/** which objects a room was built with, so it comes back identical */
const roomMembers = new Map<string, string[]>();

const MEASURE_TIMEOUT = 45000;

interface Exit {
  label: string;
  top: string;
  target: LevelDesc;
}

export class GalleryLevel extends MuseumBase {
  name: string;
  theme: Theme;
  readonly style: Style;
  plan: Plan | null = null;
  private r: Rng;
  private ante: THREE.Group | null = null;

  constructor(private desc: Extract<LevelDesc, { kind: 'gallery' }>) {
    super();
    const m = museum();
    const si = isSi(desc.theme);
    const t = (this.theme = si ? siTheme(desc.theme) : m.themes[desc.theme]);
    const st = (this.style = si ? STYLES[SI_ROOMS[desc.theme - SI_BASE].arch] : styleFor(t.collection));
    const per = si ? SI_PAGE : pageSize(t.collection);
    this.name = `${t.name}${desc.page ? ` · ${roman(desc.page + 1)}` : ''}`;
    this.r = new Rng(hashN(desc.theme, desc.page, 11));
    this.mapKey = descKeyOf(desc);
    this.setEnv(st);
    this.spawn.pos.set(0, 0, -1.6);
    this.spawn.yaw = 0;
    if (si) {
      this.ready = this.startSi();
      return;
    }

    this.ready = this.start(per);
  }

  /** doorways: the next room of this theme (if any), then the most similar themes */
  private exits(pages: number): Exit[] {
    const m = museum();
    const t = this.theme, desc = this.desc;
    const exits: Exit[] = [];
    if (desc.page + 1 < pages) exits.push({ top: 'continue', label: `${t.name} ${roman(desc.page + 2)}`, target: { kind: 'gallery', theme: t.id, page: desc.page + 1, wing: desc.wing } });
    for (const n of t.neighbors) {
      if (exits.length >= 3) break;
      const nt = m.themes[n];
      if (!nt) continue;
      exits.push({ top: nt.collection === t.collection ? 'similar' : `similar · ${nt.collection}`, label: nt.name, target: { kind: 'gallery', theme: n, page: 0, wing: desc.wing } });
    }
    const er = new Rng(hashN(desc.theme, desc.page, 7));
    while (exits.length < 3) {
      const n = er.int(0, m.themes.length - 1);
      exits.push({ top: 'somewhere else', label: m.themes[n].name, target: { kind: 'gallery', theme: n, page: 0, wing: desc.wing } });
    }
    // now and then a doorway into the Smithsonian rooms that match this collection
    const sk = SI_ROOMS.findIndex((x) => x.related === t.collection);
    if (sk >= 0 && er.chance(0.5)) exits[exits.length - 1] = { top: 'Smithsonian · real museum scans', label: SI_ROOMS[sk].name, target: { kind: 'gallery', theme: SI_BASE + sk, page: 0, wing: desc.wing } };
    er.shuffle(exits);
    return exits;
  }

  private setEnv(st: Style) {
    // light and sky
    this.env = {
      ...this.env,
      hemi: { sky: st.dark ? '#f2eadc' : '#fff8ee', ground: st.dark ? '#4a4036' : '#6a6055', intensity: st.hemi },
      ambient: st.dark ? 0.12 : 0.1,
      envIntensity: st.dark ? 0.5 : 0.6,
      exposure: st.dark ? 1.05 : 1.0,
    };
    if (st.outdoor) {
      this.env = {
        skyTop: '#5d8cc4', skyBottom: '#e9dcc8', stars: false, fog: null, fogNear: 0, fogFar: 0,
        sun: { color: '#fff1dc', intensity: 3.4, elev: 48, azim: 215 }, hemi: { sky: '#cfdcec', ground: '#5a5046', intensity: 0.9 },
        ambient: 0.05, envIntensity: 0.6, exposure: 0.75, physicalSky: true,
      };
    }
  }

  /** a Smithsonian room: sizes come with the catalog, so it is built at once */
  private async startSi() {
    const d = this.desc;
    const k = d.theme - SI_BASE;
    const room = SI_ROOMS[k];
    const all = await siEntries(d.theme);
    if (!this.alive) return;
    (this as { theme: Theme }).theme = siTheme(d.theme, all.length);
    const rooms = partitionRooms(all, (e) => new THREE.Vector3(...e.size!), SI_PAGE);
    const pages = rooms.length;
    const items = rooms[d.page] ?? [];
    const exits: Exit[] = [];
    if (d.page + 1 < pages) exits.push({ top: 'continue', label: `${room.name} ${roman(d.page + 2)}`, target: { kind: 'gallery', theme: d.theme, page: d.page + 1, wing: d.wing } });
    const next = (k + 1) % SI_ROOMS.length;
    exits.push({ top: 'Smithsonian', label: SI_ROOMS[next].name, target: { kind: 'gallery', theme: SI_BASE + next, page: 0, wing: d.wing } });
    const m = museum();
    const rel = m.themes.filter((x) => x.collection === room.related);
    const er = new Rng(hashN(d.theme, d.page, 7));
    for (let i = 0; exits.length < 3 && i < 4; i++) {
      const n = rel.length ? er.pick(rel) : m.themes[er.int(0, m.themes.length - 1)];
      if (exits.some((x) => x.target.kind === 'gallery' && x.target.theme === n.id)) continue;
      exits.push({ top: `sand3d · ${n.collection}`, label: n.name, target: { kind: 'gallery', theme: n.id, page: 0, wing: d.wing } });
    }
    er.shuffle(exits);
    await this.build(items.map((e, i) => siMeasured(e, i === 0)), exits, pages);
    await this.settle();
  }

  private async start(per: number) {
    const t = this.theme;
    const all = await themeMembers(t.id);
    await loadThemeSizes(t.shard, t.id, all);
    if (!this.alive) return;
    // rooms are cut from the theme by what fits (size-capped halls, at most two colossal things each)
    const rooms = partitionRooms(all, (e) => measuredFromCache(e)?.real ?? null, per);
    const pages = rooms.length;
    const exits = this.exits(pages);
    const items = rooms[this.desc.page] ?? [];
    const key = `${t.id}:${this.desc.page}`;
    const ids = roomMembers.get(key);
    let measured: Measured[] | null = null;
    const pick = ids ? items.filter((e) => ids.includes(e.id)) : items;
    const cached = pick.map(measuredFromCache);
    if (cached.every(Boolean)) measured = cached as Measured[];
    if (!measured) {
      this.antechamber(items.length, pages);
      measured = await this.measureAll(pick);
      if (!this.alive) {
        for (const m of measured) if (m.model) m.model.object.clear();
        return;
      }
    }
    roomMembers.set(key, measured.map((m) => m.entry.id));
    await this.build(measured, exits, pages);
    // learn the sizes in the rooms behind the doors while you look around
    this.settle().then(() => {
      if (!this.alive) return;
      exits.forEach((ex, i) => {
        if (ex.target.kind !== 'gallery' || isSi(ex.target.theme)) return;
        const tt = museum().themes[ex.target.theme];
        const pp = pageSize(tt.collection);
        themeMembers(tt.id)
          .then((mm) => loadThemeSizes(tt.shard, tt.id, mm).then(() => mm))
          .then((mm) => this.alive && prefetchSizes(mm.slice(0, pp * 2), 1000 + i * 100));
      });
    });
    await this.settle();
  }

  /** measure every object (streaming those we have not seen), with a progress board */
  private measureAll(items: ReturnType<typeof Array.prototype.slice>): Promise<Measured[]> {
    const list = items as Parameters<typeof measure>[0][];
    return new Promise((resolve) => {
      const out: (Measured | null)[] = list.map(() => null);
      let done = 0;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve(out.filter((m): m is Measured => !!m));
      };
      if (!list.length) finish();
      list.forEach((e, i) =>
        measure(e, i)
          .then((m) => (out[i] = m))
          .catch(() => {})
          .finally(() => {
            done++;
            this.progress(done, list.length);
            if (done >= list.length) finish();
          }),
      );
      setTimeout(() => {
        if (out.some(Boolean)) finish();
      }, MEASURE_TIMEOUT);
    });
  }

  private board: THREE.Mesh | null = null;
  private progress(k: number, n: number) {
    const redraw = this.board?.userData.redraw as ((l: unknown) => void) | undefined;
    redraw?.(this.boardLines(k, n));
  }
  private boardLines(k: number, n: number) {
    return [
      { text: this.theme.collection.toUpperCase(), size: 0.11, color: '#bfb39b', weight: 600, font: SANS },
      { text: this.name, size: 0.3, color: '#f4ecdc', font: SERIF },
      { text: `Measuring the objects so the room can be built around them · ${k} / ${n}`, size: 0.085, color: '#d8ccb4', weight: 400, font: SANS },
      { text: 'Everything here is shown at its real size.', size: 0.085, color: '#a99c84', weight: 400, font: SANS },
    ];
  }

  /** a small lobby you wait in while the room is being measured */
  private antechamber(n: number, _pages: number) {
    const g = new THREE.Group();
    const dark = mat('#1b1814', { rough: 1 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), mat('#2a251f', { rough: 0.9 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.001, -3);
    g.add(floor);
    for (const [w, d, x, z] of [[6, 0.2, 0, -6], [0.2, 6, -3, -3], [0.2, 6, 3, -3]] as const) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, 4, d), dark);
      b.position.set(x, 2, z);
      g.add(b);
    }
    for (const x of [-2.1, 2.1]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(1.8, 4, 0.2), dark);
      b.position.set(x * 1.0 + Math.sign(x) * 0.1, 2, 0.1);
      g.add(b);
    }
    this.board = textPlane(this.boardLines(0, n), 4.6, 1.6, '#24201b', 300);
    this.board.position.set(0, 1.7, -5.88);
    g.add(this.board);
    this.point(new THREE.Vector3(0, 3.4, -3.5), '#ffe6c4', 8, 12, 1.6);
    this.group.add(g);
    this.ante = g;
    const r = (x: number, z: number, w: number, d: number): Rect => ({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
    this.cols.push(r(0, -5.8, 6, 0.4), r(-2.9, -3, 0.4, 6), r(2.9, -3, 0.4, 6), r(-2.1, 0.6, 1.8, 0.4), r(2.1, 0.6, 1.8, 0.4));
    doorPortal(this, { wall: 'S', at: 0, w: 2.4, h: 3.2 }, 6, 6, 'Go back', 'to the previous room', 'back');
  }

  /** yield to the browser when this slice of work has run for more than a few ms */
  private sliceT = 0;
  private async slice(force = false) {
    if (!force && performance.now() - this.sliceT < 6) return;
    await new Promise((r) => setTimeout(r, 0));
    this.sliceT = performance.now();
  }

  /**
   * Build the room. Time-sliced: the plan is made at once (this.plan), the shell is built and
   * merged, then the displays one by one, yielding every few milliseconds; `ready` resolves when
   * everything (and every exhibit) is in.
   */
  private async build(measured: Measured[], exits: Exit[], pages: number) {
    this.sliceT = performance.now();
    const st = this.style;
    if (this.ante) {
      this.group.remove(this.ante);
      this.ante.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          (m.material as THREE.MeshBasicMaterial).map?.dispose();
        }
      });
      this.ante = null;
      this.resetRig();
      this.cols.length = 0;
      this.ports.length = 0;
    }
    const r = this.r;
    const units = assemble(measured, st, r.fork(1));
    const plan = (this.plan = planRoom(units, st, r.fork(2), exits.length));
    const mats = makeMats(st, r.fork(3));
    let prio = 0;
    const ctx: Ctx = {
      lv: this, st, r: r.fork(4), m: mats, prio: () => prio++,
      labelBg: st.dark ? '#1c1a17' : st.arch === 'whitecube' ? '#ffffff' : '#f1ebdf',
      labelInk: st.dark ? '#efe6d2' : '#1f1b16',
      labelSub: st.dark ? '#b9ad96' : '#5d5446',
    };
    // see-through doorways: the next room shows through each exit (seamless.ts); this room's own
    // entrance passage is hidden while it is the one being looked into
    const parts = buildShell(this, plan, st, { entry: 0, see: true });
    this.doorway = { pos: new THREE.Vector3(0, 0, ENTRY_Z), yaw: 0, hide: parts.entry ? [parts.entry] : [] };
    const { W, D } = plan;
    const ink = st.ink;

    // doors
    doorPortal(this, plan.doors[0], W, D, 'Go back', 'to the previous room', 'back');
    const signBg = st.dark ? shade(plan.wallColor, 0.6) : st.arch === 'whitecube' || st.outdoor ? '#1d1d1b' : shade(plan.wallColor, 0.55);
    exits.forEach((ex, i) => {
      const d = plan.doors[i + 1];
      if (!d) return;
      doorSign(this, d, W, D, ex.top, ex.label, signBg);
      const end = parts.ends[i + 1];
      doorPortal(this, d, W, D, ex.label, ex.top, ex.target, (shown) => end && (end.visible = !shown));
    });

    this.flush(!!st.outdoor);
    await this.slice(true);

    // displays (the hero first, so it streams first)
    const order = [...plan.floor].sort((a, b) => Number(!!b.u.hero) - Number(!!a.u.hero));
    for (const p of plan.hang) (p.u as Unit & { ceiling?: number }).ceiling = p.ceiling;
    for (const p of [...order, ...plan.wall, ...plan.hang]) {
      if (!this.alive) return;
      p.u.build(ctx, p.f);
      await this.slice();
    }

    this.lighting(plan, ctx);
    this.texts(plan, measured.length, pages, ink);
    // on the museum's floor plan (the minimap)
    registerRoom({
      key: this.mapKey!, desc: this.desc, name: this.name, color: plan.wallColor, W, D, doors: plan.doors,
      exits: [null, ...exits.map((e) => e.target)],
      dots: [...plan.floor, ...plan.wall, ...plan.hang].filter((q) => q.u.items.length).map((q) => [q.f.x, q.f.z] as [number, number]),
    });
    this.flush(!!st.outdoor);
    this.markBuilt();
  }

  private lighting(plan: Plan, c: Ctx) {
    const st = this.style;
    const { W, D, H } = plan;
    // the stand-in light while this room is seen through a doorway, a few metres in, high up
    // modest, and short-ranged: it stands just behind another room's doorway, so it must not flood that room
    this.previewLight(new THREE.Vector3(0, H - 1, -Math.min(7, D / 3)), st.light, Math.min(140, (st.dark ? 1.4 : 0.7) * W * Math.sqrt(D)), Math.min(D, 18));
    this.fillLevel = st.dark ? 0.3 : 0.5;
    if (st.outdoor && st.arch === 'openair') return;
    this.maxSpots = st.dark ? MuseumBase.RIG_SPOTS : 5;
    const high = H > 7.5;
    const trackY = high ? Math.min(H - 0.5, 6.5) : H - 0.06;
    const lit = plan.floor.filter((p) => p.u.items.length);
    const vol = (u: Unit) => (u.hero ? 1e9 : 0) + u.w * u.d * u.h;
    const order = [...lit].sort((a, b) => vol(b.u) - vol(a.u));
    // one track per row, in front of it
    const tracks = new Set<number>();
    for (const p of lit) {
      const tz = Math.min(-0.8, p.f.z + Math.min(2.4, p.u.d / 2 + 1.2));
      const key = Math.round(tz * 2) / 2;
      if (!tracks.has(key)) {
        tracks.add(key);
        this.bx(c.m.fixture, W - 1.2, 0.045, 0.07, 0, trackY - 0.045, key);
        if (high) for (let x = -W / 2 + 1; x <= W / 2 - 1; x += 4) this.bx(c.m.cable, 0.012, H - trackY, 0.012, x, trackY, key);
      }
      (p as typeof p & { tz?: number }).tz = key;
    }
    for (const p of order) {
      const u = p.u;
      const target = p.f.point(u.focus.x, u.focus.y, u.focus.z);
      const tz = (p as typeof p & { tz?: number }).tz!;
      const n = u.w > 3.5 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const dx = n === 1 ? 0.25 : (k - 0.5) * u.w * 0.45;
        const from = new THREE.Vector3(THREE.MathUtils.clamp(target.x + dx, -W / 2 + 0.8, W / 2 - 0.8), trackY - 0.12, tz);
        const aim = target.clone().add(new THREE.Vector3(dx * 0.6, 0, 0));
        this.fixture(from, aim, c.m.fixture, c.m.lens, high ? 1.6 : 1);
        const dist = from.distanceTo(aim);
        const ang = THREE.MathUtils.clamp(Math.atan((u.glow * 0.8 + 0.3) / dist) * 1.15, 0.12, 0.7);
        if (k === 0 || u.hero) this.spot(from, aim, { angle: ang, boost: (st.dark ? 9 : 4) * (u.hero ? 1.5 : 1), color: st.light });
      }
      if (u.glow) this.pool(p.f.x, 0, p.f.z, u.glow * (st.dark ? 1.1 : 0.9), st.light, st.dark ? 0.3 : 0.12);
    }
    // wall-mounted things get a spot of their own in dark rooms
    for (const p of plan.wall.filter((q) => q.u.type === 'mount')) {
      const target = p.f.point(p.u.focus.x, p.u.focus.y, p.u.focus.z);
      const from = p.f.point(p.u.focus.x, trackY - 0.12, Math.min(2.2, D / 3));
      from.y = trackY - 0.12;
      this.fixture(from, target, c.m.fixture, c.m.lens);
      if (st.dark) this.spot(from, target, { angle: 0.35, boost: 6, color: st.light });
    }
    // bright rooms: a little fill so the far corners are not flat
    if (!st.dark) {
      const n = Math.min(3, Math.max(1, Math.round(D / 14)));
      for (let i = 0; i < n; i++) {
        this.point(new THREE.Vector3(0, H - 1, -D * ((i + 0.5) / n)), st.light, 0.6 * W * D ** 0.5, Math.max(W, D) * 1.4, 1.2);
      }
    }
  }

  private texts(plan: Plan, count: number, pages: number, ink: string) {
    const t = this.theme;
    const { W, D } = plan;
    const st = this.style;
    // the room title, in vinyl lettering on the far wall
    const nDoor = plan.doors.find((d) => d.wall === 'N' && Math.abs(d.at) < 2.5);
    const nWallTop = Math.max(0, ...plan.wall.filter((p) => Math.abs(p.f.z + D) < 0.01).map((p) => p.u.h));
    const y = Math.max(nDoor ? nDoor.h + 1.75 : 0, nWallTop + 0.9, 3.0);
    const tw = Math.min(W - 1.5, 12);
    if (y + 0.6 < plan.Hw || st.outdoor) {
      const title = textPlane([
        { text: t.name, size: 0.5, color: ink, font: SERIF },
        { text: `${t.collection} · ${t.size} object${t.size === 1 ? '' : 's'}${pages > 1 ? ` · room ${this.desc.page + 1} of ${pages}` : ''}`, size: 0.13, color: shade(ink, 0.8), weight: 400, font: SANS },
      ], tw, 1.1, null, 160);
      title.position.set(0, Math.min(y, plan.Hw - 0.6), -D + 0.03);
      this.group.add(title);
    }
    // the introduction panel by the entrance, facing into the room
    const panelBg = st.dark ? '#14120f' : st.arch === 'whitecube' ? '#ffffff' : '#efe8da';
    const pInk = st.dark ? '#efe6d2' : '#1f1b16';
    const intro = textPlane([
      { text: t.collection.toUpperCase(), size: 0.07, color: shade(pInk, 0.7), weight: 700, font: SANS },
      { text: t.name, size: 0.17, color: pInk, font: SERIF },
      { text: `${count} objects in this room, every one at its real size.`, size: 0.065, color: pInk, weight: 400, font: SANS },
      { text: t.words.length ? `What they share: ${t.words.slice(0, 6).join(', ')}` : '', size: 0.06, color: shade(pInk, 0.75), weight: 400, font: SANS },
      { text: 'Words found in their sand3d programs and titles.', size: 0.05, color: shade(pInk, 0.6), weight: 400, font: SANS },
      { text: 'Look at anything and press E to read its program.', size: 0.05, color: shade(pInk, 0.6), weight: 400, font: SANS },
    ], 2.4, 1.2, panelBg, 420, 'left');
    intro.position.set(-3.4, 1.55, -0.03);
    intro.rotation.y = Math.PI;
    this.group.add(intro);
  }
}
