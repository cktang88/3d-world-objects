/**
 * USDA (as written by sand3d) -> mesh buffers, in the browser. Port of scripts/usda_to_glb.py
 * that also keeps rigid bodies and their joints, so articulated objects can move.
 * Coordinates stay Z-up and metric; the caller rotates the result into Y-up.
 */

export interface MatDef {
  name: string;
  color: [number, number, number];
  rough: number;
  metal: number;
  opacity: number;
  emissive: [number, number, number];
}

export interface PartBuf {
  mat: number;
  pos: Float32Array;
  nrm: Float32Array;
  idx: Uint32Array;
}

export interface BodyBuf {
  path: string;
  /** rest pose, world (object) space, column-major 4x4 like three.js Matrix4.elements */
  matrix: number[];
  parts: PartBuf[];
}

export interface JointDef {
  name: string;
  kind: 'revolute' | 'prismatic';
  axis: 'X' | 'Y' | 'Z';
  body0: string;
  body1: string;
  pos1: [number, number, number];
  rot1: [number, number, number, number]; // w x y z
  lower: number;
  upper: number;
}

export interface ParsedObject {
  bodies: BodyBuf[];
  joints: JointDef[];
  materials: MatDef[];
  min: [number, number, number];
  max: [number, number, number];
  tris: number;
}

interface Prim {
  kind: string;
  name: string;
  path: string;
  attrs: Map<string, string>;
  rels: Map<string, string>;
  meta: Map<string, string>;
  children: Prim[];
}

const DEF_RE = /^\s*(def|over|class)\s+(\w+)?\s*"([^"]+)"/;
const ATTR_RE = /^\s*(?:uniform\s+|custom\s+)?([\w[\]]+)\s+([\w:.]+)\s*=\s*(.*)$/;
const REL_RE = /^\s*rel\s+([\w:.]+)\s*=\s*<([^>]+)>/;

function parseTree(text: string): Prim {
  const root: Prim = { kind: 'Root', name: '', path: '', attrs: new Map(), rels: new Map(), meta: new Map(), children: [] };
  const stack: Prim[] = [root];
  let pending: Prim | null = null;
  let lastAttr = '';
  let inMeta = 0;
  let start = 0;
  const n = text.length;
  while (start < n) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = n;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    const top = stack[stack.length - 1];
    // fast path: long array attribute lines
    const m = DEF_RE.exec(line);
    if (m) {
      const p: Prim = { kind: m[2] ?? '', name: m[3], path: `${top.path}/${m[3]}`, attrs: new Map(), rels: new Map(), meta: new Map(), children: [] };
      top.children.push(p);
      pending = p;
      if (line.endsWith('(')) inMeta++;
      continue;
    }
    if (inMeta) {
      if (lastAttr && line.startsWith('interpolation')) {
        const mm = /interpolation\s*=\s*"(\w+)"/.exec(line);
        if (mm) top.meta.set(`${lastAttr}:interpolation`, mm[1]);
      }
      if (line.startsWith(')')) inMeta--;
      continue;
    }
    if (line === '{') {
      stack.push(pending ?? { kind: 'Anon', name: '', path: top.path, attrs: new Map(), rels: new Map(), meta: new Map(), children: [] });
      pending = null;
      continue;
    }
    if (line === '}') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (stack.length === 1) continue;
    const r = REL_RE.exec(line);
    if (r) {
      top.rels.set(r[1], r[2]);
      continue;
    }
    // attribute: find '=' manually to avoid regex on huge lines
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const head = line.slice(0, eq);
    const am = ATTR_RE.exec(head + '= ');
    if (!am) continue;
    let val = line.slice(eq + 1).trim();
    if (val.endsWith('(')) {
      inMeta++;
      val = val.slice(0, -1).trim();
    }
    top.attrs.set(am[2], val);
    lastAttr = am[2];
  }
  return root;
}

function nums(s: string): number[] {
  const out: number[] = [];
  const parts = s.replace(/[[\]()]/g, ' ').split(/[\s,]+/);
  for (const p of parts) {
    if (!p) continue;
    const v = p === 'inf' ? Infinity : p === '-inf' ? -Infinity : Number(p);
    if (!Number.isNaN(v)) out.push(v);
  }
  return out;
}

