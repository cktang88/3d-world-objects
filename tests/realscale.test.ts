/**
 * Real scale over the whole catalogue (79,985 objects: labels from public/museum/t, measured raw
 * sizes from public/museum/s): after realScale every object is within reach of its label's typical
 * size, nothing plausible is touched, wrong units are fixed by unit factors.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, between, fmt, none } from './qa';
import { realScale, plausibleRange, SCALE_TOLERANCE } from '../src/realscale';
import { LABEL } from '../src/realsize-labels';

interface Obj { ds: string; family: string; entry: string; title: string; max: number }
let cache: Obj[] | null = null;
function catalogue(): Obj[] {
  if (cache) return cache;
  const dir = join(process.env.QA_ROOT ?? process.cwd(), 'public/museum');
  const out: Obj[] = [];
  for (const f of readdirSync(join(dir, 't'))) {
    const t = JSON.parse(readFileSync(join(dir, 't', f), 'utf8')) as Record<string, unknown[][]>;
    const s = JSON.parse(readFileSync(join(dir, 's', f), 'utf8')) as Record<string, ([number, number, number] | 0)[]>;
    for (const [k, rows] of Object.entries(t)) rows.forEach((r, i) => {
      const sz = s[k]?.[i];
      if (sz && Math.max(...sz) > 0) out.push({ ds: r[0] as string, family: r[4] as string, entry: r[5] as string, title: r[6] as string, max: Math.max(...sz) });
    });
  }
  return (cache = out);
}
const objaverse = () => catalogue().filter((o) => o.ds === 'objaverse');
/** the plausible band: within SCALE_TOLERANCE of the label's measured typical size (or of a title word's,
 *  inside the family range), else the family range; objects with nothing known count as plausible */
function plausible(o: Obj, size: number) {
  const r = plausibleRange(o.title, o.entry, o.family);
  return !r || (size >= r.lo * 0.999 && size <= r.hi * 1.001);
}

test('every object lands in its label/family plausible range after realScale', () => {
  const all = objaverse();
  expect(all.length > 40000, `only ${all.length} objaverse objects with sizes`);
  let before = 0, after = 0;
  const bad: string[] = [];
  for (const o of all) {
    const k = realScale(o.title, o.entry, o.family, o.max, o.ds);
    if (plausible(o, o.max)) before++;
    if (plausible(o, o.max * k)) after++;
    else bad.push(`${o.entry || o.family} "${o.title}" ${fmt(o.max)} m -> ${fmt(o.max * k)} m`);
  }
  console.log(`  plausible before realScale: ${((100 * before) / all.length).toFixed(1)}%, after: ${((100 * after) / all.length).toFixed(1)}% of ${all.length}`);
  none(bad, 'objects still implausibly sized');
});

test('objects already plausible are never rescaled (museum: never scaled down)', () => {
  let n = 0;
  const bad: string[] = [];
  for (const o of objaverse()) {
    if (!plausible(o, o.max)) continue;
    n++;
    const k = realScale(o.title, o.entry, o.family, o.max, o.ds);
    if (k !== 1) bad.push(`"${o.title}" ${fmt(o.max)} m k=${fmt(k)}`);
  }
  expect(n > 30000, `only ${n} plausible objects`);
  none(bad, 'plausible objects rescaled');
});

test('the label table is measured: every label band holds most of its own objects', () => {
  const by = new Map<string, Obj[]>();
  for (const o of catalogue()) if (o.entry && LABEL[o.entry]) (by.get(o.entry) ?? by.set(o.entry, []).get(o.entry)!).push(o);
  const bad: string[] = [];
  for (const [l, v] of by) {
    if (v.length < 20) continue;
    const ok = v.filter((o) => plausible(o, o.max)).length / v.length;
    if (ok < 0.75) bad.push(`${l}: ${Math.round(ok * 100)}% of ${v.length}`);
  }
  none(bad, 'labels whose plausible band fits few of their objects');
});

test('real-size datasets (CAD, Articraft, SimReady, AutoMate) are left alone', () => {
  for (const o of catalogue().filter((x) => x.ds !== 'objaverse').slice(0, 2000)) expect(realScale(o.title, o.entry, o.family, o.max, o.ds) === 1, `${o.ds} "${o.title}" rescaled`);
});

test('wrong units are fixed by a unit factor (cm/mm/inch as metres), not squashed to the average', () => {
  // a 4.3 m coupe modelled in centimetres, millimetres or inches
  near(realScale('BMW 4', 'coupe', 'vehicle', 430), 0.01, 'cm coupe factor');
  near(realScale('BMW 4', 'coupe', 'vehicle', 4300), 0.001, 'mm coupe factor');
  near(realScale('BMW 4', 'coupe', 'vehicle', 4.3 / 0.0254), 0.0254, 'inch coupe factor');
  // a toy-sized source of a real car comes up to car size
  between(0.6 * realScale('BMW 4', 'coupe', 'vehicle', 0.6), 3.5, 6, 'BMW 4 from 0.6 m');
  between(0.5 * realScale('Chevy S10', 'pickup', 'vehicle', 0.5), 4, 6.5, 'Chevy S10 from 0.5 m');
  // labels beat title words: a puzzle cube is a Rubik's cube, not a 0.3 m jigsaw
  between(0.057 * realScale('Puzzle', 'puzzle_cube', 'toy or game', 0.057), 0.04, 0.1, 'puzzle cube');
});
function near(v: number, want: number, what: string) {
  expect(Math.abs(v / want - 1) < 1e-6, `${what}: ${v} != ${want}`);
}

test('label table: typical sizes are sane for well-known labels', () => {
  const want: [string, number, number][] = [['sedan', 3.8, 5.6], ['coupe', 3.8, 5.2], ['pickup', 4.5, 6.5], ['bus', 9, 15], ['mug', 0.07, 0.15], ['chair', 0.7, 1.2], ['sword', 0.6, 1.5], ['motorcycle', 1.7, 2.6], ['house', 6, 25], ['guitar', 0.8, 1.3], ['bench', 1.2, 2.5], ['book', 0.15, 0.35]];
  for (const [l, lo, hi] of want) between(LABEL[l] ?? NaN, lo, hi, `LABEL.${l}`);
});
