import * as THREE from 'three';
import type { Level, LevelDesc, Portal } from './level';
import { FloorLevel, LIFT, liftDisplay, panelTexture, floorLabel, portalActions, toWorld, type FloorDesc } from './rooms/vertical';
import { descKey, type Seamless, type Slot } from './seamless';
import type { Player } from './player';
import { Kit } from './rooms/kit';
import { M } from './rooms/mats';
import { mat } from './build';
import { hashN } from './rng';

/**
 * Vertical circulation in play (see docs/research/vertical.md):
 *
 *  - stairs: past +0.55·H on the stair you are on the floor above (same x/z, y − H, one frame),
 *    below −0.55·H on the floor below. The floors above and below are prefetched (seamless.ts,
 *    time-sliced) while you are near the stair and shown at ±H through the stairwell (their lights
 *    taken out so the scene's light count never changes, their copy of the stair hidden).
 *  - elevators: E on a call button brings the car (indicator counting), the hall and car doors slide
 *    open, E on the car panel picks the next floor (number keys any floor, L the lobby), the doors
 *    close and the destination is built while you ride; the ride ends when it is ready (never
 *    before the travel time), the level is switched behind the closed doors and they open again.
 *
 * main.ts calls update() once a frame and, when it returns a switch, makes it with seamSwitch()
 * and then calls afterSwitch().
 */

type LiftState = 'idle' | 'coming' | 'opening' | 'open' | 'closing' | 'riding';

export interface FloorSwitch {
  desc: LevelDesc;
  /** where the player stands in the new level's frame */
  pos: THREE.Vector3;
  yaw: number;
  /** add to the camera so this frame already draws from the new frame */
  dy: number;
  why: 'stairs' | 'lift';
}

export interface VerticalOpts {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  seam: Seamless;
  player: Player;
  aimed: () => Portal | null;
}

const ease = (t: number) => t * t * (3 - 2 * t);

