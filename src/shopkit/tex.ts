import * as THREE from 'three';
import { Rng } from '../rng';
import { normalFrom } from '../textures';

/**
 * Canvas textures for shop interiors: ceilings (drop tiles, pressed tin), floors (VCT),
 * pegboard, slatwall, price strips, cigarette racks, lottery tickets, menu boards, signs.
 * Textures are made once per key and shared.
 */
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
const memo = new Map<string, unknown>();
function cached<T>(key: string, make: () => T): T {
  if (!memo.has(key)) memo.set(key, make());
  return memo.get(key) as T;
}
function speckle(g: CanvasRenderingContext2D, w: number, h: number, amt: number, rng: Rng) {
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

export interface Surf {
  map: THREE.Texture;
  normal?: THREE.Texture;
  /** metres covered by one repeat */
  tile: [number, number];
}

/** 2x2 ft mineral-fibre ceiling tile in its white T-bar grid (one tile per repeat). */
export function dropTile(): Surf {
  return cached('dropTile', () => {
    const S = 256;
    const [c, g] = canvas(S);
    const rng = new Rng(11);
    g.fillStyle = '#e9e6de';
    g.fillRect(0, 0, S, S);
    // fissured mineral-fibre pits
    for (let i = 0; i < 1400; i++) {
      g.fillStyle = `rgba(90,85,75,${0.1 + rng.next() * 0.25})`;
      const x = rng.next() * S, y = rng.next() * S;
      g.fillRect(x, y, 1 + rng.next() * 2.5, 1 + rng.next() * 1.5);
    }
    speckle(g, S, S, 14, rng);
    // grid: a dark reveal then the white T-bar
    g.fillStyle = '#a8a59c';
    g.fillRect(0, 0, S, 7);
    g.fillRect(0, 0, 7, S);
    g.fillStyle = '#f6f6f2';
    g.fillRect(0, 0, S, 5);
    g.fillRect(0, 0, 5, S);
    const map = tex(c);
    const [hc, hg] = canvas(S);
    hg.drawImage(c, 0, 0);
    hg.fillStyle = '#ffffff';
    hg.fillRect(0, 0, S, 5);
    hg.fillRect(0, 0, 5, S);
    return { map, normal: normalFrom(hc, 1.5), tile: [0.61, 0.61] };
  });
}

/** Pressed-tin ceiling panel (0.61 m): beaded border, corner fans and a centre medallion. */
export function tinTile(paint: string): Surf {
  return cached(`tin:${paint}`, () => {
    const S = 512;
    // height field
    const [hc, h] = canvas(S);
    h.fillStyle = '#808080';
    h.fillRect(0, 0, S, S);
    const ring = (x: number, y: number, r: number, w: number, v: string) => {
      h.strokeStyle = v;
      h.lineWidth = w;
      h.beginPath();
      h.arc(x, y, r, 0, Math.PI * 2);
      h.stroke();
    };
    // raised border bead
    h.strokeStyle = '#f0f0f0';
    h.lineWidth = 14;
    h.strokeRect(10, 10, S - 20, S - 20);
    h.strokeStyle = '#404040';
    h.lineWidth = 4;
    h.strokeRect(24, 24, S - 48, S - 48);
    for (let i = 0; i < 24; i++) {
      const t = 40 + (i * (S - 80)) / 23;
      for (const [x, y] of [[t, 34], [t, S - 34], [34, t], [S - 34, t]]) {
        h.fillStyle = '#d8d8d8';
        h.beginPath();
        h.arc(x, y, 5, 0, Math.PI * 2);
        h.fill();
      }
    }
    // corner fans
    for (const [cx, cy] of [[48, 48], [S - 48, 48], [48, S - 48], [S - 48, S - 48]]) {
      for (let k = 1; k <= 4; k++) ring(cx, cy, k * 18, 6, k % 2 ? '#d0d0d0' : '#505050');
    }
    // centre medallion: petals and rings
    const m = S / 2;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      h.save();
      h.translate(m + Math.cos(a) * 70, m + Math.sin(a) * 70);
      h.rotate(a);
      const gr = h.createRadialGradient(0, 0, 2, 0, 0, 42);
      gr.addColorStop(0, '#f8f8f8');
      gr.addColorStop(1, '#808080');
      h.fillStyle = gr;
      h.beginPath();
      h.ellipse(0, 0, 44, 20, 0, 0, Math.PI * 2);
      h.fill();
      h.restore();
    }
    ring(m, m, 120, 10, '#e8e8e8');
    ring(m, m, 132, 4, '#505050');
    const gr = h.createRadialGradient(m, m, 4, m, m, 34);
    gr.addColorStop(0, '#ffffff');
    gr.addColorStop(1, '#808080');
    h.fillStyle = gr;
    h.beginPath();
    h.arc(m, m, 34, 0, Math.PI * 2);
    h.fill();
    // stipple field between
    const rng = new Rng(3);
    for (let i = 0; i < 2600; i++) {
      const x = 40 + rng.next() * (S - 80), y = 40 + rng.next() * (S - 80);
      if (Math.hypot(x - m, y - m) < 136) continue;
      h.fillStyle = rng.next() < 0.5 ? '#9a9a9a' : '#6a6a6a';
      h.fillRect(x, y, 3, 3);
    }
    const normal = normalFrom(hc, 4);
    // colour: paint, darker in the recesses (dirt), lighter on the high points
    const [c, g] = canvas(S);
    g.fillStyle = paint;
    g.fillRect(0, 0, S, S);
    g.globalAlpha = 0.35;
    g.globalCompositeOperation = 'multiply';
    g.drawImage(hc, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    return { map: tex(c), normal, tile: [0.61, 0.61] };
  });
}

/** 12" vinyl composition tiles, checkerboard of two colours (2x2 tiles per repeat). */
export function vctTile(a: string, b: string): Surf {
  return cached(`vct:${a}:${b}`, () => {
    const S = 256;
    const [c, g] = canvas(S);
    const rng = new Rng(5);
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 2; j++) {
        g.fillStyle = (i + j) % 2 ? b : a;
        g.fillRect(i * 128, j * 128, 128, 128);
        // terrazzo-ish mottling of VCT
        for (let k = 0; k < 220; k++) {
          g.fillStyle = `rgba(${rng.next() < 0.5 ? '255,255,255' : '0,0,0'},${0.05 + rng.next() * 0.08})`;
          g.beginPath();
          g.ellipse(i * 128 + rng.next() * 128, j * 128 + rng.next() * 128, 1 + rng.next() * 5, 1 + rng.next() * 2, rng.next() * 3, 0, Math.PI * 2);
          g.fill();
        }
      }
    speckle(g, S, S, 10, rng);
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 1.5;
    for (let i = 0; i <= 2; i++) {
      g.beginPath();
      g.moveTo(i * 128, 0);
      g.lineTo(i * 128, S);
      g.moveTo(0, i * 128);
      g.lineTo(S, i * 128);
      g.stroke();
    }
    return { map: tex(c), tile: [0.61, 0.61] };
  });
}

