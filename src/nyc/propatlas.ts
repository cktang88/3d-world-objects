import * as THREE from 'three';
import { Rng } from '../rng';

/**
 * Painted texture atlases for street furniture, so every decal in a chunk bakes into one draw call:
 *  - propAtlas(): opaque decals (pedestrian signal faces, mailbox and meter fronts, newspaper boxes,
 *    steam-stack stripes, manhole covers, the subway stair illusion, posters, magazines…)
 *  - meshAtlas(): alpha-tested wire mesh (litter baskets) and similar see-through panels
 *  - signAtlas(): street-name and subway signs, allocated on demand
 */

export type Rect = [number, number, number, number]; // u0, v0, u1, v1 in uv space (v up)

const S = 2048;
/** pixel rectangles (x, y from the top-left, w, h) */
const REGIONS = {
  ped: [0, 0, 256, 256],
  pushSign: [0, 256, 128, 256],
  pushBox: [128, 256, 128, 256],
  mailFront: [256, 0, 256, 512],
  muni: [512, 0, 256, 512],
  stack: [768, 0, 256, 512],
  manhole: [1024, 0, 512, 512],
  manholeB: [1536, 0, 512, 512],
  pit: [0, 512, 512, 1024],
  news0: [512, 512, 256, 256],
  news1: [768, 512, 256, 256],
  news2: [1024, 512, 256, 256],
  news3: [1280, 512, 256, 256],
  news4: [1536, 512, 256, 256],
  barricade: [1792, 512, 256, 128],
  poster: [512, 768, 256, 512],
  poster2: [768, 768, 256, 512],
  magazines: [1024, 768, 512, 256],
  steel: [1536, 768, 256, 256],
  plywood: [1792, 768, 256, 256],
  shedSign: [1024, 1024, 512, 128],
  bikePanel: [1536, 1024, 256, 512],
  white: [1800, 1800, 16, 16],
  soil: [1536, 1536, 512, 256],
} satisfies Record<string, [number, number, number, number]>;
export type Region = keyof typeof REGIONS;

/** uv rect of a region (flipY texture: v measured from the bottom) */
export function region(r: Region): Rect {
  const [x, y, w, h] = REGIONS[r];
  const inset = 1.5;
  return [(x + inset) / S, 1 - (y + h - inset) / S, (x + w - inset) / S, 1 - (y + inset) / S];
}

/** remap a geometry's 0..1 uvs into an atlas rect (in place) */
export function toRect(g: THREE.BufferGeometry, r: Rect) {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, r[0] + uv.getX(i) * (r[2] - r[0]), r[1] + uv.getY(i) * (r[3] - r[1]));
  uv.needsUpdate = true;
  return g;
}

function paint(g: CanvasRenderingContext2D, r: Region, fn: (w: number, h: number) => void) {
  const [x, y, w, h] = REGIONS[r];
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.translate(x, y);
  fn(w, h);
  g.restore();
}

const rr = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
};

function drawHand(g: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  g.save();
  g.translate(cx, cy);
  g.scale(s, s);
  g.beginPath();
  g.roundRect(-0.36, -0.1, 0.72, 0.62, 0.15);
  for (let i = 0; i < 4; i++) g.roundRect(-0.36 + i * 0.18, -0.62 + (i === 0 || i === 3 ? 0.12 : 0), 0.15, 0.6, 0.07);
  g.roundRect(0.28, 0.0, 0.42, 0.14, 0.07);
  g.fill();
  g.restore();
}
function drawWalker(g: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  g.save();
  g.translate(cx, cy);
  g.scale(s, s);
  g.lineCap = 'round';
  g.lineWidth = 0.13;
  g.beginPath();
  g.arc(0.02, -0.62, 0.12, 0, 7);
  g.fill();
  g.beginPath();
  g.moveTo(0, -0.45); g.lineTo(-0.05, 0.08);
  g.moveTo(-0.05, 0.08); g.lineTo(-0.25, 0.6);
  g.moveTo(-0.05, 0.08); g.lineTo(0.2, 0.6);
  g.moveTo(0, -0.38); g.lineTo(-0.25, -0.05);
  g.moveTo(0, -0.38); g.lineTo(0.22, -0.1);
  g.stroke();
  g.restore();
}

