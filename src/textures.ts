import * as THREE from 'three';
import { Rng } from './rng';

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, repeat = true, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, amt: number, rng: Rng) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng.next() - 0.5) * amt;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

function shade(hex: string, f: number): string {
  const c = new THREE.Color(hex);
  c.multiplyScalar(f);
  return `#${c.getHexString()}`;
}

const memo = new Map<string, unknown>();
function cached<T>(key: string, make: () => T): T {
  if (!memo.has(key)) memo.set(key, make());
  return memo.get(key) as T;
}

export type FacadeStyle = 'brick' | 'plaster' | 'glass' | 'panel' | 'adobe' | 'timber';

/** 4 bays x 4 floors; each bay is 3 m wide and each floor 3.2 m tall. */
export function facade(style: FacadeStyle, wall: string, lit: number, seed: number) {
  return cached(`facade:${style}:${wall}:${lit}:${seed}`, () => {
    const S = 512;
    const cell = S / 4;
    const rng = new Rng(seed);
    const [c, g] = canvas(S);
    const [ce, ge] = canvas(S);
    ge.fillStyle = '#000';
    ge.fillRect(0, 0, S, S);
    g.fillStyle = wall;
    g.fillRect(0, 0, S, S);
    if (style === 'brick') {
      for (let y = 0; y < S; y += 8) {
        for (let x = (y / 8) % 2 ? -8 : 0; x < S; x += 16) {
          g.fillStyle = shade(wall, 0.85 + rng.next() * 0.3);
          g.fillRect(x + 1, y + 1, 14, 6);
        }
      }
    } else if (style === 'panel') {
      g.strokeStyle = shade(wall, 0.8);
      g.lineWidth = 2;
      for (let i = 0; i <= 4; i++) {
        g.beginPath();
        g.moveTo(0, i * cell);
        g.lineTo(S, i * cell);
        g.stroke();
      }
    } else if (style === 'timber') {
      g.strokeStyle = '#3b2a1e';
      g.lineWidth = 7;
      for (let i = 0; i < 4; i++) {
        g.strokeRect(i * cell, 0, cell, S);
        g.beginPath();
        g.moveTo(i * cell, (i % 2) * cell);
        g.lineTo(i * cell + cell, (i % 2) * cell + cell * 0.9);
        g.stroke();
      }
      for (let j = 0; j < 4; j++) g.fillRect(0, j * cell - 3, S, 6);
    }
    noise(g, S, S, style === 'glass' ? 6 : 18, rng);
    for (let fy = 0; fy < 4; fy++) {
      for (let bx = 0; bx < 4; bx++) {
        const x0 = bx * cell;
        const y0 = fy * cell;
        let wx: number, wy: number, ww: number, wh: number;
        if (style === 'glass') {
          wx = x0 + 4; wy = y0 + 10; ww = cell - 8; wh = cell - 22;
        } else if (style === 'panel') {
          wx = x0; wy = y0 + 34; ww = cell; wh = 48;
        } else if (style === 'adobe') {
          wx = x0 + 44; wy = y0 + 40; ww = 40; wh = 50;
        } else {
          wx = x0 + 32; wy = y0 + 26; ww = 64; wh = 80;
        }
        const on = rng.next() < lit;
        const glassCol = style === 'glass' ? '#2c4a63' : '#24323f';
        g.fillStyle = glassCol;
        g.fillRect(wx, wy, ww, wh);
        const grad = g.createLinearGradient(wx, wy, wx + ww, wy + wh);
        grad.addColorStop(0, 'rgba(255,255,255,0.28)');
        grad.addColorStop(0.5, 'rgba(255,255,255,0.03)');
        grad.addColorStop(1, 'rgba(255,255,255,0.12)');
        g.fillStyle = grad;
        g.fillRect(wx, wy, ww, wh);
        if (on) {
          const warm = rng.pick(['#ffd28a', '#ffe7b0', '#fff1d6', '#bfe3ff', '#ffc070']);
          g.fillStyle = warm;
          g.globalAlpha = 0.55;
          g.fillRect(wx + 2, wy + 2, ww - 4, wh - 4);
          g.globalAlpha = 1;
          ge.fillStyle = warm;
          ge.fillRect(wx + 2, wy + 2, ww - 4, wh - 4);
          // curtains / silhouettes
          ge.fillStyle = 'rgba(0,0,0,0.5)';
          if (rng.chance(0.5)) ge.fillRect(wx + 2, wy + 2, ww * 0.25, wh - 4);
        }
        // frames, sills, mullions
        g.strokeStyle = style === 'glass' ? '#b9c6cf' : shade(wall, 1.25);
        g.lineWidth = style === 'glass' ? 2 : 4;
        g.strokeRect(wx, wy, ww, wh);
        g.beginPath();
        g.moveTo(wx + ww / 2, wy);
        g.lineTo(wx + ww / 2, wy + wh);
        if (style !== 'glass') {
          g.moveTo(wx, wy + wh * 0.4);
          g.lineTo(wx + ww, wy + wh * 0.4);
        }
        g.stroke();
        if (style === 'plaster' || style === 'timber') {
          g.fillStyle = shade(wall, 0.55);
          g.fillRect(wx - 14, wy, 12, wh);
          g.fillRect(wx + ww + 2, wy, 12, wh);
        }
        if (style !== 'glass' && style !== 'panel') {
          g.fillStyle = shade(wall, 1.3);
          g.fillRect(wx - 6, wy + wh, ww + 12, 7);
        }
      }
    }
    return { map: tex(c), emissive: tex(ce) };
  });
}

