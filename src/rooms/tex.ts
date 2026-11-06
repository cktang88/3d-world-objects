import * as THREE from 'three';
import { Rng } from '../rng';

/** Canvas textures for interiors: tile, mosaics, book spines, the view out of a window, rugs, leaves. */

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}
function tex(c: HTMLCanvasElement, repeat = true, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function noise(g: CanvasRenderingContext2D, w: number, h: number, amt: number, rng: Rng) {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng.next() - 0.5) * amt;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}
export function shade(hex: string, f: number): string {
  const c = new THREE.Color(hex);
  c.multiplyScalar(f);
  return `#${c.getHexString()}`;
}
const memo = new Map<string, unknown>();
function cached<T>(key: string, make: () => T): T {
  if (!memo.has(key)) memo.set(key, make());
  return memo.get(key) as T;
}

/** 3x6" subway tile, running bond. One texture repeat = 0.3 m x 0.3 m (4 courses x 2 tiles). */
export function subwayTex(color = '#f4f2ec', grout = '#c9c6bd') {
  return cached(`subway:${color}:${grout}`, () => {
    const S = 256;
    const rng = new Rng(3);
    const [c, g] = canvas(S);
    g.fillStyle = grout;
    g.fillRect(0, 0, S, S);
    const th = S / 4, tw = S / 2;
    for (let row = 0; row < 4; row++)
      for (let k = -1; k < 3; k++) {
        const x = k * tw + (row % 2 ? tw / 2 : 0);
        const y = row * th;
        const grd = g.createLinearGradient(0, y, 0, y + th);
        const base = shade(color, 0.97 + rng.next() * 0.05);
        grd.addColorStop(0, shade(base, 1.04));
        grd.addColorStop(0.15, base);
        grd.addColorStop(0.85, base);
        grd.addColorStop(1, shade(base, 0.9));
        g.fillStyle = grd;
        g.fillRect(x + 2, y + 2, tw - 4, th - 4);
      }
    noise(g, S, S, 5, rng);
    return tex(c);
  });
}