/** seven-segment digits (each w × h) starting at x, y */
function sevenSeg(g: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, h: number, color: string) {
  const SEG: Record<string, string> = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcfgd' };
  const t = w * 0.18;
  g.fillStyle = color;
  [...text].forEach((ch, i) => {
    const ox = x + i * w * 1.25;
    const segs: Record<string, [number, number, number, number]> = {
      a: [ox + t, y, w - 2 * t, t], d: [ox + t, y + h - t, w - 2 * t, t], g: [ox + t, y + h / 2 - t / 2, w - 2 * t, t],
      f: [ox, y + t, t, h / 2 - 1.5 * t], b: [ox + w - t, y + t, t, h / 2 - 1.5 * t],
      e: [ox, y + h / 2 + t / 2, t, h / 2 - 1.5 * t], c: [ox + w - t, y + h / 2 + t / 2, t, h / 2 - 1.5 * t],
    };
    for (const sg of SEG[ch] ?? '') g.fillRect(...segs[sg]);
  });
}

function noise(g: CanvasRenderingContext2D, w: number, h: number, n: number, a: number, seed: number) {
  const r = new Rng(seed);
  for (let i = 0; i < n; i++) {
    g.fillStyle = r.chance(0.5) ? `rgba(0,0,0,${r.range(0, a)})` : `rgba(255,255,255,${r.range(0, a * 0.7)})`;
    g.fillRect(r.range(0, w), r.range(0, h), r.range(1, 3), r.range(1, 3));
  }
}

