/** Lighting: time-of-day presets are sane, and HDRI analysis survives odd images (no NaN, sun found, fallbacks). */
import * as THREE from 'three';
import { test, expect, between, near } from './qa';
import './env';
import { PRESETS, TIMES, INDOOR_HDRI, OVERCAST, LIGHT_BUDGET, analyse, blendPreset, rotateEquirect, downsampleEquirect } from '../src/lighting';

const H2F = THREE.DataUtils.toHalfFloat;

/** a synthetic 128x64 equirect: sky gradient, optional sun disc at (az, el) degrees, ground */
function hdr(opts: { sun?: [number, number]; sunL?: number; poison?: boolean; black?: boolean } = {}) {
  const W = 128, H = 64;
  const data = new Uint16Array(W * H * 4);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const el = (0.5 - (r + 0.5) / H) * 180;
    const a = ((c + 0.5) / W - 0.5) * Math.PI * 2;
    let v = opts.black ? 0 : el > 0 ? 0.6 + 0.6 * (1 - el / 90) : 0.15;
    let R = v * 0.8, G = v * 0.9, B = v * 1.1;
    if (opts.sun) {
      const [saz, sel] = opts.sun;
      const d = new THREE.Vector3(Math.cos(el * Math.PI / 180) * Math.cos(a), Math.sin(el * Math.PI / 180), Math.cos(el * Math.PI / 180) * Math.sin(a));
      const s = new THREE.Vector3(Math.cos(sel * Math.PI / 180) * Math.cos(saz), Math.sin(sel * Math.PI / 180), Math.cos(sel * Math.PI / 180) * Math.sin(saz));
      if (d.angleTo(s) < 0.06) R = G = B = opts.sunL ?? 5000;
    }
    const p = (r * W + c) * 4;
    data[p] = H2F(R); data[p + 1] = H2F(G); data[p + 2] = H2F(B); data[p + 3] = H2F(1);
  }
  if (opts.poison) { data[4 * 200] = 0x7c00; data[4 * 300 + 1] = 0x7e00; data[4 * 400 + 2] = 0xfc00; } // +Inf, NaN, -Inf
  return new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
}
function finiteData(t: THREE.DataTexture) {
  const d = (t.image as unknown as { data: Uint16Array }).data;
  for (let i = 0; i < d.length; i++) if (!Number.isFinite(THREE.DataUtils.fromHalfFloat(d[i]))) return false;
  return true;
}

test('every time of day has a preset with sane values', () => {
  for (const t of TIMES) {
    const p = PRESETS[t];
    expect(p, `preset ${t}`);
    between(p.exposure, 0.3, 2.5, `${t} exposure`);
    between(p.sunIntensity, 0, 12, `${t} sun`);
    between(p.sky, 0.005, 2, `${t} sky`);
    between(p.night, 0, 1, `${t} night`);
    between(p.lit, 0, 0.7, `${t} lit windows`);
    between(p.wet, 0, 1, `${t} wet`);
    between(p.fog, 0, 0.01, `${t} fog`);
    between(p.envSat, 0, 1.2, `${t} envSat`);
    between(p.bloom.threshold, 0.3, 5, `${t} bloom threshold`);
    between(p.sunElev, -10, 90, `${t} sun elevation`);
    for (const c of [p.sunColor, p.grade.gain, p.grade.lift, p.bounce.sky, p.bounce.ground]) expect(/^#[0-9a-f]{6}$/i.test(c), `${t} colour ${c}`);
    expect(/^[a-z0-9_]+$/.test(p.hdri), `${t} hdri id`);
  }
  // night factor rises through the day; exposure opens up as it gets darker
  const order = ['day', 'golden', 'dusk', 'night'] as const;
  for (let i = 1; i < order.length; i++) {
    expect(PRESETS[order[i]].night >= PRESETS[order[i - 1]].night, `night factor order at ${order[i]}`);
    expect(PRESETS[order[i]].exposure >= PRESETS[order[i - 1]].exposure, `exposure order at ${order[i]}`);
  }
  for (const v of Object.values(INDOOR_HDRI)) between(v.mean, 0.1, 2, 'indoor mean');
});

test('HDRI analysis finds the sun and clamps it out', () => {
  const az = 1.1, el = 30;
  const t = hdr({ sun: [az, el] });
  const a = analyse(t, 12, 1);
  expect(a.sun, 'sun found');
  near(Math.asin(a.sun!.y) * 180 / Math.PI, el, 4, 'sun elevation');
  // three's equirect convention: u = atan(z, x)
  const got = Math.atan2(a.sun!.z, a.sun!.x);
  near(Math.abs(Math.atan2(Math.sin(got - az), Math.cos(got - az))), 0, 0.08, 'sun azimuth error (rad)');
  const d = (t.image as unknown as { data: Uint16Array }).data;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) max = Math.max(max, THREE.DataUtils.fromHalfFloat(d[i + 1]));
  expect(max < 0.9 * 12 * 1.5, `clamped max ${max}`);
  between(a.skyMean, 0.5, 1.5, 'sky mean');
  expect(a.horizon.r > 0 && a.horizon.b > a.horizon.r, 'horizon colour from the sky');
});