/** 1" white hexagon mosaic with a scattered black "flower" pattern. One repeat = 0.3 m. */
export function hexTex(a = '#f3f1ea', b = '#2a2a2a') {
  return cached(`hex:${a}:${b}`, () => {
    const S = 512;
    const rng = new Rng(5);
    const [c, g] = canvas(S);
    g.fillStyle = '#bdb8ad';
    g.fillRect(0, 0, S, S);
    const n = 12; // hexes across
    const w = S / n, r = w / Math.sqrt(3);
    const rows = Math.round(S / (r * 1.5));
    const dy = S / rows;
    for (let row = -1; row <= rows; row++)
      for (let col = -1; col <= n; col++) {
        const cx = col * w + (row % 2 ? w / 2 : 0);
        const cy = row * dy;
        const flower = (row % 4 === 0 && col % 4 === 0) || (row % 4 === 2 && col % 4 === 2);
        g.fillStyle = flower ? b : shade(a, 0.95 + rng.next() * 0.07);
        g.beginPath();
        for (let k = 0; k < 6; k++) {
          const ang = Math.PI / 6 + (k * Math.PI) / 3;
          const px = cx + Math.cos(ang) * (r - 1.6), py = cy + Math.sin(ang) * (r - 1.6);
          if (k === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.closePath();
        g.fill();
      }
    noise(g, S, S, 6, rng);
    return tex(c);
  });
}

/** classic black-and-white checkerboard (12" tiles); one repeat = 0.6 m */
export function checkerTex(a = '#efece4', b = '#2b2b2d') {
  return cached(`checker:${a}:${b}`, () => {
    const S = 256;
    const rng = new Rng(7);
    const [c, g] = canvas(S);
    g.fillStyle = '#9a968e';
    g.fillRect(0, 0, S, S);
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        g.fillStyle = (x + y) % 2 ? b : a;
        g.fillRect(x * 128 + 1.5, y * 128 + 1.5, 125, 125);
      }
    noise(g, S, S, 8, rng);
    return tex(c);
  });
}

/** 2x2 ft acoustic ceiling tiles with fissures; one repeat = 1.2 m */
export function dropCeilingTex() {
  return cached('dropceil', () => {
    const S = 256;
    const rng = new Rng(11);
    const [c, g] = canvas(S);
    g.fillStyle = '#f2f1ec';
    g.fillRect(0, 0, S, S);
    g.fillStyle = 'rgba(120,115,105,0.25)';
    for (let i = 0; i < 900; i++) g.fillRect(rng.next() * S, rng.next() * S, 1 + rng.next() * 2, 1);
    g.fillStyle = '#d9d8d2';
    for (let i = 0; i <= 2; i++) {
      g.fillRect(i * 128 - 3, 0, 6, S);
      g.fillRect(0, i * 128 - 3, S, 6);
    }
    return tex(c);
  });
}

/** office carpet tile, 0.5 m squares laid quarter-turned; one repeat = 1 m */
export function carpetTileTex(base = '#4a4d52') {
  return cached(`carpettile:${base}`, () => {
    const S = 256;
    const rng = new Rng(13);
    const [c, g] = canvas(S);
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        g.fillStyle = shade(base, 0.95 + rng.next() * 0.1);
        g.fillRect(x * 128, y * 128, 128, 128);
        g.strokeStyle = 'rgba(0,0,0,0.12)';
        const vert = (x + y) % 2 === 0;
        for (let k = 0; k < 128; k += 4) {
          g.beginPath();
          if (vert) {
            g.moveTo(x * 128 + k, y * 128);
            g.lineTo(x * 128 + k, y * 128 + 128);
          } else {
            g.moveTo(x * 128, y * 128 + k);
            g.lineTo(x * 128 + 128, y * 128 + k);
          }
          g.stroke();
        }
      }
    noise(g, S, S, 22, rng);
    return tex(c);
  });
}

/** a shelf of book spines; one repeat covers 1 m of shelf, 0.3 m tall. Alpha marks the gaps above shorter books. */
export function spinesTex(seed: number) {
  return cached(`spines:${seed}`, () => {
    const W = 512, H = 160;
    const rng = new Rng(seed);
    const [c, g] = canvas(W, H);
    g.clearRect(0, 0, W, H);
    const cols = ['#7b2d26', '#2c3e57', '#3d5a40', '#c9b48a', '#1f1f1f', '#8a6d3b', '#5b3a5e', '#d8d2c4', '#a8462f', '#30566b', '#e3c36a', '#6b6b6b', '#efe9dc', '#264653'];
    let x = 0;
    while (x < W) {
      if (rng.chance(0.06)) {
        x += rng.range(10, 40);
        continue;
      }
      const w = rng.range(7, 20);
      const h = H * rng.range(0.62, 0.98);
      const col = rng.pick(cols);
      g.fillStyle = col;
      g.fillRect(x, H - h, w - 1, h);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x + w - 2, H - h, 1.5, h);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(x + 1, H - h, 1.5, h);
      // title bands
      g.fillStyle = rng.chance(0.5) ? 'rgba(230,200,120,0.8)' : 'rgba(255,255,255,0.55)';
      g.fillRect(x + 2, H - h + h * 0.12, w - 5, 2);
      g.fillRect(x + 2, H - h + h * 0.18 + rng.range(4, 20), w - 5, rng.range(4, 12));
      g.fillRect(x + 2, H - h * 0.12, w - 5, 2);
      x += w;
    }
    return tex(c);
  });
}