let atlas: THREE.MeshStandardMaterial | null = null;
let atlasEmissive: THREE.MeshStandardMaterial | null = null;
let atlasCanvas: HTMLCanvasElement | null = null;
function buildAtlas() {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, S, S);
  const r = new Rng(42);

  paint(g, 'white', (w, h) => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); });

  // tree-pit soil and mulch (2:1, stretched over a 2.4 × 1.2 m pit)
  paint(g, 'soil', (w, h) => {
    g.fillStyle = '#3a2e24';
    g.fillRect(0, 0, w, h);
    const sr = new Rng(9);
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = sr.pick(['#2a211a', '#4a3a2c', '#5b4733', '#6b5238', '#26201b', '#3f4a2a']);
      g.save();
      g.translate(sr.range(0, w), sr.range(0, h));
      g.rotate(sr.range(0, 6.28));
      g.fillRect(-sr.range(2, 6), -1, sr.range(3, 10), sr.range(1.5, 2.5));
      g.restore();
    }
    for (let i = 0; i < 90; i++) {
      g.fillStyle = sr.pick(['#4f6a2c', '#6b7a34', '#8a6a3a']);
      g.beginPath();
      g.ellipse(sr.range(0, w), sr.range(0, h), sr.range(2, 4), sr.range(1, 2), sr.range(0, 3), 0, 6.28);
      g.fill();
    }
  });

  // pedestrian signal: black face, lit orange hand, unlit white walker (NYC countdown style)
  // pedestrian countdown signal: hand / walker overlay on the left, countdown digits on the right
  paint(g, 'ped', (w, h) => {
    g.fillStyle = '#0c0c0c';
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(200,200,200,0.16)';
    drawWalker(g, w * 0.27, h * 0.54, 80);
    g.fillStyle = '#ff8a1a';
    drawHand(g, w * 0.27, h * 0.56, 78);
    // dim "88" ghost segments, then the lit count
    sevenSeg(g, '88', w * 0.56, h * 0.26, w * 0.17, h * 0.48, 'rgba(255,138,26,0.07)');
    sevenSeg(g, '12', w * 0.56, h * 0.26, w * 0.17, h * 0.48, '#ff8a1a');
    g.fillStyle = 'rgba(0,0,0,0.35)';
    for (let y = 0; y < h; y += 5) for (let x = 0; x < w; x += 5) g.fillRect(x, y, 1.5, 5), g.fillRect(x, y, 5, 1.5);
  });
  paint(g, 'pushSign', (w, h) => {
    g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#111'; g.lineWidth = 5; g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = '#111';
    drawWalker(g, w / 2, h * 0.3, 55);
    g.font = 'bold 19px Arial, sans-serif'; g.textAlign = 'center';
    ['PUSH', 'BUTTON FOR', 'AUDIBLE', 'SIGNAL'].forEach((t, i) => g.fillText(t, w / 2, h * 0.6 + i * 22, w - 20));
  });
  paint(g, 'pushBox', (w, h) => {
    g.fillStyle = '#e8b818'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#222'; g.beginPath(); g.arc(w / 2, h * 0.35, 30, 0, 7); g.fill();
    g.fillStyle = '#ddd'; g.beginPath(); g.moveTo(w / 2 - 16, h * 0.35); g.lineTo(w / 2 + 12, h * 0.35 - 12); g.lineTo(w / 2 + 12, h * 0.35 + 12); g.fill();
    noise(g, w, h, 300, 0.15, 3);
  });

  // USPS-style blue collection box front: white band text and the eagle mark
  paint(g, 'mailFront', (w, h) => {
    g.fillStyle = '#1d3f8a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#e9eef6';
    g.font = 'bold 22px Arial, sans-serif'; g.textAlign = 'center';
    g.fillText('UNITED STATES', w / 2, 60);
    g.fillText('POSTAL SERVICE', w / 2, 88);
    // eagle-head mark: white field, blue beak shape, red/white stripes
    g.save();
    g.translate(w / 2, 230);
    g.fillStyle = '#ffffff'; g.beginPath(); g.moveTo(-70, -50); g.lineTo(80, -50); g.lineTo(55, 50); g.lineTo(-70, 50); g.fill();
    g.fillStyle = '#1d3f8a';
    g.beginPath(); g.moveTo(-60, -40); g.quadraticCurveTo(20, -55, 70, -40); g.lineTo(40, -5); g.quadraticCurveTo(0, -20, -50, -10); g.fill();
    g.fillStyle = '#c8202f';
    for (let i = 0; i < 3; i++) { g.fillRect(-60, 5 + i * 14, 100 - i * 10, 6); }
    g.restore();
    g.font = 'bold 18px Arial, sans-serif'; g.fillStyle = '#e9eef6';
    g.fillText('PRIORITY MAIL', w / 2, 360); g.fillText('EXPRESS', w / 2, 384);
    noise(g, w, h, 1500, 0.12, 4);
  });

  // parking pay station front: screen, keypad, card slot, yellow coin slot, instructions
  paint(g, 'muni', (w, h) => {
    g.fillStyle = '#3a3d40'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1aa0d8'; g.fillRect(0, 0, w, 60);
    g.fillStyle = '#fff'; g.font = 'bold 26px Arial'; g.textAlign = 'center'; g.fillText('PAY HERE', w / 2, 40);
    g.fillStyle = '#d8dcd8'; rr(g, 30, 80, w - 60, 90, 6); g.fill();
    g.fillStyle = '#4a6a4a'; g.fillRect(40, 92, w - 80, 66);
    g.fillStyle = '#cfe6cf'; g.font = '16px monospace'; g.fillText('INSERT CARD', w / 2, 120); g.fillText('OR COINS', w / 2, 142);
    const cols = ['#2a8a3a', '#d8b020', '#c03030', '#2a5ab0'];
    cols.forEach((col, i) => { g.fillStyle = col; g.beginPath(); g.arc(50 + i * 52, 210, 15, 0, 7); g.fill(); });
    g.fillStyle = '#111'; g.fillRect(50, 250, 100, 14);
    g.fillStyle = '#e8c020'; rr(g, 160, 240, 50, 40, 8); g.fill();
    g.fillStyle = '#111'; g.fillRect(180, 248, 10, 24);
    g.fillStyle = '#ddd'; g.font = '13px Arial';
    ['1  Select time', '2  Pay by card or coin', '3  Display receipt', '   on dashboard'].forEach((t, i) => g.fillText(t, w / 2, 320 + i * 22));
    g.fillStyle = '#e8c020'; g.fillRect(40, 420, w - 80, 40);
    g.fillStyle = '#111'; g.font = 'bold 16px Arial'; g.fillText('RECEIPT', w / 2, 446);
    noise(g, w, h, 1200, 0.15, 5);
  });

  // steam stack: Con Ed orange/white bands with reflective strips
  paint(g, 'stack', (w, h) => {
    const n = 6;
    for (let i = 0; i < n; i++) {
      g.fillStyle = i % 2 ? '#f1efe8' : '#ee6a12';
      g.fillRect(0, (i * h) / n, w, h / n);
    }
    noise(g, w, h, 3000, 0.25, 6);
    g.fillStyle = 'rgba(40,30,20,0.25)';
    for (let i = 0; i < 40; i++) g.fillRect(r.range(0, w), r.range(0, h), r.range(2, 6), r.range(10, 60));
  });
  paint(g, 'barricade', (w, h) => {
    g.fillStyle = '#ee6a12'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#111';
    g.beginPath(); g.moveTo(30, h * 0.38); g.lineTo(150, h * 0.38); g.lineTo(150, h * 0.18); g.lineTo(220, h * 0.5); g.lineTo(150, h * 0.82); g.lineTo(150, h * 0.62); g.lineTo(30, h * 0.62); g.fill();
    noise(g, w, h, 600, 0.2, 7);
  });

  // manhole covers: Con Edison style concentric rings of bosses; and a radial "sewer" pattern
  const cover = (key: Region, kind: number) =>
    paint(g, key, (w, h) => {
      const cx = w / 2, cy = h / 2, R = w / 2;
      g.fillStyle = '#2c2a28'; g.fillRect(0, 0, w, h);
      const grad = g.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
      grad.addColorStop(0, '#5a524a'); grad.addColorStop(0.8, '#4a433c'); grad.addColorStop(1, '#3a3631');
      g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, R - 4, 0, 7); g.fill();
      g.strokeStyle = '#25221f'; g.lineWidth = 8; g.beginPath(); g.arc(cx, cy, R - 10, 0, 7); g.stroke();
      if (kind === 0) {
        for (let ring = 1; ring < 6; ring++) {
          const rad = (ring / 6) * (R - 20);
          const n = Math.max(6, Math.round(ring * 7));
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2;
            g.strokeStyle = '#7a6e60'; g.lineWidth = 5;
            g.beginPath(); g.arc(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, 12, 0, 7); g.stroke();
            g.fillStyle = '#2e2a26'; g.beginPath(); g.arc(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, 5, 0, 7); g.fill();
          }
        }
        g.fillStyle = '#7a6e60'; g.font = 'bold 34px Arial'; g.textAlign = 'center'; g.fillText('CON', cx, cy - 4); g.fillText('ED', cx, cy + 30);
      } else {
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          g.strokeStyle = '#776b5d'; g.lineWidth = 6;
          g.beginPath(); g.moveTo(cx + Math.cos(a) * 50, cy + Math.sin(a) * 50); g.lineTo(cx + Math.cos(a) * (R - 26), cy + Math.sin(a) * (R - 26)); g.stroke();
        }
        g.strokeStyle = '#776b5d'; g.lineWidth = 6;
        for (const rad of [50, 120, 190]) { g.beginPath(); g.arc(cx, cy, rad, 0, 7); g.stroke(); }
        g.fillStyle = '#8a7e70'; g.font = 'bold 28px Arial'; g.textAlign = 'center'; g.fillText('SEWER', cx, cy + 10);
      }
      // rust and wear: polished high points, rusty low points
      const rr2 = new Rng(kind + 50);
      for (let i = 0; i < 600; i++) {
        g.fillStyle = rr2.chance(0.5) ? `rgba(120,70,40,${rr2.range(0.05, 0.25)})` : `rgba(170,165,155,${rr2.range(0.03, 0.15)})`;
        g.beginPath(); g.arc(rr2.range(0, w), rr2.range(0, h), rr2.range(2, 10), 0, 7); g.fill();
      }
    });
  cover('manhole', 0);
  cover('manholeB', 1);

  // subway stair illusion: steps descending into darkness, tiled walls either side
  paint(g, 'pit', (w, h) => {
    g.fillStyle = '#050505'; g.fillRect(0, 0, w, h);
    const steps = 16;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const y = t * h;
      const shade = Math.max(0, 150 - t * 170);
      g.fillStyle = `rgb(${shade},${shade * 0.98},${shade * 0.94})`;
      g.fillRect(w * 0.12, y, w * 0.76, h / steps * 0.62);
      g.fillStyle = `rgb(${shade * 0.6},${shade * 0.6},${shade * 0.58})`;
      g.fillRect(w * 0.12, y + h / steps * 0.62, w * 0.76, h / steps * 0.38);
      // yellow nosing strips
      g.fillStyle = `rgba(210,170,40,${Math.max(0, 0.9 - t)})`;
      g.fillRect(w * 0.12, y, w * 0.76, 5);
    }
    // walls: cream tiles fading
    for (const x0 of [0, w * 0.88]) {
      for (let y = 0; y < h; y += 16) for (let x = x0; x < x0 + w * 0.12; x += 22) {
        const t = y / h;
        const v = Math.max(0, 200 - t * 230);
        g.fillStyle = `rgb(${v},${v * 0.96},${v * 0.86})`;
        g.fillRect(x + 1, y + 1, 20, 14);
      }
    }
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,0.95)');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  });

  // newspaper / free-paper boxes: coloured fronts with a window and generic mastheads
  const papers: [string, string, string][] = [
    ['#c8202a', '#ffffff', 'DAILY'], ['#1e4fa3', '#ffffff', 'METRO'], ['#f0b400', '#111111', 'FREE'], ['#f2f2ee', '#c8202a', 'NEWS'], ['#2a7a3a', '#ffffff', 'WEEKLY'],
  ];
  papers.forEach(([bg, fg, label], i) =>
    paint(g, `news${i}` as Region, (w, h) => {
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      g.fillStyle = fg; g.font = 'bold 44px Arial'; g.textAlign = 'center'; g.fillText(label, w / 2, 52, w - 20);
      // window with a folded paper behind it
      g.fillStyle = '#20262a'; g.fillRect(28, 70, w - 56, 120);
      g.fillStyle = '#e8e6de'; g.fillRect(40, 84, w - 80, 100);
      g.fillStyle = '#333'; g.font = 'bold 20px Georgia'; g.fillText('HEADLINE', w / 2, 112, w - 100);
      for (let k = 0; k < 4; k++) g.fillRect(50, 124 + k * 12, w - 100, 4);
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(28, 70, w - 56, 40);
      g.fillStyle = '#888'; g.fillRect(w / 2 - 30, 205, 60, 14);
      noise(g, w, h, 600, 0.2, 10 + i);
    }),
  );

  // advertising posters for the bus shelter / kiosks: generic abstract ads
  const poster = (key: Region, seed: number) =>
    paint(g, key, (w, h) => {
      const pr = new Rng(seed);
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, `hsl(${pr.range(0, 360)},60%,55%)`); grad.addColorStop(1, `hsl(${pr.range(0, 360)},55%,30%)`);
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.beginPath(); g.arc(w * 0.5, h * 0.42, w * 0.3, 0, 7); g.fill();
      g.fillStyle = `hsl(${pr.range(0, 360)},70%,45%)`;
      g.beginPath(); g.arc(w * 0.5, h * 0.42, w * 0.18, 0, 7); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 34px Arial'; g.textAlign = 'center';
      g.fillText(pr.pick(['SUMMER', 'NEW', 'OPEN', 'LIVE', 'FRESH']), w / 2, h * 0.75);
      g.font = '18px Arial'; g.fillText(pr.pick(['coming soon', 'now showing', 'this season', 'tickets on sale']), w / 2, h * 0.82);
    });
  poster('poster', 3);
  poster('poster2', 8);

  // newsstand magazine rack
  paint(g, 'magazines', (w, h) => {
    g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, w, h);
    for (let row = 0; row < 3; row++)
      for (let i = 0; i < 12; i++) {
        const x = i * (w / 12) + 3, y = row * (h / 3) + 6;
        g.fillStyle = `hsl(${r.range(0, 360)},${r.range(30, 80)}%,${r.range(35, 70)}%)`;
        g.fillRect(x, y, w / 12 - 6, h / 3 - 12);
        g.fillStyle = 'rgba(255,255,255,0.8)'; g.fillRect(x + 3, y + 4, w / 12 - 12, 6);
        g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x + 4, y + 30, w / 12 - 14, 22);
      }
  });

  // brushed / painted steel and plywood
  paint(g, 'steel', (w, h) => {
    g.fillStyle = '#7d8284'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(255,255,255,${r.range(0, 0.06)})`; g.fillRect(0, r.range(0, h), w, 1); }
    noise(g, w, h, 800, 0.1, 12);
  });
  paint(g, 'plywood', (w, h) => {
    g.fillStyle = '#2f4a3a'; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 64) { g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x, 0, 2, h); }
    noise(g, w, h, 1500, 0.15, 13);
  });
  paint(g, 'shedSign', (w, h) => {
    g.fillStyle = '#f2f2ec'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#111'; g.font = 'bold 30px Arial'; g.textAlign = 'center';
    g.fillText('SIDEWALK SHED PERMIT', w / 2, 52); g.font = '20px Arial'; g.fillText('POST NO BILLS', w / 2, 96);
  });
  paint(g, 'bikePanel', (w, h) => {
    g.fillStyle = '#c9ccce'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1b6fd0'; g.fillRect(0, 0, w, 80);
    g.fillStyle = '#fff'; g.font = 'bold 30px Arial'; g.textAlign = 'center'; g.fillText('BIKE SHARE', w / 2, 52);
    g.fillStyle = '#222'; g.fillRect(30, 110, w - 60, 140);
    g.fillStyle = '#5ab0ff'; g.fillRect(40, 120, w - 80, 120);
    g.fillStyle = '#333'; g.font = '16px Arial';
    ['Station map', 'Ride with care', 'Dock to end ride'].forEach((t, i) => g.fillText(t, w / 2, 300 + i * 26));
    // map grid
    g.strokeStyle = '#999'; g.lineWidth = 2;
    for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(30, 380 + i * 20); g.lineTo(w - 30, 380 + i * 20); g.stroke(); }
  });
  return c;
}

function atlasTexture() {
  atlasCanvas ??= buildAtlas();
  const t = new THREE.CanvasTexture(atlasCanvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** opaque decal atlas (roughness / metalness chosen per use via the two variants) */
export function propAtlas() {
  return (atlas ??= new THREE.MeshStandardMaterial({ map: atlasTexture(), roughness: 0.55, metalness: 0.15 }));
}
/** same atlas, self-lit: pedestrian signals, ad light boxes, the station sign */
export function propAtlasLit() {
  if (!atlasEmissive) {
    const m = propAtlas();
    atlasEmissive = new THREE.MeshStandardMaterial({ map: m.map, emissiveMap: m.map, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.9, roughness: 0.3 });
  }
  return atlasEmissive;
}

// ---------------------------------------------------------------- alpha-tested wire mesh

let meshMat: THREE.MeshStandardMaterial | null = null;
/** expanded-metal / wire mesh, painted dark green (litter baskets) — uv repeats */
export function wireMesh() {
  if (meshMat) return meshMat;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 7;
  // diamond lattice
  for (let i = -2; i < 4; i++) {
    g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64 + 128, 128); g.stroke();
    g.beginPath(); g.moveTo(i * 64 + 128, 0); g.lineTo(i * 64, 128); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  meshMat = new THREE.MeshStandardMaterial({ color: '#1f4a33', alphaMap: t, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.55, metalness: 0.4 });
  meshMat.userData.pbr = true; // bake(): keep its own bucket (alpha map)
  return meshMat;
}

// ---------------------------------------------------------------- sign atlas

const SIGN_W = 512, SIGN_H = 80, COLS = 4, ROWS = 25;
interface SignAtlas { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; mat: THREE.MeshStandardMaterial; slots: Map<string, number> }
let signAtlasCur: SignAtlas | null = null;

function newSignAtlas(): SignAtlas {
  const canvas = document.createElement('canvas');
  canvas.width = SIGN_W * COLS;
  canvas.height = 2048;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, metalness: 0.1 });
  return { canvas, tex, mat, slots: new Map() };
}

export type SignStyle = 'street' | 'subway';
/** street names: "W 34 St" → big "W 34" + small raised "St" like NYC signs */
function drawSign(g: CanvasRenderingContext2D, text: string, style: SignStyle, w: number, h: number) {
  if (style === 'street') {
    g.fillStyle = '#0b6b3c';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#f4f4f0';
    g.lineWidth = 4;
    g.beginPath(); g.roundRect(5, 5, w - 10, h - 10, 8); g.stroke();
    g.fillStyle = '#f7f7f2';
    g.textBaseline = 'alphabetic';
    const m = text.match(/^(.*?)(\s(St|Av|Pl|Blvd|Dr))$/);
    const main = m ? m[1] : text, suf = m ? m[3] : '';
    g.font = 'bold 50px "Highway Gothic", "Arial Narrow", Arial, sans-serif';
    const mw = Math.min(g.measureText(main).width, w - 110);
    g.font = 'bold 28px "Arial Narrow", Arial, sans-serif';
    const sw = suf ? g.measureText(suf).width + 8 : 0;
    const x0 = (w - mw - sw) / 2;
    g.font = 'bold 50px "Highway Gothic", "Arial Narrow", Arial, sans-serif';
    g.textAlign = 'left';
    g.fillText(main, x0, 59, w - 110);
    if (suf) {
      g.font = 'bold 28px "Arial Narrow", Arial, sans-serif';
      g.fillText(suf, x0 + mw + 8, 40);
    }
  } else {
    // subway: black band, white Helvetica name, coloured route bullets on the right
    g.fillStyle = '#0f0f0f';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f2f2';
    g.fillRect(0, 6, w, 3);
    const [name, lines] = text.split('|');
    g.font = 'bold 36px Helvetica, Arial, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(name, 14, h / 2 + 4, w * 0.55);
    const ROUTE: Record<string, string> = { '1': '#ee352e', '2': '#ee352e', '3': '#ee352e', '4': '#00933c', '5': '#00933c', '6': '#00933c', A: '#0039a6', C: '#0039a6', E: '#0039a6', B: '#ff6319', D: '#ff6319', F: '#ff6319', M: '#ff6319', N: '#fccc0a', Q: '#fccc0a', R: '#fccc0a', W: '#fccc0a', L: '#a7a9ac', '7': '#b933ad', G: '#6cbe45', J: '#996633', Z: '#996633' };
    const ls = (lines ?? '').split(' ').filter(Boolean);
    ls.forEach((l, i) => {
      const cx = w - 30 - (ls.length - 1 - i) * 52;
      g.fillStyle = ROUTE[l] ?? '#888';
      g.beginPath(); g.arc(cx, h / 2 + 2, 23, 0, 7); g.fill();
      g.fillStyle = ['N', 'Q', 'R', 'W'].includes(l) ? '#111' : '#fff';
      g.font = 'bold 30px Helvetica, Arial';
      g.textAlign = 'center';
      g.fillText(l, cx, h / 2 + 4);
    });
  }
}

/** material + uv rect for a sign text (allocates a slot in the current sign atlas) */
export function signSlot(text: string, style: SignStyle = 'street'): { mat: THREE.MeshStandardMaterial; rect: Rect } {
  const key = `${style}|${text}`;
  if (!signAtlasCur || (!signAtlasCur.slots.has(key) && signAtlasCur.slots.size >= COLS * ROWS)) signAtlasCur = newSignAtlas();
  const A = signAtlasCur;
  let i = A.slots.get(key);
  if (i === undefined) {
    i = A.slots.size;
    A.slots.set(key, i);
    const g = A.canvas.getContext('2d')!;
    const x = (i % COLS) * SIGN_W, y = Math.floor(i / COLS) * SIGN_H;
    g.save();
    g.translate(x, y);
    g.beginPath(); g.rect(0, 0, SIGN_W, SIGN_H); g.clip();
    drawSign(g, text, style, SIGN_W, SIGN_H);
    g.restore();
    A.tex.needsUpdate = true;
  }
  const x = (i % COLS) * SIGN_W, y = Math.floor(i / COLS) * SIGN_H;
  const H = A.canvas.height, W = A.canvas.width;
  return { mat: A.mat, rect: [(x + 2) / W, 1 - (y + SIGN_H - 2) / H, (x + SIGN_W - 2) / W, 1 - (y + 2) / H] };
}
