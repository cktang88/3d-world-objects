/** Originals: an 8k-textured GLB is refused before its images are decoded (headless pages ran out of memory). */
import { test, expect } from './qa';
import { imageDims, glbImagePixels, MAX_DECODE_PX, ORIGINAL_TEX_MAX } from '../src/detail';
import { HEAVY_BYTES } from '../src/nyc/district-showcase';

function png(w: number, h: number) {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
function jpeg(w: number, h: number) {
  // SOI, an APP0 segment, then SOF0 with height / width
  const b = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return b;
}
function glb(images: Uint8Array[]) {
  let off = 0;
  const views = images.map((im) => { const v = { buffer: 0, byteOffset: off, byteLength: im.length }; off += im.length; return v; });
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: off }], bufferViews: views, images: views.map((_, i) => ({ bufferView: i, mimeType: 'image/png' })) }));
  const jl = Math.ceil(json.length / 4) * 4, bl = Math.ceil(off / 4) * 4;
  const out = new Uint8Array(12 + 8 + jl + 8 + bl);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jl); out.set(json, 20);
  dv.setUint32(20 + jl, bl, true); dv.setUint32(24 + jl, 0x004e4942, true);
  let p = 28 + jl;
  for (const im of images) { out.set(im, p); p += im.length; }
  return out.buffer;
}

test('image headers give their size without decoding (PNG, JPEG)', () => {
  expect(imageDims(png(8192, 4096)).join('x') === '8192x4096', `png ${imageDims(png(8192, 4096))}`);
  expect(imageDims(jpeg(2048, 1024)).join('x') === '2048x1024', `jpeg ${imageDims(jpeg(2048, 1024))}`);
});

test('a GLB with an 8k texture is over the decode budget; a 2k one is not', () => {
  const big = glbImagePixels(glb([png(8192, 8192)]));
  expect(big.images === 1 && big.px > MAX_DECODE_PX, `8k: ${big.px} px, ${big.images} images`);
  const ok = glbImagePixels(glb([png(2048, 2048), jpeg(1024, 1024)]));
  expect(ok.images === 2 && ok.px <= MAX_DECODE_PX, `2k + 1k: ${ok.px} px`);
  expect(ORIGINAL_TEX_MAX <= 1024, `originals shrink to ${ORIGINAL_TEX_MAX} px`);
  expect(HEAVY_BYTES <= 3e6, `heavy showcase programs from ${HEAVY_BYTES} bytes`);
});
