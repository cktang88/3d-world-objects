/**
 * Retainer paths for leak hunting in qa tests: why is an object still alive after gc()?
 *
 *   import { tagLeak, retainers } from './heap';
 *   tagLeak(obj);                 // obj.__leakTag = new LeakTag()
 *   ...evict...
 *   console.log(retainers(3));    // up to 3 shortest paths from a GC root to a tagged object
 *
 * Takes a V8 heap snapshot (slow: ~1-3 s, tens of MB), so use it only while hunting.
 */
import v8 from 'v8';
import { readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export class LeakTag {}
export function tagLeak(o: object) { (o as { __leakTag?: LeakTag }).__leakTag = new LeakTag(); }

interface Snap { snapshot: { meta: { node_fields: string[]; node_types: [string[]]; edge_fields: string[]; edge_types: [string[]] } }; nodes: number[]; edges: number[]; strings: string[] }

export function retainers(max = 3, depth = 14): string[] {
  const file = v8.writeHeapSnapshot(join(tmpdir(), `qa-heap-${process.pid}-${Date.now()}.heapsnapshot`));
  const s = JSON.parse(readFileSync(file, 'utf8')) as Snap;
  unlinkSync(file);
  const nf = s.snapshot.meta.node_fields.length, ef = s.snapshot.meta.edge_fields.length;
  const N = s.nodes.length / nf;
  const nTypes = s.snapshot.meta.node_types[0], eTypes = s.snapshot.meta.edge_types[0];
  const iName = s.snapshot.meta.node_fields.indexOf('name'), iEdges = s.snapshot.meta.node_fields.indexOf('edge_count'), iType = s.snapshot.meta.node_fields.indexOf('type');
  const iEType = s.snapshot.meta.edge_fields.indexOf('type'), iEName = s.snapshot.meta.edge_fields.indexOf('name_or_index'), iTo = s.snapshot.meta.edge_fields.indexOf('to_node');
  // reverse edges
  const firstEdge = new Uint32Array(N + 1);
  for (let i = 0; i < N; i++) firstEdge[i + 1] = firstEdge[i] + s.nodes[i * nf + iEdges];
  const rev: [number, number][][] = Array.from({ length: N }, () => []);
  for (let i = 0; i < N; i++) for (let e = firstEdge[i]; e < firstEdge[i + 1]; e++) {
    const et = eTypes[s.edges[e * ef + iEType]];
    if (et === 'weak') continue;
    if (et === 'element' || et === 'hidden' ? false : s.strings[s.edges[e * ef + iEName]] === 'weak_refs_keep_during_job') continue;
    rev[s.edges[e * ef + iTo] / nf].push([i, e]);
  }
  const name = (i: number) => s.strings[s.nodes[i * nf + iName]];
  const type = (i: number) => nTypes[s.nodes[i * nf + iType]];
  const edgeName = (e: number) => {
    const t = eTypes[s.edges[e * ef + iEType]], v = s.edges[e * ef + iEName];
    return t === 'element' || t === 'hidden' ? `[${v}]` : String(s.strings[v]);
  };
  const tags: number[] = [];
  for (let i = 0; i < N; i++) if (type(i) === 'object' && name(i) === 'LeakTag') tags.push(i);
  const out: string[] = [];
  for (const t of tags.slice(0, max)) {
    // BFS back to a root (node 0 is the synthetic root)
    const prev = new Map<number, [number, number]>([[t, [-1, -1]]]);
    let q = [t], found = -1;
    for (let d = 0; d < 60 && q.length && found < 0; d++) {
      const nq: number[] = [];
      for (const n of q) {
        for (const [from, e] of rev[n]) {
          if (prev.has(from)) continue;
          prev.set(from, [n, e]);
          if (from === 0 || type(from) === 'synthetic') { found = from; break; }
          nq.push(from);
        }
        if (found >= 0) break;
      }
      q = nq;
    }
    if (found < 0) { out.push(`tag ${t}: no path to a root`); continue; }
    const path: string[] = [];
    for (let n = found; n !== t; ) {
      const [next, e] = prev.get(n)!;
      path.push(`${type(n) === 'object' || type(n) === 'closure' || type(n) === 'synthetic' ? name(n) : type(n)}.${edgeName(e)}`);
      n = next;
    }
    out.push(path.slice(-depth).join(' -> '));
  }
  return out;
}
