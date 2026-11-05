import { parseUsda, type ParsedObject } from './parse';

self.onmessage = async (ev: MessageEvent<{ id: number; url: string }>) => {
  const { id, url } = ev.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const parsed: ParsedObject = parseUsda(text);
    const transfer: Transferable[] = [];
    for (const b of parsed.bodies) for (const p of b.parts) transfer.push(p.pos.buffer, p.nrm.buffer, p.idx.buffer);
    (self as unknown as Worker).postMessage({ id, parsed }, transfer);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: String(e) });
  }
};