/** Perforated hardboard (1" hole grid), brown or white. */
export function pegboard(color: string): Surf {
  return cached(`peg:${color}`, () => {
    const S = 128; // 4 holes per repeat, 0.1016 m
    const [c, g] = canvas(S);
    g.fillStyle = color;
    g.fillRect(0, 0, S, S);
    speckle(g, S, S, 10, new Rng(2));
    const [hc, h] = canvas(S);
    h.fillStyle = '#ffffff';
    h.fillRect(0, 0, S, S);
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) {
        const x = 16 + i * 32, y = 16 + j * 32;
        g.fillStyle = '#1a1612';
        g.beginPath();
        g.arc(x, y, 5, 0, Math.PI * 2);
        g.fill();
        h.fillStyle = '#000000';
        h.beginPath();
        h.arc(x, y, 5, 0, Math.PI * 2);
        h.fill();
      }
    return { map: tex(c), normal: normalFrom(hc, 3), tile: [0.1016, 0.1016] };
  });
}

/** Slatwall: grooves every 3" with an aluminium insert. */
export function slatwall(color: string): Surf {
  return cached(`slat:${color}`, () => {
    const S = 128;
    const [c, g] = canvas(32, S);
    g.fillStyle = color;
    g.fillRect(0, 0, 32, S);
    const [hc, h] = canvas(32, S);
    h.fillStyle = '#ffffff';
    h.fillRect(0, 0, 32, S);
    for (let k = 0; k < 4; k++) {
      const y = k * 32 + 12;
      g.fillStyle = '#9a9a96';
      g.fillRect(0, y, 32, 8);
      g.fillStyle = '#2a2a2a';
      g.fillRect(0, y + 2, 32, 4);
      h.fillStyle = '#202020';
      h.fillRect(0, y, 32, 8);
    }
    return { map: tex(c), normal: normalFrom(hc, 3), tile: [0.1, 0.3048] };
  });
}