test('HDRI analysis: Inf / NaN pixels are repaired (else the frame goes black), black image is flagged', () => {
  const t = hdr({ sun: [0.3, 20], poison: true });
  const a = analyse(t, 12, 0.7);
  expect(finiteData(t), 'all pixels finite after analysis');
  expect(Number.isFinite(a.skyMean) && Number.isFinite(a.mean), 'finite means');
  expect(Number.isFinite(a.horizon.r + a.horizon.g + a.horizon.b), 'finite horizon');
  const b = analyse(hdr({ black: true }), 12, 1);
  expect(!(b.skyMean > 1e-5), 'black image has ~0 sky (lighting.ts then keeps the physical sky)');
  expect(b.sun === null, 'no sun in a black image');
  // no sun (overcast): no direction, nothing clamped away
  const o = analyse(hdr(), 12, 1);
  expect(o.sun === null, 'overcast: no sun');
});

test('preset blending is continuous and hits the end points', () => {
  const a = PRESETS.day, b = PRESETS.night;
  const m0 = blendPreset(a, b, 0), m1 = blendPreset(a, b, 1), mh = blendPreset(a, b, 0.5);
  near(m0.exposure, a.exposure, 1e-6, 'blend 0 exposure');
  near(m1.exposure, b.exposure, 1e-6, 'blend 1 exposure');
  between(mh.night, Math.min(a.night, b.night), Math.max(a.night, b.night), 'blend 0.5 night');
  expect(/^#[0-9a-f]{6}$/i.test(mh.sunColor), 'blended colour is hex');
});

test('rotating an HDRI moves its sun to the wanted azimuth (sunAz convention: atan2(x, z))', () => {
  for (const want of [235, 250, 10, 140]) {
    const t = hdr({ sun: [1.1, 25] });
    const a = analyse(t, 1e9, 1);
    const alpha = THREE.MathUtils.degToRad(want) - Math.atan2(a.sun!.x, a.sun!.z);
    rotateEquirect(t, alpha);
    const b = analyse(t, 1e9, 1);
    const got = THREE.MathUtils.radToDeg(Math.atan2(b.sun!.x, b.sun!.z));
    const err = Math.abs(((got - want + 540) % 360) - 180);
    expect(err < 5, `sun at ${got.toFixed(1)} deg, wanted ${want}`);
    // and the analytic rotation of the old sun vector agrees
    const v = a.sun!.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), alpha);
    expect(v.angleTo(b.sun!) < 0.1, 'rotated sun vector matches');
  }
});

test('downsampled copy for the PMREM keeps the mean, overcast preset and light budget are sane', () => {
  const t = hdr({ sun: [0.5, 30], sunL: 50 });
  const big = analyse(t, 1e9, 1).mean;
  const s = downsampleEquirect(t, 32);
  expect((s.image as unknown as { width: number }).width === 32, 'width 32');
  near(analyse(s, 1e9, 1).mean / big, 1, 0.08, 'mean preserved');
  between(OVERCAST.sunIntensity, 0, 2, 'overcast sun is weak');
  expect(OVERCAST.envSat < 0.9 && OVERCAST.align === false, 'overcast is grey and has no sun to align');
  // museum rig 10 spots + 3 points, interiors 12 points + 1 shadow point, plus 2 seamless preview + 1 lift light
  expect(LIGHT_BUDGET.spot >= 10 && LIGHT_BUDGET.point >= 15 && LIGHT_BUDGET.pointShadow >= 1, 'budget covers the level rigs');
});