export class Vertical {
  stats = { stairs: 0, rides: 0, forced: 0, shows: 0, maxSwitchMs: 0, log: [] as string[] };
  private o: VerticalOpts;
  private level: FloorLevel | null = null;
  private building = '';
  private shown = new Map<Slot, number>();
  // the car
  state: LiftState = 'idle';
  lift = 0;
  carFloor = 0;
  private t = 0;
  private from = 0;
  private to = 0;
  private dur = 0;
  private open = 0;
  sel: number | null = null;
  private idle = 0;
  private typed = '';
  private typedT = 0;
  private car: THREE.Group | null = null;
  private carType = '';
  private carL: THREE.Object3D | null = null;
  private carR: THREE.Object3D | null = null;
  private panelMat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.3, emissive: '#ffffff', emissiveIntensity: 0.15 });
  private panelKey = '';
  private panel: Portal = { box: new THREE.Box3(), label: 'Choose a floor', target: 'inspect' };
  private light = new THREE.PointLight('#fff2dc', 0, 5, 2);
  private keysOn = false;

  constructor(o: VerticalOpts) {
    this.o = o;
    // the car's light is always in the scene (intensity 0 when unused) so the light count is constant
    this.light.name = 'lift-light';
    o.scene.add(this.light);
    portalActions.set(this.panel, () => this.choose());
    addEventListener('keydown', (e) => {
      if (!this.keysOn || !this.level) return;
      if (e.code === 'KeyE' || e.code === 'Enter') {
        const a = this.o.aimed();
        const act = a ? portalActions.get(a) : undefined;
        if (act) act();
      } else if (this.level.lifts.length && this.inCar(this.level) && (this.state === 'open' || this.state === 'closing' || this.state === 'opening')) {
        const m = /^(Digit|Numpad)(\d)$/.exec(e.code);
        if (m) {
          this.typed = (this.typedT > 0 ? this.typed : '') + m[2];
          this.typedT = 1.2;
          const n = parseInt(this.typed, 10);
          const f = Math.max(0, Math.min(this.level.floors - 1, n - 1));
          this.select(f);
        } else if (e.code === 'KeyL') this.select(0);
      }
    });
  }

  /** the walkable height under (x, z) near y in this level (stairs); 0 elsewhere */
  ground(level: Level | undefined, x: number, z: number, y: number) {
    return level instanceof FloorLevel ? level.ground(x, z, y) : 0;
  }

  update(dt: number, level: Level, active: boolean): FloorSwitch | null {
    this.keysOn = active;
    if (!(level instanceof FloorLevel)) {
      this.leave();
      return null;
    }
    if (level !== this.level) this.adopt(level);
    const lv = level, p = this.o.player.pos, H = lv.d.H;
    this.typedT -= dt;
    // 1. the lift (may end a ride with a switch)
    const ride = lv.lifts.length ? this.liftStep(dt, lv) : null;
    if (ride) return ride;
    // 2. stairs
    if (this.state !== 'riding') {
      const dir = p.y > 0.55 * H ? 1 : p.y < -0.55 * H ? -1 : 0;
      const n = dir ? lv.neighbour(dir) : null;
      if (n) {
        if (!this.o.seam.ready(n)) this.stats.forced++;
        this.stats.stairs++;
        return { desc: n, pos: new THREE.Vector3(p.x, p.y - dir * H, p.z), yaw: this.o.player.yaw, dy: -dir * H, why: 'stairs' };
      }
    }
    // 3. the floors above and below, through the stairwell
    this.neighbours(lv);
    return null;
  }

  /** after main.ts switched levels for us (or for anyone): take over the new floor */
  afterSwitch(level: Level, sw?: FloorSwitch) {
    if (!(level instanceof FloorLevel)) return;
    for (const s of [...this.shown.keys()]) if (s.level === level) this.shown.delete(s);
    const old = this.level;
    this.adopt(level);
    if (old && old !== level) {
      old.rideTarget = null;
      old.extra = [];
    }
    if (sw?.why === 'lift') {
      this.carFloor = this.to;
      this.state = 'opening';
      this.t = 0;
      this.sel = null;
      this.stats.rides++;
    }
    this.placeCar(level);
    this.neighbours(level);
  }

  // ------------------------------------------------------------ levels

  private adopt(lv: FloorLevel) {
    const key = `${lv.type}|${lv.desc.seed}`;
    if (key !== this.building) {
      // a new building: the car waits on some floor, doors shut
      this.building = key;
      this.state = 'idle';
      this.lift = 0;
      this.carFloor = hashN(lv.desc.seed, 8) % Math.max(1, lv.floors);
      this.open = 0;
      this.sel = null;
    }
    if (this.level && this.level !== lv) this.level.extra = [];
    this.level = lv;
    lv.well.visible = true;
    const s = this.o.seam.slotOf(lv);
    if (s) s.compiled = 'yes'; // it has been drawn: its programs exist
    lv.lifts.forEach((l, i) => portalActions.set(l.call, () => this.call(i)));
    if (this.state !== 'riding' && this.state !== 'opening' && Math.abs(this.carFloor - lv.floor) > 0.01) this.open = 0;
    for (const l of lv.lifts) l.open = 0;
    this.setDoors(lv);
  }

  private leave() {
    for (const s of [...this.shown.keys()]) this.hide(s);
    if (this.car) this.car.removeFromParent();
    this.light.intensity = 0;
    if (this.level) this.level.extra = [];
    this.level = null;
  }

  private neighbours(lv: FloorLevel) {
    const want = new Map<Slot, number>();
    const p = this.o.player.pos;
    if (this.state !== 'riding' && lv.nearStair(p)) {
      for (const dir of [1, -1]) {
        const n = lv.neighbour(dir);
        if (!n) continue;
        const s = this.o.seam.slots.get(descKey(n));
        if (s?.ready && s.level !== lv && s.level instanceof FloorLevel) want.set(s, dir);
      }
    }
    for (const [s, dir] of [...this.shown]) if (want.get(s) !== dir) this.hide(s);
    let up = false, down = false;
    for (const [s, dir] of want) {
      if (this.show(s, dir, lv)) {
        if (dir > 0) up = true;
        else down = true;
      }
    }
    lv.setStub(1, up);
    lv.setStub(-1, down);
  }

  private show(s: Slot, dir: number, lv: FloorLevel) {
    const g = s.level.group;
    const fl = s.level as FloorLevel;
    if (!s.stripped.length) {
      g.traverse((o) => {
        if ((o as THREE.Light).isLight && o.parent) s.stripped.push([o as THREE.Light, o.parent]);
      });
      for (const [l] of s.stripped) l.removeFromParent();
    }
    fl.well.visible = false;
    for (const l of fl.lifts) l.open = 0;
    fl.extra = [];
    g.position.set(0, dir * lv.d.H, 0);
    g.quaternion.identity();
    g.updateMatrixWorld(true);
    if (s.compiled === 'no') {
      s.compiled = 'pending';
      const t = performance.now();
      this.o.renderer.compileAsync(g, this.o.camera, this.o.scene).then(
        () => {
          s.compiled = 'yes';
          this.log(`compiled ${fl.name} in ${(performance.now() - t).toFixed(0)} ms`);
        },
        () => (s.compiled = 'yes'),
      );
    }
    if (s.compiled !== 'yes') return false;
    if (this.shown.get(s) !== dir) {
      this.o.scene.add(g);
      this.shown.set(s, dir);
      this.stats.shows++;
    }
    return true;
  }

  private hide(s: Slot) {
    this.shown.delete(s);
    if (this.level && s.level === this.level) return;
    s.level.group.removeFromParent();
  }

  private log(s: string) {
    this.stats.log.push(s);
    if (this.stats.log.length > 30) this.stats.log.shift();
    console.info('[vertical]', s);
  }

  // ------------------------------------------------------------ the car

  private inCar(lv: FloorLevel) {
    const l = lv.lifts[this.lift];
    if (!l) return false;
    const p = this.o.player.pos, f = l.frame;
    const dx = p.x - f.x, dz = p.z - f.z, c = Math.cos(f.r), s = Math.sin(f.r);
    const lx = c * dx - s * dz, lz = s * dx + c * dz;
    return Math.abs(lx) < LIFT.w / 2 && lz < -LIFT.depth - 0.05 && lz > -LIFT.depth - LIFT.d;
  }
  private inDoorway(lv: FloorLevel) {
    const l = lv.lifts[this.lift];
    if (!l) return false;
    const p = this.o.player.pos, f = l.frame;
    const dx = p.x - f.x, dz = p.z - f.z, c = Math.cos(f.r), s = Math.sin(f.r);
    const lx = c * dx - s * dz, lz = s * dx + c * dz;
    return Math.abs(lx) < LIFT.door / 2 + 0.2 && lz < 0.35 && lz > -LIFT.depth - 0.4;
  }

  /** E on a call button */
  call(i: number) {
    const lv = this.level;
    if (!lv || this.state === 'riding') return;
    if (this.lift === i && Math.abs(this.carFloor - lv.floor) < 0.01 && (this.state === 'open' || this.state === 'opening')) return;
    if (this.lift !== i) {
      this.open = 0;
      this.setDoors(lv);
    }
    this.lift = i;
    this.from = this.carFloor;
    this.to = lv.floor;
    this.dur = 0.5 + Math.min(6, Math.abs(this.to - this.from) / lv.spec.speed);
    this.t = 0;
    this.state = Math.abs(this.to - this.from) < 0.01 ? 'opening' : 'coming';
    this.sel = null;
  }

  /** E on the car panel: the next floor (again for the one after) */
  choose() {
    const lv = this.level;
    if (!lv) return;
    let f = this.sel === null ? (lv.floor + 1 < lv.floors ? lv.floor + 1 : 0) : (this.sel + 1) % lv.floors;
    if (f === lv.floor) f = (f + 1) % lv.floors;
    this.select(f);
  }
  private select(f: number) {
    const lv = this.level;
    if (!lv || f === lv.floor) return;
    this.sel = f;
    this.idle = 0;
    if (this.state === 'closing') this.state = 'opening';
    // start building the destination right away
    const d: FloorDesc = { ...lv.desc, floor: f };
    lv.rideTarget = d;
    if (!this.o.seam.slots.has(descKey(d))) this.o.seam.prebuild(d);
  }

  private liftStep(dt: number, lv: FloorLevel): FloorSwitch | null {
    const here = Math.abs(this.carFloor - lv.floor) < 0.01;
    switch (this.state) {
      case 'coming': {
        this.t += dt;
        const k = Math.min(1, this.t / this.dur);
        this.carFloor = this.from + (this.to - this.from) * ease(k);
        if (k >= 1) {
          this.carFloor = this.to;
          this.state = 'opening';
        }
        break;
      }
      case 'opening':
        this.open = Math.min(1, this.open + dt / 0.9);
        if (this.open >= 1) {
          this.state = 'open';
          this.idle = 0;
        }
        break;
      case 'open': {
        this.idle += dt;
        const inside = this.inCar(lv);
        if ((this.sel !== null && inside && this.idle > 1.4 && this.typedT <= 0) || (!inside && this.idle > 7)) this.state = 'closing';
        break;
      }
      case 'closing':
        if (this.inDoorway(lv) && !this.inCar(lv)) {
          this.state = 'opening';
          break;
        }
        this.open = Math.max(0, this.open - dt / 0.8);
        if (this.open <= 0) {
          if (this.inCar(lv) && this.sel !== null && this.sel !== lv.floor) {
            this.state = 'riding';
            this.from = lv.floor;
            this.to = this.sel;
            this.dur = 1.6 + Math.abs(this.to - this.from) / lv.spec.speed;
            this.t = 0;
            this.select(this.to);
          } else {
            this.state = 'idle';
            this.sel = null;
            lv.rideTarget = null;
          }
        }
        break;
      case 'riding': {
        this.t += dt;
        const d: FloorDesc = { ...lv.desc, floor: this.to };
        const ready = this.o.seam.ready(d);
        let k = Math.min(1, this.t / this.dur);
        // the ride lasts as long as the build: hold short of the last floor until it is ready
        if (!ready) k = Math.min(k, 0.93);
        this.carFloor = this.from + (this.to - this.from) * ease(k);
        // a little lift and settle at the start and end, a faint hum of vibration
        const cam = this.o.camera;
        const a = this.t < 0.7 ? -Math.sin((this.t / 0.7) * Math.PI) * 0.025 : this.t > this.dur - 0.7 && this.t < this.dur ? Math.sin(((this.dur - this.t) / 0.7) * Math.PI) * 0.02 : 0;
        cam.position.y += a * Math.sign(this.to - this.from) + Math.sin(this.t * 37) * 0.0015;
        if ((this.t >= this.dur && ready) || this.t > this.dur + 10) {
          if (!ready) this.stats.forced++;
          const p = this.o.player.pos;
          return { desc: d, pos: p.clone(), yaw: this.o.player.yaw, dy: 0, why: 'lift' };
        }
        break;
      }
      case 'idle':
        break;
    }
    void here;
    this.setDoors(lv);
    this.placeCar(lv);
    // indicators
    const dir = this.state === 'riding' || this.state === 'coming' ? Math.sign(this.to - this.from) : 0;
    liftDisplay.draw(floorLabel(lv.type, Math.round(this.carFloor), lv.floors), dir);
    const frac = lv.floors > 1 ? this.carFloor / (lv.floors - 1) : 0;
    for (const l of lv.lifts) if (l.needle) l.needle.rotation.z = Math.PI * 0.4 - frac * Math.PI * 0.8;
    return null;
  }

  private setDoors(lv: FloorLevel) {
    const w = LIFT.door;
    const atThis = Math.abs(this.carFloor - lv.floor) < 0.01 && this.state !== 'riding' && this.state !== 'coming';
    lv.lifts.forEach((l, i) => {
      l.open = i === this.lift && atThis ? this.open : 0;
      const o = ease(l.open);
      l.left.position.x = -w / 4 - o * (w / 2 - 0.03);
      l.right.position.x = w / 4 + o * (w / 2 - 0.03);
    });
    if (this.carL && this.carR) {
      const o = ease(this.state === 'riding' ? 0 : this.open);
      this.carL.position.x = -w / 4 - o * (w / 2 - 0.03);
      this.carR.position.x = w / 4 + o * (w / 2 - 0.03);
    }
  }

  private placeCar(lv: FloorLevel) {
    const l = lv.lifts[this.lift];
    const visible = !!l && (this.state === 'riding' || (Math.abs(this.carFloor - lv.floor) < 0.01 && this.state !== 'coming'));
    if (!visible || !l) {
      if (this.car) this.car.removeFromParent();
      this.light.intensity = 0;
      lv.extra = [];
      return;
    }
    const car = this.carFor(lv);
    car.position.set(l.frame.x, 0, l.frame.z);
    car.rotation.set(0, l.frame.r, 0);
    if (car.parent !== this.o.scene) this.o.scene.add(car);
    car.updateMatrixWorld(true);
    const [lx, lz] = toWorld(l.frame, 0, -LIFT.depth - LIFT.d / 2);
    this.light.position.set(lx, 2.15, lz);
    this.light.intensity = 2.2;
    // the panel: a portal while the car is here
    const a = toWorld(l.frame, LIFT.door / 2 - 0.05, -LIFT.depth + 0.05), b = toWorld(l.frame, LIFT.w / 2, -LIFT.depth - 0.4);
    this.panel.box.min.set(Math.min(a[0], b[0]), 0.85, Math.min(a[1], b[1]));
    this.panel.box.max.set(Math.max(a[0], b[0]), 1.75, Math.max(a[1], b[1]));
    const label = (f: number) => floorLabel(lv.type, f, lv.floors);
    this.panel.label = this.sel !== null ? `Going to ${label(this.sel)} — E for the next floor` : `Choose a floor (E: ${label(lv.floor + 1 < lv.floors ? lv.floor + 1 : 0)})`;
    this.panel.sub = 'number keys pick any floor · L the lobby';
    lv.extra = this.state === 'riding' ? [] : [this.panel];
    const key = `${lv.type}|${lv.floors}|${this.sel}|${Math.round(this.carFloor)}`;
    if (key !== this.panelKey) {
      this.panelKey = key;
      const { tex } = panelTexture(lv.type, lv.floors, this.sel ?? -1, Math.round(this.carFloor));
      this.panelMat.map?.dispose();
      this.panelMat.map = tex;
      this.panelMat.emissiveMap = tex;
      this.panelMat.needsUpdate = true;
    }
  }

  /** the car: wood-panelled (pre-war) or stainless (office, loft), built once per type */
  private carFor(lv: FloorLevel) {
    if (this.car && this.carType === lv.type) return this.car;
    if (this.car) this.car.removeFromParent();
    const k = new Kit();
    const W = LIFT.w, D = LIFT.d, Hc = LIFT.h, z0 = -LIFT.depth, z1 = -LIFT.depth - D, w = LIFT.door;
    const prewar = lv.type === 'prewar';
    const wall = prewar ? M.walnut('#a07850') : lv.type === 'loft' ? mat('#8a8e90', { rough: 0.6, metal: 0.5 }) : M.steel();
    const floorM = prewar ? M.checker() : mat('#2a2a2c', { rough: 0.8 });
    k.box(floorM, W, 0.02, D, 0, 0, (z0 + z1) / 2);
    k.box(wall, 0.04, Hc, D, -W / 2 - 0.02, 0, (z0 + z1) / 2);
    k.box(wall, 0.04, Hc, D, W / 2 + 0.02, 0, (z0 + z1) / 2);
    k.box(wall, W + 0.08, Hc, 0.04, 0, 0, z1 - 0.02);
    // front either side of the door, and the header
    for (const sx of [-1, 1]) k.box(wall, (W - w) / 2, Hc, 0.04, sx * (W + w) / 4, 0, z0 - 0.02);
    k.box(wall, w, Hc - 2.2, 0.04, 0, 2.2, z0 - 0.02);
    // ceiling with a light panel
    k.box(M.matte('#e8e4dc'), W, 0.03, D, 0, Hc, (z0 + z1) / 2);
    k.unshadowed(() => k.box(M.diffuser(), W - 0.4, 0.01, D - 0.4, 0, Hc - 0.012, (z0 + z1) / 2));
    // handrail on three sides
    const rail = prewar ? M.brass() : M.chrome();
    k.rod(rail, 0.02, W - 0.2, 0, 0.92, z1 + 0.06, 'x', 8);
    for (const sx of [-1, 1]) k.rod(rail, 0.02, D - 0.3, sx * (W / 2 - 0.06), 0.92, (z0 + z1) / 2, 'z', 8);
    if (prewar) {
      // raised panels on the wood walls
      for (const sx of [-1, 1]) for (const zz of [z1 + D * 0.25, z1 + D * 0.75]) k.box(M.walnut('#8a6040'), 0.012, 1.1, D * 0.4, sx * (W / 2 - 0.005), 1.05, zz);
    }
    // sill
    k.box(M.steel(), w, 0.015, 0.06, 0, 0, z0 - 0.03);
    const g = new THREE.Group();
    g.name = 'lift-car';
    k.finish(g);
    // doors
    const leafGeo = new THREE.BoxGeometry(w / 2 + 0.02, 2.19, 0.03);
    leafGeo.translate(0, 2.19 / 2, 0);
    const dm = prewar ? M.brass() : M.steel();
    const L = new THREE.Mesh(leafGeo, dm), R = new THREE.Mesh(leafGeo, dm);
    L.position.set(-w / 4, 0, z0 - 0.06);
    R.position.set(w / 4, 0, z0 - 0.06);
    g.add(L, R);
    // the panel and the indicator over the door (inside)
    const pnl = new THREE.Mesh(new THREE.PlaneGeometry(0.2, Math.min(0.75, 0.12 + lv.floors * 0.03)), this.panelMat);
    pnl.position.set((W + w) / 4, 1.3, z0 - 0.045);
    pnl.rotation.y = Math.PI;
    g.add(pnl);
    const ind = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.11), liftDisplay.mat);
    ind.position.set(0, 2.32, z0 - 0.045);
    ind.rotation.y = Math.PI;
    g.add(ind);
    this.car = g;
    this.carType = lv.type;
    this.carL = L;
    this.carR = R;
    this.panelKey = '';
    return g;
  }
}