/** the view out of a window: a brick building across the street, its windows, a strip of sky */
export function windowViewTex(seed: number, night = false) {
  return cached(`view:${seed}:${night}`, () => {
    const W = 256, H = 384;
    const rng = new Rng(seed);
    const [c, g] = canvas(W, H);
    const sky = g.createLinearGradient(0, 0, 0, H * 0.4);
    sky.addColorStop(0, night ? '#0b1430' : '#9cc3e8');
    sky.addColorStop(1, night ? '#24305a' : '#e4eef5');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    const top = H * rng.range(0.12, 0.35);
    const brick = rng.pick(['#8a4b3a', '#9a5a44', '#7a4a3c', '#b49a7a', '#6e5146']);
    g.fillStyle = night ? shade(brick, 0.35) : brick;
    g.fillRect(0, top, W, H - top);
    // brick courses
    g.fillStyle = 'rgba(0,0,0,0.08)';
    for (let y = top; y < H; y += 4) g.fillRect(0, y, W, 1);
    // cornice
    g.fillStyle = night ? '#3a3632' : '#d8d0c0';
    g.fillRect(0, top - 6, W, 10);
    // windows of the building opposite, in bays
    const bw = W / 3;
    for (let fy = top + 24; fy < H; fy += 78)
      for (let b = 0; b < 3; b++) {
        const x = b * bw + bw * 0.25, w = bw * 0.5, h = 52;
        g.fillStyle = night ? '#e8d6c0' : '#efe9de';
        g.fillRect(x - 3, fy - 3, w + 6, h + 6);
        const lit = night && rng.chance(0.5);
        g.fillStyle = lit ? '#ffcf7a' : night ? '#141a26' : rng.chance(0.3) ? '#5f6b78' : '#2c3644';
        g.fillRect(x, fy, w, h);
        g.fillStyle = night ? '#e8d6c0' : '#efe9de';
        g.fillRect(x, fy + h / 2 - 1.5, w, 3);
        // shade pulled part way
        if (!night && rng.chance(0.5)) {
          g.fillStyle = rng.pick(['#e8e0cc', '#d6cdb6', '#f4f0e6']);
          g.fillRect(x, fy, w, h * rng.range(0.2, 0.5));
        }
        g.fillStyle = 'rgba(255,255,255,0.18)';
        g.fillRect(x + 2, fy + 2, w * 0.3, h / 2 - 4);
      }
    // fire escape
    if (rng.chance(0.6)) {
      g.strokeStyle = night ? '#111' : '#1b1b1b';
      g.lineWidth = 2;
      const fx = bw * rng.int(0, 2) + 6;
      for (let fy = top + 80; fy < H; fy += 78) {
        g.strokeRect(fx, fy, bw - 12, 4);
        for (let k = 0; k < bw - 12; k += 6) g.fillRect(fx + k, fy - 14, 1, 14);
        g.beginPath();
        g.moveTo(fx + 8, fy);
        g.lineTo(fx + bw - 30, fy + 74);
        g.stroke();
      }
    }
    noise(g, W, H, 8, rng);
    return tex(c, false);
  });
}