// ---- 4x4 row-major helpers (p' = M p) ----
type M4 = number[];
const ident = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: M4, b: M4): M4 {
  const r = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
    r[i * 4 + j] = s;
  }
  return r;
}
function quat(w: number, x: number, y: number, z: number): M4 {
  const n = Math.hypot(w, x, y, z) || 1;
  w /= n; x /= n; y /= n; z /= n;
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0,
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0,
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1];
}
function rotAxis(ax: string, deg: number): M4 {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  if (ax === 'X') return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
  if (ax === 'Y') return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function invert(m: M4): M4 {
  // general 4x4 inverse
  const inv = new Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return ident();
  det = 1 / det;
  inv[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  inv[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  inv[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  inv[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  inv[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  inv[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  inv[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  inv[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  inv[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  inv[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  inv[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  inv[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  inv[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  inv[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  inv[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  inv[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return inv;
}

function localMatrix(p: Prim): M4 {
  const order = p.attrs.get('xformOpOrder');
  if (!order) return ident();
  let m = ident();
  for (let op of order.match(/"([^"]+)"/g) ?? []) {
    op = op.slice(1, -1);
    if (op.startsWith('!invert!')) continue;
    const v = p.attrs.get(op);
    if (v === undefined) continue;
    const a = nums(v);
    const base = op.includes(':') ? op.split(':')[1] : op;
    let o: M4;
    if (base === 'translate') o = [1, 0, 0, a[0], 0, 1, 0, a[1], 0, 0, 1, a[2], 0, 0, 0, 1];
    else if (base === 'orient') o = quat(a[0], a[1], a[2], a[3]);
    else if (base === 'scale') o = [a[0], 0, 0, 0, 0, a[1], 0, 0, 0, 0, a[2], 0, 0, 0, 0, 1];
    else if (base === 'transform') o = [a[0], a[4], a[8], a[12], a[1], a[5], a[9], a[13], a[2], a[6], a[10], a[14], a[3], a[7], a[11], a[15]];
    else if (/^rotate[XYZ]{3}$/.test(base)) {
      o = ident();
      for (let i = 0; i < 3; i++) o = mul(rotAxis(base[6 + i], a[i]), o);
    } else if (/^rotate[XYZ]$/.test(base)) o = rotAxis(base[6], a[0]);
    else continue;
    m = mul(m, o);
  }
  return m;
}

function toColumnMajor(m: M4): number[] {
  return [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]];
}

export function parseUsda(text: string): ParsedObject {
  const root = parseTree(text);

  // materials
  const matIndex = new Map<string, number>();
  const materials: MatDef[] = [];
  const walkMats = (p: Prim) => {
    if (p.kind === 'Material') {
      const md: MatDef = { name: p.name, color: [0.7, 0.7, 0.7], rough: 0.6, metal: 0, opacity: 1, emissive: [0, 0, 0] };
      for (const c of p.children) {
        if (c.kind !== 'Shader') continue;
        const a = c.attrs;
        if (a.has('inputs:diffuseColor')) md.color = nums(a.get('inputs:diffuseColor')!).slice(0, 3) as MatDef['color'];
        if (a.has('inputs:roughness')) md.rough = nums(a.get('inputs:roughness')!)[0];
        if (a.has('inputs:metallic')) md.metal = nums(a.get('inputs:metallic')!)[0];
        if (a.has('inputs:opacity')) md.opacity = nums(a.get('inputs:opacity')!)[0];
        if (a.has('inputs:emissiveColor')) md.emissive = nums(a.get('inputs:emissiveColor')!).slice(0, 3) as MatDef['emissive'];
      }
      matIndex.set(p.path, materials.length);
      materials.push(md);
    }
    p.children.forEach(walkMats);
  };
  walkMats(root);
  const defaultMat = () => {
    if (!matIndex.has('__default__')) {
      matIndex.set('__default__', materials.length);
      materials.push({ name: 'default', color: [0.7, 0.7, 0.7], rough: 0.6, metal: 0, opacity: 1, emissive: [0, 0, 0] });
    }
    return matIndex.get('__default__')!;
  };

  // joints
  const joints: JointDef[] = [];
  const walkJoints = (p: Prim) => {
    const kind = p.kind === 'PhysicsRevoluteJoint' ? 'revolute' : p.kind === 'PhysicsPrismaticJoint' ? 'prismatic' : null;
    if (kind && p.rels.has('physics:body0') && p.rels.has('physics:body1')) {
      const ax = (p.attrs.get('physics:axis') ?? '"Z"').replace(/"/g, '').trim() as JointDef['axis'];
      const pos1 = nums(p.attrs.get('physics:localPos1') ?? '(0,0,0)');
      const rot1 = nums(p.attrs.get('physics:localRot1') ?? '(1,0,0,0)');
      const lo = p.attrs.has('physics:lowerLimit') ? nums(p.attrs.get('physics:lowerLimit')!)[0] : -Infinity;
      const hi = p.attrs.has('physics:upperLimit') ? nums(p.attrs.get('physics:upperLimit')!)[0] : Infinity;
      joints.push({
        name: p.name, kind, axis: ['X', 'Y', 'Z'].includes(ax) ? ax : 'Z', body0: p.rels.get('physics:body0')!, body1: p.rels.get('physics:body1')!,
        pos1: [pos1[0] ?? 0, pos1[1] ?? 0, pos1[2] ?? 0], rot1: [rot1[0] ?? 1, rot1[1] ?? 0, rot1[2] ?? 0, rot1[3] ?? 0],
        lower: lo ?? -Infinity, upper: hi ?? Infinity,
      });
    }
    p.children.forEach(walkJoints);
  };
  walkJoints(root);
  const bodyPaths = new Set<string>();
  for (const j of joints) { bodyPaths.add(j.body0); bodyPaths.add(j.body1); }

  // geometry, grouped per body then per material
  const bodies = new Map<string, { matrix: M4; inv: M4; groups: Map<number, { pos: number[]; nrm: number[]; idx: number[] }> }>();
  const ROOT_BODY = '__root__';
  bodies.set(ROOT_BODY, { matrix: ident(), inv: ident(), groups: new Map() });
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let tris = 0;

  const walk = (p: Prim, m: M4, body: string) => {
    const lm = mul(m, localMatrix(p));
    let b = body;
    if (bodyPaths.has(p.path)) {
      b = p.path;
      bodies.set(b, { matrix: lm, inv: invert(lm), groups: new Map() });
    }
    if (p.kind === 'Mesh' && p.attrs.has('points')) addMesh(p, lm, b);
    for (const c of p.children) walk(c, lm, b);
  };

  const addMesh = (p: Prim, world: M4, bodyKey: string) => {
    const body = bodies.get(bodyKey)!;
    const m = mul(body.inv, world); // mesh -> body local
    const pf = nums(p.attrs.get('points')!);
    const npts = Math.floor(pf.length / 3);
    const pts = new Float64Array(npts * 3);
    const wpt = [0, 0, 0];
    for (let i = 0; i < npts; i++) {
      const x = pf[i * 3], y = pf[i * 3 + 1], z = pf[i * 3 + 2];
      pts[i * 3] = m[0] * x + m[1] * y + m[2] * z + m[3];
      pts[i * 3 + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
      pts[i * 3 + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
      // world bbox
      wpt[0] = world[0] * x + world[1] * y + world[2] * z + world[3];
      wpt[1] = world[4] * x + world[5] * y + world[6] * z + world[7];
      wpt[2] = world[8] * x + world[9] * y + world[10] * z + world[11];
      for (let a = 0; a < 3; a++) {
        if (wpt[a] < min[a]) min[a] = wpt[a];
        if (wpt[a] > max[a]) max[a] = wpt[a];
      }
    }
    let counts = nums(p.attrs.get('faceVertexCounts') ?? '');
    const idxs = nums(p.attrs.get('faceVertexIndices') ?? '');
    if (!counts.length) counts = new Array(Math.floor(idxs.length / 3)).fill(3);
    let nrm: number[] | null = null;
    const interp = p.meta.get('normals:interpolation') ?? 'vertex';
    if (p.attrs.has('normals')) nrm = nums(p.attrs.get('normals')!);
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
    let flip = det < 0;
    if ((p.attrs.get('orientation') ?? '').includes('leftHanded')) flip = !flip;
    const mpath = p.rels.get('material:binding');
    const mi = mpath && matIndex.has(mpath) ? matIndex.get(mpath)! : defaultMat();
    let g = body.groups.get(mi);
    if (!g) {
      g = { pos: [], nrm: [], idx: [] };
      body.groups.set(mi, g);
    }
    const map = new Map<string, number>();
    const totalFV = idxs.length;
    const nOk = nrm && (interp === 'faceVarying' ? nrm.length >= totalFV * 3 : nrm.length >= npts * 3);
    let cursor = 0;
    const out: number[] = [];
    for (const cnt of counts) {
      const f0 = cursor;
      cursor += cnt;
      if (cnt < 3) continue;
      let bad = false;
      for (let k = 0; k < cnt; k++) if (idxs[f0 + k] >= npts) bad = true;
      if (bad) continue;
      let fx = 0, fy = 0, fz = 0;
      if (!nOk) {
        const a = idxs[f0] * 3, b = idxs[f0 + 1] * 3, c = idxs[f0 + 2] * 3;
        const ux = pts[b] - pts[a], uy = pts[b + 1] - pts[a + 1], uz = pts[b + 2] - pts[a + 2];
        const vx = pts[c] - pts[a], vy = pts[c + 1] - pts[a + 1], vz = pts[c + 2] - pts[a + 2];
        fx = uy * vz - uz * vy; fy = uz * vx - ux * vz; fz = ux * vy - uy * vx;
        const l = Math.hypot(fx, fy, fz) || 1;
        fx /= l; fy /= l; fz /= l;
        if (flip) { fx = -fx; fy = -fy; fz = -fz; }
      }
      out.length = 0;
      for (let k = 0; k < cnt; k++) {
        const vi = idxs[f0 + k];
        let nx = fx, ny = fy, nz = fz;
        if (nOk) {
          const ni = interp === 'faceVarying' ? (f0 + k) * 3 : vi * 3;
          const x = nrm![ni], y = nrm![ni + 1], z = nrm![ni + 2];
          nx = m[0] * x + m[1] * y + m[2] * z;
          ny = m[4] * x + m[5] * y + m[6] * z;
          nz = m[8] * x + m[9] * y + m[10] * z;
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l; ny /= l; nz /= l;
        }
        const key = `${vi}|${Math.round(nx * 500)}|${Math.round(ny * 500)}|${Math.round(nz * 500)}`;
        let j = map.get(key);
        if (j === undefined) {
          j = g.pos.length / 3;
          map.set(key, j);
          g.pos.push(pts[vi * 3], pts[vi * 3 + 1], pts[vi * 3 + 2]);
          g.nrm.push(nx, ny, nz);
        }
        out.push(j);
      }
      for (let t = 1; t < cnt - 1; t++) {
        if (flip) g.idx.push(out[0], out[t + 1], out[t]);
        else g.idx.push(out[0], out[t], out[t + 1]);
        tris++;
      }
    }
  };

  walk(root, ident(), ROOT_BODY);

  const outBodies: BodyBuf[] = [];
  for (const [path, b] of bodies) {
    const parts: PartBuf[] = [];
    for (const [mat, g] of b.groups) {
      if (!g.idx.length) continue;
      parts.push({ mat, pos: new Float32Array(g.pos), nrm: new Float32Array(g.nrm), idx: new Uint32Array(g.idx) });
    }
    if (!parts.length && path === ROOT_BODY) continue;
    outBodies.push({ path, matrix: toColumnMajor(b.matrix), parts });
  }
  if (!Number.isFinite(min[0])) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }
  return { bodies: outBodies, joints, materials, min: min as ParsedObject['min'], max: max as ParsedObject['max'], tris };
}