export function roofTex(color: string) {
  return cached(`roof:${color}`, () => {
    const S = 256;
    const rng = new Rng(7);
    const [c, g] = canvas(S);
    g.fillStyle = color;
    g.fillRect(0, 0, S, S);
    for (let y = 0; y < S; y += 16) {
      for (let x = (y / 16) % 2 ? -12 : 0; x < S; x += 24) {
        g.fillStyle = shade(color, 0.75 + rng.next() * 0.4);
        g.fillRect(x + 1, y + 1, 22, 14);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(x + 1, y + 13, 22, 2);
      }
    }
    return tex(c);
  });
}

export function concreteTex(base: string, tile = 64) {
  return cached(`concrete:${base}:${tile}`, () => {
    const S = 256;
    const rng = new Rng(3);
    const [c, g] = canvas(S);
    g.fillStyle = base;
    g.fillRect(0, 0, S, S);
    noise(g, S, S, 22, rng);
    g.strokeStyle = shade(base, 0.7);
    g.lineWidth = 2;
    for (let i = 0; i <= S; i += tile) {
      g.beginPath();
      g.moveTo(i, 0); g.lineTo(i, S);
      g.moveTo(0, i); g.lineTo(S, i);
      g.stroke();
    }
    return tex(c);
  });
}

export function grassTex(base: string) {
  return cached(`grass:${base}`, () => {
    const S = 256;
    const rng = new Rng(5);
    const [c, g] = canvas(S);
    g.fillStyle = base;
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 4000; i++) {
      g.fillStyle = shade(base, 0.7 + rng.next() * 0.6);
      g.fillRect(rng.next() * S, rng.next() * S, 1.5, 3 + rng.next() * 3);
    }
    return tex(c);
  });
}

/** One city chunk's road surface: roads along the edges, the block centre hidden under the slab. */
export function roadTex(asphalt: string, line: string, chunk: number, road: number) {
  return cached(`road:${asphalt}:${line}`, () => {
    const S = 1024;
    const px = S / chunk;
    const rng = new Rng(11);
    const [c, g] = canvas(S);
    g.fillStyle = asphalt;
    g.fillRect(0, 0, S, S);
    noise(g, S, S, 26, rng);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = 'rgba(0,0,0,0.08)';
      g.beginPath();
      g.ellipse(rng.next() * S, rng.next() * S, 10 + rng.next() * 40, 6 + rng.next() * 20, rng.next() * 3, 0, Math.PI * 2);
      g.fill();
    }
    const half = road / 2;
    g.fillStyle = line;
    // dashed centre lines on the chunk edges (roads are shared by neighbouring chunks)
    for (let t = half * px + 10; t < S - half * px - 10; t += 44) {
      g.fillRect(t, 0, 24, 3);
      g.fillRect(t, S - 3, 24, 3);
      g.fillRect(0, t, 3, 24);
      g.fillRect(S - 3, t, 3, 24);
    }
    // crosswalks at the corners
    g.fillStyle = 'rgba(240,240,240,0.85)';
    const cw = half * px;
    for (const [ox, oy] of [[0, 0], [S - cw, 0], [0, S - cw], [S - cw, S - cw]]) {
      for (let k = 0; k < cw; k += 14) {
        const horizontal = ox === 0;
        if (horizontal) g.fillRect(ox + cw + 4, oy + k, 26, 7);
        else g.fillRect(ox - 30, oy + k, 26, 7);
      }
    }
    return tex(c, false);
  });
}

