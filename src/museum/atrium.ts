import * as THREE from 'three';
import { mat } from '../build';
import { museum } from '../museumData';
import type { RemoteEntry } from '../remote';
import { Rng } from '../rng';
import { Frame, MuseumBase } from './base';
import { makeMats, platform, vitrine, hang, type Ctx } from './displays';
import type { Door, Plan } from './plan';
import { buildShell, doorPortal, doorSign } from './shell';
import { measure, type Measured } from './sizes';
import { STYLES, type Style } from './style';
import { textPlane, SANS } from './text';

const PALETTE = ['#7d2e2e', '#2e4d7d', '#2e6b55', '#6b4a2e', '#4d2e6b', '#7d6a2e', '#2e6b7d', '#5b5b5b', '#8a3d5c', '#3d5c2e'];
export function collectionColor(c: string) {
  let h = 0;
  for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** The great hall (after the British Museum's Great Court): six wings, a giant in the middle. */
export class AtriumLevel extends MuseumBase {
  name = 'Atrium';
  constructor() {
    super();
    const W = 30, D = 30, H = 11;
    const m = museum();
    const wings = m.wings.slice(0, 6);
    const st: Style = { ...STYLES.period, walls: ['#e6dccb'], trim: '#efe7d6', plinth: ['#2b2b2e', '#e8e0d0'], dark: false };
    const doors: Door[] = [
      { wall: 'N', at: -7, w: 3, h: 4.4 },
      { wall: 'N', at: 7, w: 3, h: 4.4 },
      { wall: 'W', at: -21, w: 3, h: 4.4 },
      { wall: 'W', at: -9, w: 3, h: 4.4 },
      { wall: 'E', at: -21, w: 3, h: 4.4 },
      { wall: 'E', at: -9, w: 3, h: 4.4 },
    ];
    const plan: Plan = { W, D, H, Hw: H, floor: [], wall: [], hang: [], doors, ceiling: 'lantern', floorKind: 'marble', wallColor: '#e6dccb', rows: [] };
    buildShell(this, plan, st);
    this.env.hemi.intensity = 1.05;
    this.spawn.pos.set(0, 0, -3.5);
    this.spawn.yaw = 0;
    const r = new Rng(Date.now() >>> 0);
    const mats = makeMats(st, r);
    let prio = 0;
    const ctx: Ctx = { lv: this, st, r, m: mats, prio: () => prio++, labelBg: '#f1ebdf', labelInk: '#1f1b16', labelSub: '#5d5446' };

    // columns
    const stone = mat('#efe8db', { rough: 0.6 });
    for (const x of [-8.5, 8.5]) for (const z of [-24, -15, -6]) {
      this.cy(stone, 0.5, H, x, 0, z);
      this.bx(stone, 1.3, 0.4, 1.3, x, 0, z);
      this.bx(stone, 1.3, 0.5, 1.3, x, H - 0.5, z);
      this.cols.push({ minX: x - 0.65, maxX: x + 0.65, minZ: z - 0.65, maxZ: z + 0.65 });
    }

    // title on the north wall, credits on the south
    const title = textPlane([
      { text: 'THE SAND3D MUSEUM', size: 0.62, color: '#2b2217' },
      { text: `${m.total.toLocaleString()} objects, each one written as a short program, each shown at its real size`, size: 0.22, color: '#5a4a35', weight: 400 },
      { text: 'Every doorway leads to rooms of similar things. There is no last room.', size: 0.19, color: '#6b5a42', weight: 400 },
    ], 13, 2.4, null, 128);
    title.position.set(0, 7.2, -D + 0.03);
    this.group.add(title);
    const credit = textPlane([
      { text: 'Objects: sand3d by Sandflow · datasets on Hugging Face under CC BY 4.0', size: 0.1, color: '#5a4a35', weight: 400, font: SANS },
      { text: 'Look at anything and press E to read its program', size: 0.1, color: '#5a4a35', weight: 400, font: SANS },
    ], 8, 0.7, null);
    credit.position.set(0, 3.4, -0.03);
    credit.rotation.y = Math.PI;
    this.group.add(credit);

    // preview spaces beside each wing's door, facing into the hall
    const spots: Frame[] = [new Frame(-12, -26.5, Math.PI / 4), new Frame(12, -26.5, -Math.PI / 4), new Frame(-12.3, -15.5, Math.PI / 2), new Frame(-12.3, -3.5, Math.PI / 2), new Frame(12.3, -15.5, -Math.PI / 2), new Frame(12.3, -3.5, -Math.PI / 2)];
    const loads: Promise<unknown>[] = [];
    let hung = false;
    wings.forEach((w, i) => {
      const d = doors[i];
      const theme = m.themes[w.theme];
      const color = collectionColor(theme.collection);
      doorSign(this, d, W, D, `Wing ${i + 1}`, w.name, color);
      doorPortal(this, d, W, D, `Enter the ${w.name} wing`, w.blurb, { kind: 'gallery', theme: w.theme, page: 0, wing: w.name });
      const f = spots[i];
      const banner = textPlane([{ text: w.name, size: 0.2, color: '#fff' }, { text: w.blurb, size: 0.09, color: '#e9dcc3', weight: 400, font: SANS }], 2.4, 0.8, color);
      banner.position.copy(f.point(0, 2.9, -1.7));
      banner.rotation.y = f.rot;
      this.group.add(banner);
      // measure the previews, then show what fits at real size
      loads.push(
        Promise.allSettled(w.preview.slice(0, 3).map((e, k) => measure(e, k))).then((res) => {
          if (!this.alive) return;
          const ms = res.filter((x): x is PromiseFulfilledResult<Measured> => x.status === 'fulfilled').map((x) => x.value);
          const small = ms.filter((x) => Math.max(x.real.x, x.real.z) <= 0.9 && x.real.y <= 1.1);
          const big = ms.find((x) => !small.includes(x) && Math.max(x.real.x, x.real.z) <= 4.2 && x.real.y <= 5);
          const air = ms.find((x) => /aircraft|spacecraft/.test(x.entry.family) && Math.max(x.real.x, x.real.z) <= 24 && Math.max(x.real.x, x.real.z) > 4.2);
          if (big) platform({ st, r }, big, false, 'rope').build(ctx, f);
          else if (small.length) vitrine(small.slice(0, 3), Math.min(0.95, Math.max(...small.map((x) => Math.max(x.real.x, x.real.z))) + 0.1)).unit.build(ctx, f);
          if (air && !hung) {
            hung = true;
            const u = hang(air, 0.08);
            (u as typeof u & { ceiling?: number }).ceiling = H + 1.2;
            u.build(ctx, new Frame(0, -16, 0, Math.max(5.2, H - 1.5 - air.real.y)));
          }
          this.flush();
        }),
      );
    });

    // centrepiece: a giant from a random wing, on a turntable if it fits there
    this.cy(stone, 2.6, 0.5, 0, 0, -16);
    this.cy(mat('#2b2b2e', { rough: 0.3, metal: 0.4 }), 2.3, 0.55, 0, 0, -16);
    this.cols.push({ minX: -2.4, maxX: 2.4, minZ: -18.4, maxZ: -13.6 });
    const pool = r.shuffle(wings.flatMap((w) => w.preview)) as RemoteEntry[];
    loads.push(this.hero(pool.slice(0, 5), ctx));
    this.flush();
    this.ready = Promise.allSettled(loads).then(() => this.settle());
  }

  private async hero(pool: RemoteEntry[], ctx: Ctx) {
    for (const e of pool) {
      let mm: Measured;
      try {
        mm = await measure(e, -1);
      } catch {
        continue;
      }
      if (!this.alive) return;
      const L = Math.max(mm.real.x, mm.real.z);
      if (L <= 4.4 && mm.real.y <= 7) {
        this.exhibit(mm, new Frame(0, -16), 0, 0.55, 0, 0, { prio: -1, spin: Math.hypot(mm.real.x, mm.real.z) <= 4.4 ? 0.12 : 0 });
        this.spot(new THREE.Vector3(0, 10.5, -11), new THREE.Vector3(0, 0.55 + mm.real.y / 2, -16), { angle: 0.4, boost: 5 });
        return;
      }
      if (mm.model) mm.model.object.clear();
    }
  }
}
