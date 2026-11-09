import * as THREE from 'three';
import './env';
import { test, expect, between } from './qa';
import { Frame, type MuseumBase } from '../src/museum/base';
import { plinth, cluster, vitrine, tableCase, wallCase, drawers, makeMats, type Ctx, type Unit } from '../src/museum/displays';
import { STYLES } from '../src/museum/style';
import { Rng } from '../src/rng';
import type { Measured } from '../src/museum/sizes';
import type { RemoteEntry } from '../src/remote';

function item(size = 0.08): Measured {
  const real = new THREE.Vector3(size, size, size);
  return { entry: { id: `case-${size}`, title: 'Small exhibit', ds: 'cad', family: 'part', entry: '', author: '', joints: 0 } as RemoteEntry, raw: real.clone(), real, k: 1 };
}
function record(unit: Unit) {
  const boxes: { material: THREE.Material; w: number; h: number; d: number; at: THREE.Vector3 }[] = [];
  const exhibits: { m: Measured; at: THREE.Vector3 }[] = [];
  const lv = {
    group: new THREE.Group(), col() {}, pool() {}, cy() {}, rod() {}, geo() {},
    bx(material: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, f: Frame) { boxes.push({ material, w, h, d, at: f.point(x, y, z) }); },
    exhibit(m: Measured, f: Frame, x: number, y: number, z: number) { exhibits.push({ m, at: f.point(x, y, z) }); },
  };
  const r = new Rng(1), st = STYLES.study;
  const c: Ctx = { lv: lv as unknown as MuseumBase, st, r, m: makeMats(st, r), prio: () => 0, labelBg: '#fff', labelInk: '#111', labelSub: '#444' };
  unit.build(c, new Frame(0, 0, 0));
  return { boxes, exhibits, c };
}

test('small objects in every glass display are raised into a standing viewing band', () => {
  const m = item();
  const units = [plinth(m, true, false), plinth(m, false, true), cluster([m], new Rng(1), true), vitrine([m], 0.6).unit, tableCase([m], 1.8).unit, wallCase([m], 1.8, false).unit, wallCase([m], 1.8, true).unit, drawers([item(0.025)]).unit];
  for (const unit of units) {
    const { exhibits } = record(unit);
    expect(exhibits.length === unit.items.length && exhibits.length > 0, `${unit.type}: exhibits preserved`);
    for (const e of exhibits) between(e.at.y + e.m.real.y / 2, 1.3, 1.85, `${unit.type} exhibit centre`);
  }
});

test('glass roofs have no opaque cap or light panel over the exhibits', () => {
  const m = item();
  const units = [plinth(m, true, false), vitrine([m], 0.6).unit, tableCase([m], 1.8).unit, wallCase([m], 1.8, false).unit];
  for (const unit of units) {
    const { boxes, exhibits, c } = record(unit);
    const glass = boxes.filter((b) => b.material === c.m.glass);
    expect(glass.length > 0, `${unit.type}: glass remains present`);
    const roof = Math.max(...glass.map((b) => b.at.y + b.h));
    for (const e of exhibits) {
      const blocking = boxes.filter((b) => !b.material.transparent && b.at.y + b.h >= roof - 0.04 && b.at.y <= roof + 0.03 && Math.abs(b.at.x - e.at.x) < b.w / 2 && Math.abs(b.at.z - e.at.z) < b.d / 2);
      expect(blocking.length === 0, `${unit.type}: opaque roof over the object`);
    }
    expect((c.m.glass as THREE.MeshStandardMaterial).opacity <= 0.1 && !(c.m.glass as THREE.MeshStandardMaterial).depthWrite, 'glass is clear and does not hide objects in depth');
  }
});

test('case packing returns objects that do not fit instead of losing them', () => {
  const items = Array.from({ length: 20 }, (_, i) => item(i % 3 ? 0.16 : 0.65));
  for (const result of [vitrine(items, 0.6), tableCase(items, 1.8), wallCase(items, 1.8, false)]) expect(result.unit.items.length + result.rest.length === items.length, 'all objects retained');
});

test('a full cabinet of small objects does not put its bottom shelf down near the floor', () => {
  const items = Array.from({ length: 24 }, () => item(0.2));
  for (const unit of [vitrine(items, 0.6).unit, wallCase(items, 1.8, true).unit]) {
    for (const e of record(unit).exhibits) between(e.at.y + e.m.real.y / 2, 1.3, 2.0, `${unit.type} packed shelf height`);
  }
});
