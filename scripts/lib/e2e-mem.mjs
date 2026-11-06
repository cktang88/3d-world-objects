/**
 * Memory sampling for the memory journeys (scripts/e2e/memory-world.mjs, memory-museum.mjs):
 * window.__mem() (renderer.info.memory: the journeys draw one frame in every room they enter), the JS heap after a forced GC (CDP), live instance counts of the three.js classes
 * (Runtime.queryObjects), and heap snapshots summarised by constructor (self size, count).
 */
import fs from 'fs';
import path from 'path';

export async function memProbe(h) {
  // (the dev build's pre-bundled three names some classes _Object3D, _Vector3 ...)
  const cdp = await h.page.context().newCDPSession(h.page);
  await cdp.send('HeapProfiler.enable');
  // prototypes of the classes to count, found from live objects (dev build: class names kept)
  const protoIds = {};
  const findProto = async (name, expr) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const is = (p) => p && p.constructor && p.constructor.name.replace(/^_+/, '') === ${JSON.stringify(name)}; let p = ${expr}; while (p && !is(p)) p = Object.getPrototypeOf(p); return is(p) ? p : null; })()`,
    });
    if (r.result.objectId) protoIds[name] = r.result.objectId;
  };
  const anyMesh = `(() => { let m = null; window.__world.scene.traverse((o) => { if (!m && o.isMesh && o.material && !Array.isArray(o.material)) m = o; }); return m; })()`;
  await findProto('Object3D', `Object.getPrototypeOf(window.__world.scene)`);
  await findProto('BufferGeometry', `Object.getPrototypeOf(${anyMesh}.geometry)`);
  await findProto('Material', `Object.getPrototypeOf(${anyMesh}.material)`);
  await findProto('Texture', `(() => { let t = null; window.__world.scene.traverse((o) => { const m = o.material; for (const x of m ? [m].flat() : []) for (const v of Object.values(x)) if (!t && v && v.isTexture) t = v; }); return t && Object.getPrototypeOf(t); })()`);
  const count = async (name) => {
    if (!protoIds[name]) return null;
    const q = await cdp.send('Runtime.queryObjects', { prototypeObjectId: protoIds[name] });
    const n = await cdp.send('Runtime.callFunctionOn', { objectId: q.objects.objectId, functionDeclaration: 'function () { return this.length; }', returnByValue: true });
    await cdp.send('Runtime.releaseObject', { objectId: q.objects.objectId });
    return n.result.value;
  };
  const rows = [];
  return {
    cdp,
    rows,
    /** one sample, labelled (draw: one drawn frame first, so what is in view is uploaded) */
    async sample(label, o = {}) {
      if (o.draw) await h.page.evaluate(async () => { window.__e2e.draw(true); await window.__e2e.frames(1); window.__e2e.draw(false); });
      await cdp.send('HeapProfiler.collectGarbage');
      const m = await h.page.evaluate(() => window.__mem());
      const heap = await cdp.send('Runtime.getHeapUsage');
      const live = {};
      for (const k of ['Object3D', 'BufferGeometry', 'Material', 'Texture']) live[k] = await count(k);
      const r = { label, t: Math.round(performance.now() / 1000), gpuGeo: m.gpu.geometries, gpuTex: m.gpu.textures, programs: m.gpu.programs, heapMB: +(heap.usedSize / 1048576).toFixed(1), ...live };
      rows.push(r);
      h.log('mem', JSON.stringify(r));
      return r;
    },
    /** a heap snapshot to a file, summarised by constructor: Map name -> { n, self } */
    async snapshot(file) {
      await cdp.send('HeapProfiler.collectGarbage');
      const out = fs.openSync(file, 'w');
      const onChunk = (c) => fs.writeSync(out, c.chunk);
      cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
      cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
      fs.closeSync(out);
      const sum = summarise(file);
      fs.unlinkSync(file);
      return sum;
    },
  };
}

/** constructor name -> { n, self } over 'object' nodes, reading the snapshot without JSON.parse of the whole file */
function summarise(file) {
  const text = fs.readFileSync(file, 'latin1');
  const meta = JSON.parse(text.slice(text.indexOf('{"snapshot":') + 12, text.indexOf(',\n"nodes"') > 0 ? text.indexOf(',\n"nodes"') : text.indexOf(',"nodes"')));
  const fields = meta.meta.node_fields, types = meta.meta.node_types[0];
  const nf = fields.length, iType = fields.indexOf('type'), iName = fields.indexOf('name'), iSelf = fields.indexOf('self_size');
  const a = text.indexOf('[', text.indexOf('"nodes"')) + 1, b = text.indexOf(']', a);
  const s0 = text.indexOf('[', text.indexOf('"strings"'));
  const strings = JSON.parse(Buffer.from(text.slice(s0, text.lastIndexOf(']') + 1), 'latin1').toString('utf8'));
  const sum = new Map();
  let f = 0, cur = 0, v = 0, inNum = false, type = 0, name = 0;
  for (let i = a; i <= b; i++) {
    const c = text.charCodeAt(i);
    if (c >= 48 && c <= 57) { v = v * 10 + (c - 48); inNum = true; continue; }
    if (!inNum) continue;
    inNum = false;
    if (f === iType) type = v; else if (f === iName) name = v; else if (f === iSelf) cur = v;
    if (++f === nf) {
      if (types[type] === 'object' || types[type] === 'closure' || types[type] === 'array') {
        const k = types[type] === 'object' ? strings[name] : `(${types[type]})`;
        const e = sum.get(k) ?? { n: 0, self: 0 };
        e.n++; e.self += cur;
        sum.set(k, e);
      }
      f = 0;
    }
    v = 0;
  }
  return sum;
}

/** the constructors that grew most between two summaries */
export function growth(a, b, top = 10) {
  const rows = [];
  for (const [k, e] of b) {
    const p = a.get(k) ?? { n: 0, self: 0 };
    rows.push({ name: k, dn: e.n - p.n, dKB: Math.round((e.self - p.self) / 1024) });
  }
  return rows.sort((x, y) => y.dKB - x.dKB).slice(0, top);
}

export function save(h, name, data) {
  const f = path.join(h.outDir, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify(data, null, 1));
  h.log('saved', f);
}