export function circuitTex() {
  return cached('circuit', () => {
    const S = 512;
    const rng = new Rng(21);
    const [c, g] = canvas(S);
    g.fillStyle = '#05080f';
    g.fillRect(0, 0, S, S);
    g.strokeStyle = '#0c3b52';
    g.lineWidth = 1;
    for (let i = 0; i <= S; i += 32) {
      g.beginPath();
      g.moveTo(i, 0); g.lineTo(i, S);
      g.moveTo(0, i); g.lineTo(S, i);
      g.stroke();
    }
    g.strokeStyle = '#19e3ff';
    g.lineWidth = 2;
    for (let i = 0; i < 60; i++) {
      let x = Math.floor(rng.next() * 16) * 32;
      let y = Math.floor(rng.next() * 16) * 32;
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 4; k++) {
        if (rng.chance(0.5)) x += (rng.chance(0.5) ? 1 : -1) * 32 * rng.int(1, 3);
        else y += (rng.chance(0.5) ? 1 : -1) * 32 * rng.int(1, 3);
        g.lineTo(x, y);
      }
      g.stroke();
      g.fillStyle = '#7ff4ff';
      g.fillRect(x - 3, y - 3, 6, 6);
    }
    return tex(c);
  });
}

export function woodFloorTex(base: string) {
  return cached(`wood:${base}`, () => {
    const W = 256, H = 512;
    const rng = new Rng(9);
    const [c, g] = canvas(W, H);
    for (let x = 0; x < W; x += 32) {
      for (let y = -rng.int(0, 200); y < H; y += 180) {
        g.fillStyle = shade(base, 0.8 + rng.next() * 0.35);
        g.fillRect(x, y, 32, 180);
        g.strokeStyle = 'rgba(0,0,0,0.18)';
        for (let k = 0; k < 5; k++) {
          g.beginPath();
          const xx = x + 3 + rng.next() * 26;
          g.moveTo(xx, y);
          g.bezierCurveTo(xx + 4, y + 60, xx - 4, y + 120, xx, y + 180);
          g.stroke();
        }
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(x, y, 32, 2);
        g.fillRect(x, y, 1.5, 180);
      }
    }
    return tex(c);
  });
}

export function tileFloorTex(a: string, b: string) {
  return cached(`tile:${a}:${b}`, () => {
    const S = 256;
    const rng = new Rng(13);
    const [c, g] = canvas(S);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        g.fillStyle = (x + y) % 2 ? a : b;
        g.fillRect(x * 64, y * 64, 64, 64);
      }
    noise(g, S, S, 10, rng);
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    for (let i = 0; i <= S; i += 64) {
      g.beginPath();
      g.moveTo(i, 0); g.lineTo(i, S);
      g.moveTo(0, i); g.lineTo(S, i);
      g.stroke();
    }
    return tex(c);
  });
}

export function carpetTex(base: string) {
  return cached(`carpet:${base}`, () => {
    const S = 128;
    const rng = new Rng(17);
    const [c, g] = canvas(S);
    g.fillStyle = base;
    g.fillRect(0, 0, S, S);
    noise(g, S, S, 30, rng);
    return tex(c);
  });
}

export function wallpaperTex(base: string, seed: number) {
  return cached(`wallpaper:${base}:${seed}`, () => {
    const S = 256;
    const rng = new Rng(seed);
    const [c, g] = canvas(S);
    g.fillStyle = base;
    g.fillRect(0, 0, S, S);
    const kind = seed % 4;
    g.fillStyle = shade(base, 0.88);
    g.strokeStyle = shade(base, 0.85);
    if (kind === 0) {
      for (let x = 0; x < S; x += 32) g.fillRect(x, 0, 12, S);
    } else if (kind === 1) {
      for (let y = 16; y < S; y += 48)
        for (let x = (y / 48) % 2 ? 24 : 0; x < S; x += 48) {
          g.beginPath();
          g.arc(x, y, 6, 0, Math.PI * 2);
          g.fill();
        }
    } else if (kind === 2) {
      g.lineWidth = 2;
      for (let y = 0; y < S; y += 32)
        for (let x = 0; x < S; x += 32) {
          g.beginPath();
          g.moveTo(x + 16, y);
          g.lineTo(x + 32, y + 16);
          g.lineTo(x + 16, y + 32);
          g.lineTo(x, y + 16);
          g.closePath();
          g.stroke();
        }
    }
    noise(g, S, S, 6, rng);
    return tex(c);
  });
}

