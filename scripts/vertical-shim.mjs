// minimal browser shim for running level generators in node
const ctx = () => new Proxy({}, {
  get(t, k) {
    if (k === 'getImageData' || k === 'createImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray((w || 1) * (h || 1) * 4), width: w, height: h });
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => ({ addColorStop() {} });
    if (k in t) return t[k];
    return () => {};
  },
  set(t, k, v) { t[k] = v; return true; },
});
globalThis.document = {
  createElement: () => ({ width: 1, height: 1, getContext: ctx, style: {} }),
  addEventListener() {},
};
globalThis.addEventListener = () => {};
globalThis.window = globalThis;
globalThis.Image = class { set src(v) {} };
globalThis.fetch = async () => ({ ok: false, json: async () => ({}), text: async () => '' });
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.matchMedia = () => ({ matches: false });
globalThis.requestAnimationFrame = () => 0;