/** a patterned area rug (persian-ish medallion or kilim stripes or plain with border) */
export function rugTex(seed: number) {
  return cached(`rug2:${seed}`, () => {
    const W = 512, H = 384;
    const rng = new Rng(seed);
    const [c, g] = canvas(W, H);
    const palettes = [
      ['#7a2430', '#1f2a44', '#d9c7a3', '#b8873e'],
      ['#2d3c5a', '#a8442f', '#e6d8b8', '#5c6b4a'],
      ['#c8bfae', '#6d7b85', '#efe7d6', '#9a8a70'],
      ['#3d4a3d', '#b59a63', '#e2d6bb', '#7a3b2e'],
      ['#e7e1d3', '#2f3b4a', '#c9c0ac', '#8a8f94'],
    ];
    const [field, border, light, accent] = rng.pick(palettes);
    const kind = rng.int(0, 2);
    g.fillStyle = field;
    g.fillRect(0, 0, W, H);
    if (kind === 0) {
      // medallion carpet
      g.fillStyle = border;
      g.fillRect(0, 0, W, H);
      g.fillStyle = light;
      g.fillRect(14, 14, W - 28, H - 28);
      g.fillStyle = border;
      g.fillRect(22, 22, W - 44, H - 44);
      g.fillStyle = field;
      g.fillRect(44, 44, W - 88, H - 88);
      g.fillStyle = accent;
      for (let i = 0; i < 60; i++) {
        const x = 50 + rng.next() * (W - 100), y = 50 + rng.next() * (H - 100);
        g.beginPath();
        g.arc(x, y, 2 + rng.next() * 4, 0, Math.PI * 2);
        g.fill();
      }
      g.save();
      g.translate(W / 2, H / 2);
      g.fillStyle = light;
      g.beginPath();
      g.ellipse(0, 0, 90, 60, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = border;
      g.beginPath();
      g.ellipse(0, 0, 60, 38, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = accent;
      g.beginPath();
      g.ellipse(0, 0, 26, 16, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
      // border motifs
      g.fillStyle = accent;
      for (let x = 30; x < W - 20; x += 16) {
        g.fillRect(x, 16, 6, 4);
        g.fillRect(x, H - 20, 6, 4);
      }
    } else if (kind === 1) {
      // kilim stripes with diamonds
      for (let y = 0; y < H; y += 24) {
        g.fillStyle = [field, light, border, light, accent][Math.floor(y / 24) % 5];
        g.fillRect(0, y, W, 24);
        g.fillStyle = [border, accent, light][Math.floor(y / 24) % 3];
        for (let x = 12; x < W; x += 32) {
          g.beginPath();
          g.moveTo(x, y + 3);
          g.lineTo(x + 8, y + 12);
          g.lineTo(x, y + 21);
          g.lineTo(x - 8, y + 12);
          g.fill();
        }
      }
    } else {
      // plain with a contrasting border, like a modern wool rug
      g.fillStyle = light;
      g.fillRect(0, 0, W, H);
      g.fillStyle = border;
      g.fillRect(18, 18, W - 36, H - 36);
      g.fillStyle = light;
      g.fillRect(26, 26, W - 52, H - 52);
    }
    noise(g, W, H, 26, rng);
    return tex(c, false);
  });
}

/** a single leaf with alpha, for plants */
export function leafTex() {
  return cached('leaf', () => {
    const W = 64, H = 128;
    const [c, g] = canvas(W, H);
    g.clearRect(0, 0, W, H);
    const grd = g.createLinearGradient(0, 0, W, 0);
    grd.addColorStop(0, '#2f5a2a');
    grd.addColorStop(0.5, '#4f8a3c');
    grd.addColorStop(1, '#2c5226');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(W / 2, 2);
    g.bezierCurveTo(W + 6, H * 0.3, W - 4, H * 0.8, W / 2, H - 2);
    g.bezierCurveTo(4, H * 0.8, -6, H * 0.3, W / 2, 2);
    g.fill();
    g.strokeStyle = 'rgba(200,230,170,0.5)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(W / 2, 4);
    g.lineTo(W / 2, H - 4);
    g.stroke();
    return tex(c, false);
  });
}

/** a framed photo / poster for small frames */
export function photoTex(seed: number) {
  return cached(`photo:${seed}`, () => {
    const W = 128, H = 160;
    const rng = new Rng(seed);
    const [c, g] = canvas(W, H);
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, rng.pick(['#9cb8d0', '#e0c49a', '#c9d6c0', '#d8d0c8']));
    grd.addColorStop(1, rng.pick(['#4a5a3a', '#6a5040', '#3a4a5a', '#807060']));
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 4; i++) {
      g.fillStyle = `rgba(${rng.int(20, 200)},${rng.int(20, 200)},${rng.int(20, 200)},0.6)`;
      g.beginPath();
      g.ellipse(rng.range(20, W - 20), rng.range(H * 0.4, H - 20), rng.range(8, 30), rng.range(10, 40), 0, 0, Math.PI * 2);
      g.fill();
    }
    noise(g, W, H, 20, rng);
    return tex(c, false);
  });
}
