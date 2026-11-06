/**
 * Third-party model library catalogs (public/libraries/, src/libraries.ts): every entry resolves to a
 * well-formed absolute model URL (no URL glued onto another base), sizes are sane, and a small sample of
 * model URLs answers a HEAD request when the network allows (curl through the machine's proxy).
 */
import { execFile } from 'child_process';
import { test, expect, none, soft } from './qa';
import './env';
import { LIBRARY_SOURCES, loadCatalog, type LibraryEntry } from '../src/libraries';

const all = new Map<string, LibraryEntry[]>();
async function entries() {
  if (!all.size) for (const s of LIBRARY_SOURCES) all.set(s, await loadCatalog(s));
  return [...all.values()].flat();
}

/** every URL an entry would fetch: the model, its parts and low-poly parts, the thumbnail */
function urls(e: LibraryEntry): string[] {
  const out = [e.url];
  for (const p of e.parts ?? []) out.push(p.url, ...(p.lowUrl ? [p.lowUrl] : []));
  if (e.thumb) out.push(e.thumb);
  return out;
}
function wellFormed(u: string) {
  if (!/^https:\/\/[a-z0-9.-]+\//i.test(u)) return false;
  if (u.indexOf('://') !== u.lastIndexOf('://')) return false; // nested absolute URL
  if (u.replace(/^https:\/\//, '').split('?')[0].includes('//')) return false; // empty path segment
  try {
    new URL(u);
  } catch {
    return false;
  }
  return true;
}

test('every library catalog loads and is non-empty', async () => {
  for (const s of LIBRARY_SOURCES) {
    const es = await loadCatalog(s);
    expect(es.length > 0, `${s}: empty catalog`);
  }
});

test('every model / part / thumbnail URL is a well-formed absolute https URL', async () => {
  const bad: string[] = [];
  for (const e of await entries()) for (const u of urls(e)) if (!wellFormed(u)) bad.push(`${e.source}:${e.id} ${u}`);
  none(bad, 'malformed library URLs', (s) => s, 8);
});

test('model URLs point at a model file (GLB, or the Poly Haven file-list API)', async () => {
  const bad: string[] = [];
  for (const e of await entries()) {
    const models = e.parts ? e.parts.map((p) => p.url) : [e.url];
    for (const u of models) {
      const ok = e.source === 'polyhaven' ? u.startsWith('https://api.polyhaven.com/files/') : /\.glb$/i.test(new URL(u).pathname);
      if (!ok) bad.push(`${e.source}:${e.id} ${u}`);
    }
  }
  none(bad, 'library entries without a GLB', (s) => s, 8);
});

test('real-world sizes are positive and plausible (1 mm .. 120 m)', async () => {
  const bad: string[] = [];
  for (const e of await entries()) {
    if (!e.size) continue;
    const m = Math.max(...e.size);
    if (!(e.size.every((v) => Number.isFinite(v) && v >= 0) && m >= 0.001 && m <= 120)) bad.push(`${e.source}:${e.id} ${e.size.join('×')}`);
  }
  none(bad, 'implausible library sizes', (s) => s, 8);
});

test('HEAD check: a small sample of model URLs exists (skipped offline)', async () => {
  const es = await entries();
  const sample: string[] = [];
  for (const s of LIBRARY_SOURCES) {
    const list = es.filter((e) => e.source === s);
    // first and middle entry of each source, plus parts of two multi-part Smithsonian packages
    for (const e of [list[0], list[list.length >> 1]]) if (e) sample.push(e.parts?.[0]?.url ?? e.url);
  }
  // multi-part packages (e.g. the Wright Flyer, whose Voyager document lists absolute CDN URLs)
  const multi = [es.find((e) => e.category === 'air-space' && (e.parts?.length ?? 0) > 1), ...es.filter((e) => (e.parts?.length ?? 0) > 1)].filter(Boolean).slice(0, 2) as LibraryEntry[];
  for (const e of multi) sample.push(...e.parts!.slice(0, 2).map((p) => p.url));
  // curl goes through the machine's HTTPS proxy; all requests run in parallel, 6 s cap each
  const head = (u: string) =>
    new Promise<string>((res) =>
      execFile('curl', ['-sS', '-o', '/dev/null', '-I', '-L', '-m', '6', '-w', '%{http_code}', u], { encoding: 'utf8', timeout: 7000 }, (err, out) =>
        res(err && !out ? 'ERR' : String(out).trim()),
      ),
    );
  if ((await head('https://api.polyhaven.com/')) === 'ERR') {
    soft(false, 'no network: HEAD sample skipped');
    return;
  }
  const codes = await Promise.all(sample.map(head));
  const bad = sample.map((u, i) => [u, codes[i]] as const).filter(([, c]) => !/^(200|206|301|302)$/.test(c));
  none(bad, 'library model URLs that do not answer HEAD with 200', ([u, c]) => `${c} ${u}`, 8);
});