/** Rows of book spines for a bookshelf back. */
export function bookSpines(seed: number): Surf {
  return cached(`books:${seed}`, () => {
    const [c, g] = canvas(512, 128);
    const rng = new Rng(seed);
    const cols = ['#7a1d1d', '#1d3b5c', '#2e5c2e', '#c9b07a', '#3b2a1d', '#5c1d4a', '#d8d2c4', '#1a1a1a', '#8a5a1d', '#4a6a8a'];
    g.fillStyle = '#1a140e';
    g.fillRect(0, 0, 512, 128);
    let x = 0;
    while (x < 512) {
      const w = 6 + rng.next() * 14, hgt = 80 + rng.next() * 46;
      g.fillStyle = rng.pick(cols);
      g.fillRect(x, 128 - hgt, w - 1, hgt);
      g.fillStyle = 'rgba(255,230,160,0.5)';
      g.fillRect(x + 1, 128 - hgt + 8, w - 3, 2);
      g.fillRect(x + 1, 128 - hgt * 0.4, w - 3, 2);
      x += w;
    }
    return { map: tex(c), tile: [1.2, 0.3] };
  });
}

/** Shelf-edge price channel: coloured strip with white price tags. One repeat = 1.2 m. */
export function priceStrip(color: string): THREE.Texture {
  return cached(`strip:${color}`, () => {
    const [c, g] = canvas(512, 32);
    const rng = new Rng(color.length * 7 + color.charCodeAt(2));
    g.fillStyle = color;
    g.fillRect(0, 0, 512, 32);
    let x = 6;
    while (x < 500) {
      const w = 34 + rng.int(0, 14);
      const yellow = rng.next() < 0.12;
      g.fillStyle = yellow ? '#f6d62a' : '#f7f7f2';
      g.fillRect(x, 4, w, 24);
      g.fillStyle = '#111';
      g.font = 'bold 11px sans-serif';
      g.fillText(`${rng.int(0, 9)}.${rng.int(0, 9)}9`, x + 3, 21);
      for (let k = 0; k < 8; k++) g.fillRect(x + w - 14 + k * 1.5, 7, 0.8, 8);
      x += w + 16 + rng.int(0, 40);
    }
    return tex(c);
  });
}

/** Cigarette rack behind a bodega counter: rows of pack fronts (generic brands). */
export function cigRack(): THREE.Texture {
  return cached('cigs', () => {
    const [c, g] = canvas(512, 256);
    const rng = new Rng(77);
    g.fillStyle = '#111';
    g.fillRect(0, 0, 512, 256);
    const looks = [['#c8102e', '#fff'], ['#fff', '#c8102e'], ['#1d3f8a', '#fff'], ['#2e7d32', '#fff'], ['#d4af37', '#1a1a1a'], ['#f2f2f2', '#1d3f8a'], ['#6a1b9a', '#fff'], ['#111', '#d4af37']];
    for (let r = 0; r < 6; r++) {
      const y = 6 + r * 42;
      g.fillStyle = '#e8e8e8';
      g.fillRect(0, y + 34, 512, 6);
      let x = 4;
      while (x < 508) {
        const [a, b] = rng.pick(looks);
        const n = rng.int(2, 5);
        for (let k = 0; k < n && x < 508; k++) {
          g.fillStyle = a;
          g.fillRect(x, y, 15, 32);
          g.fillStyle = b;
          g.fillRect(x, y, 15, 10);
          g.fillRect(x + 3, y + 16, 9, 3);
          x += 17;
        }
        x += 2;
      }
    }
    return tex(c, false);
  });
}

