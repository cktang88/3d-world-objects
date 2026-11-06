/**
 * Boot stage marks: `mark('manifest')` records seconds since navigation start in window.__boot and
 * logs `[boot] manifest 12.3s` (scripts/boot.mjs prints them). `timed(name, promise)` marks when a
 * promise settles. Costs nothing measurable; always on.
 */
const marks: Record<string, number> = ((globalThis as unknown as { __boot?: Record<string, number> }).__boot ??= {});

export function mark(name: string) {
  const t = +(performance.now() / 1000).toFixed(2);
  if (!(name in marks)) marks[name] = t;
  console.log(`[boot] ${name} ${t}s`);
}

export function timed<T>(name: string, p: Promise<T>): Promise<T> {
  p.then(() => mark(name), () => mark(`${name} (failed)`));
  return p;
}