export function rugTex(seed: number) {
  return cached(`rug:${seed}`, () => {
    const S = 256;
    const rng = new Rng(seed);
    const [c, g] = canvas(S);
    const cols = ['#7a2f2f', '#2f4f7a', '#3d6b4f', '#8a6a2a', '#5a3d7a', '#a14d2a'];
    const a = rng.pick(cols), b = rng.pick(cols);
    g.fillStyle = a;
    g.fillRect(0, 0, S, S);
    g.fillStyle = b;
    g.fillRect(16, 16, S - 32, S - 32);
    g.fillStyle = a;
    g.fillRect(28, 28, S - 56, S - 56);
    g.strokeStyle = '#e8d9b5';
    g.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.arc(S / 2, S / 2, 20 + i * 14, 0, Math.PI * 2);
      g.stroke();
    }
    noise(g, S, S, 30, rng);
    return tex(c, false);
  });
}

export function paintingTex(seed: number) {
  return cached(`paint:${seed}`, () => {
    const W = 256, H = 192;
    const rng = new Rng(seed);
    const [c, g] = canvas(W, H);
    const palettes = [
      ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'],
      ['#0b132b', '#1c2541', '#3a506b', '#5bc0be', '#ffffff'],
      ['#ffbe0b', '#fb5607', '#ff006e', '#8338ec', '#3a86ff'],
      ['#606c38', '#283618', '#fefae0', '#dda15e', '#bc6c25'],
      ['#f6bd60', '#f7ede2', '#f5cac3', '#84a59d', '#f28482'],
    ];
    const p = rng.pick(palettes);
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, p[0]);
    grad.addColorStop(1, p[1]);
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    const kind = rng.int(0, 2);
    if (kind === 0) {
      // skyline: a painting of a city (that you can walk into)
      for (let i = 0; i < 18; i++) {
        g.fillStyle = rng.pick(p.slice(2));
        const w = 10 + rng.next() * 20;
        const h = 30 + rng.next() * 110;
        g.fillRect(rng.next() * W, H - h, w, h);
      }
      g.fillStyle = p[4];
      g.beginPath();
      g.arc(W * rng.range(0.2, 0.8), 40, 18, 0, Math.PI * 2);
      g.fill();
    } else if (kind === 1) {
      for (let i = 0; i < 14; i++) {
        g.fillStyle = rng.pick(p);
        g.globalAlpha = 0.75;
        g.beginPath();
        g.arc(rng.next() * W, rng.next() * H, 8 + rng.next() * 50, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    } else {
      for (let i = 0; i < 9; i++) {
        g.fillStyle = rng.pick(p);
        g.fillRect(rng.next() * W, rng.next() * H, 20 + rng.next() * 90, 10 + rng.next() * 60);
      }
    }
    noise(g, W, H, 14, rng);
    return tex(c, false);
  });
}

export function blobTex() {
  return cached('blob', () => {
    const S = 128;
    const [c, g] = canvas(S);
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.25)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    return tex(c, false);
  });
}

export function glowTex() {
  return cached('glow', () => {
    const S = 128;
    const [c, g] = canvas(S);
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.5)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    return tex(c, false);
  });
}

export function skyTex(top: string, bottom: string, stars: boolean, seed: number) {
  return cached(`sky:${top}:${bottom}:${stars}`, () => {
    const W = 1024, H = 512;
    const rng = new Rng(seed);
    const [c, g] = canvas(W, H);
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, top);
    grad.addColorStop(0.5, bottom);
    grad.addColorStop(1, bottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    if (stars) {
      for (let i = 0; i < 900; i++) {
        const y = rng.next() * H * 0.5;
        g.fillStyle = `rgba(255,255,255,${rng.next() * 0.9})`;
        g.fillRect(rng.next() * W, y, 1.2, 1.2);
      }
    } else {
      // soft clouds
      for (let i = 0; i < 40; i++) {
        const x = rng.next() * W, y = H * (0.18 + rng.next() * 0.28);
        const r = 20 + rng.next() * 60;
        const cg = g.createRadialGradient(x, y, 0, x, y, r);
        cg.addColorStop(0, 'rgba(255,255,255,0.35)');
        cg.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = cg;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      }
    }
    const t = tex(c, false);
    t.mapping = THREE.EquirectangularReflectionMapping;
    return t;
  });
}

export function signTex(text: string, bg: string, fg: string) {
  return cached(`sign:${text}:${bg}:${fg}`, () => {
    const [c, g] = canvas(512, 128);
    g.fillStyle = bg;
    g.fillRect(0, 0, 512, 128);
    g.fillStyle = fg;
    g.font = 'bold 64px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 256, 68, 480);
    return tex(c, false);
  });
}