/** Scratch-off ticket faces in a plexi dispenser. */
export function lottoTickets(): THREE.Texture {
  return cached('lotto', () => {
    const [c, g] = canvas(256, 256);
    const rng = new Rng(9);
    g.fillStyle = '#0d0d0d';
    g.fillRect(0, 0, 256, 256);
    const cols = ['#e53935', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#fb8c00', '#00acc1', '#d81b60'];
    for (let r = 0; r < 3; r++)
      for (let k = 0; k < 4; k++) {
        const x = 4 + k * 63, y = 4 + r * 84;
        const a = rng.pick(cols), b = rng.pick(cols);
        const gr = g.createLinearGradient(x, y, x + 58, y + 78);
        gr.addColorStop(0, a);
        gr.addColorStop(1, b);
        g.fillStyle = gr;
        g.fillRect(x, y, 58, 78);
        g.fillStyle = '#fff';
        g.font = 'bold 20px sans-serif';
        g.textAlign = 'center';
        g.fillText(`$${rng.pick([1, 2, 3, 5, 10, 20, 30])}`, x + 29, y + 30);
        g.font = 'bold 10px sans-serif';
        g.fillText(rng.pick(['WIN!', 'CASH', 'LUCKY 7s', 'GOLD', '$1,000,000', 'BINGO']), x + 29, y + 50);
        g.fillStyle = '#c0c0c0';
        g.fillRect(x + 8, y + 58, 42, 12);
      }
    return tex(c, false);
  });
}

/** Deli menu board: black, white item names, yellow prices. */
export function menuBoard(seed: number): THREE.Texture {
  return cached(`menu:${seed}`, () => {
    const [c, g] = canvas(1024, 256);
    const rng = new Rng(seed);
    g.fillStyle = '#121212';
    g.fillRect(0, 0, 1024, 256);
    const cols: [string, string[]][] = [
      ['BREAKFAST', ['BACON EGG & CHEESE', 'SAUSAGE EGG & CHEESE', 'HAM EGG & CHEESE', 'BUTTERED ROLL', 'BAGEL W/ CREAM CHEESE', 'COFFEE (LG)']],
      ['HEROS', ['CHOPPED CHEESE', 'TURKEY CLUB', 'CHICKEN CUTLET', 'ITALIAN COMBO', 'TUNA MELT', 'PASTRAMI ON RYE']],
      ['HOT FOOD', ['PHILLY CHEESESTEAK', 'BEEF PATTY', 'CHICKEN OVER RICE', 'MOZZ STICKS', 'FRIES', 'WINGS (6)']],
    ];
    cols.forEach(([head, items], i) => {
      const x = 20 + i * 336;
      g.fillStyle = '#e53935';
      g.font = 'bold 30px sans-serif';
      g.fillText(head, x, 40);
      g.font = 'bold 21px sans-serif';
      items.forEach((it, k) => {
        g.fillStyle = '#f2f2f2';
        g.fillText(it, x, 78 + k * 29, 230);
        g.fillStyle = '#ffd54f';
        g.fillText(`${rng.int(2, 13)}.${rng.pick(['00', '25', '50', '75', '99'])}`, x + 244, 78 + k * 29);
      });
    });
    return tex(c, false);
  });
}

/** A plain sign: text on a background colour (transparent if bg is ''). */
export function textTex(text: string, bg: string, fg: string, opts: { w?: number; h?: number; font?: string; border?: string } = {}): THREE.Texture {
  return cached(`text:${text}:${bg}:${fg}:${opts.w}:${opts.h}:${opts.font}:${opts.border}`, () => {
    const W = opts.w ?? 512, Hh = opts.h ?? 128;
    const [c, g] = canvas(W, Hh);
    if (bg) {
      g.fillStyle = bg;
      g.fillRect(0, 0, W, Hh);
    }
    if (opts.border) {
      g.strokeStyle = opts.border;
      g.lineWidth = Hh * 0.06;
      g.strokeRect(Hh * 0.05, Hh * 0.05, W - Hh * 0.1, Hh - Hh * 0.1);
    }
    g.fillStyle = fg;
    g.font = opts.font ?? `bold ${Math.round(Hh * 0.55)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lines = text.split('\n');
    lines.forEach((l, i) => g.fillText(l, W / 2, Hh * ((i + 0.55) / lines.length), W * 0.92));
    const t = tex(c, false);
    return t;
  });
}

/** Prismatic acrylic lens of a 2x4 troffer (emissive map). */
export function troffer(): THREE.Texture {
  return cached('troffer', () => {
    const [c, g] = canvas(64, 128);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 64, 128);
    g.fillStyle = 'rgba(200,205,215,0.5)';
    for (let i = 0; i < 64; i += 4) g.fillRect(i, 0, 1, 128);
    for (let j = 0; j < 128; j += 4) g.fillRect(0, j, 64, 1);
    g.strokeStyle = '#9a9a9a';
    g.lineWidth = 4;
    g.strokeRect(0, 0, 64, 128);
    return tex(c, false);
  });
}

/** TV / monitor screen content: a bright gradient "demo loop" frame. */
export function screenTex(seed: number): THREE.Texture {
  return cached(`screen:${seed}`, () => {
    const [c, g] = canvas(256, 144);
    const rng = new Rng(seed);
    const hues = rng.next() * 360;
    const gr = g.createLinearGradient(0, 0, 256, 144);
    gr.addColorStop(0, `hsl(${hues},70%,45%)`);
    gr.addColorStop(0.6, `hsl(${(hues + 60) % 360},80%,60%)`);
    gr.addColorStop(1, `hsl(${(hues + 140) % 360},70%,30%)`);
    g.fillStyle = gr;
    g.fillRect(0, 0, 256, 144);
    for (let i = 0; i < 5; i++) {
      g.fillStyle = `hsla(${rng.next() * 360},90%,80%,0.5)`;
      g.beginPath();
      g.arc(rng.next() * 256, rng.next() * 144, 10 + rng.next() * 40, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.font = 'bold 22px sans-serif';
    g.fillText(rng.pick(['4K ULTRA HD', 'SMART TV', 'HDR', 'OLED', 'ON SALE']), 14, 128);
    return tex(c, false);
  });
}

/** Model railway layout top: green felt, a grey ballast oval and rails. */
export function layoutTex(): THREE.Texture {
  return cached('layout', () => {
    const [c, g] = canvas(512, 256);
    const rng = new Rng(4);
    g.fillStyle = '#4f7a3a';
    g.fillRect(0, 0, 512, 256);
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(${rng.next() < 0.5 ? '30,60,20' : '120,150,80'},0.35)`;
      g.beginPath();
      g.arc(rng.next() * 512, rng.next() * 256, 2 + rng.next() * 8, 0, Math.PI * 2);
      g.fill();
    }
    const oval = (w: number, col: string, inset: number) => {
      g.strokeStyle = col;
      g.lineWidth = w;
      g.beginPath();
      g.roundRect(40 + inset, 40 + inset, 432 - inset * 2, 176 - inset * 2, 80 - inset);
      g.stroke();
    };
    oval(22, '#8a8478', 0);
    oval(2, '#5a4a3a', 0);
    oval(2, '#c0c0c0', -5);
    oval(2, '#c0c0c0', 5);
    g.fillStyle = '#3a6a9a';
    g.beginPath();
    g.ellipse(256, 128, 60, 26, 0, 0, Math.PI * 2);
    g.fill();
    return tex(c, false);
  });
}
