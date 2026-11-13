import * as THREE from 'three';
import { Rng } from '../rng';
import { FLAGS } from '../flags';
import { WF_TIME, WF_NIGHT } from './waterfront';

/**
 * [nbhd] Times Square screens (docs/research/neighborhood-audit.md): one procedural ad atlas with many layouts
 * — Broadway show posters, product hero shots (sneaker, phone, bottle, burger, car, watch, headphones, perfume),
 * faces and people silhouettes, big-type brand walls, gradients and logos, a news ticker and a stock ticker —
 * drawn on LED screens: a pixel grid that shows up close and fades with distance, emissive (blooming at night),
 * and some screens animated in the shader (scrolling tickers, crossfading slides). Still ONE mesh per block.
 */

const COLS = 4, ROWS = 8, CW = 512, CH = 256;
/** the last row holds two full-width ticker strips (each 2 cells wide); the others are 1×1 ads */
const AD_CELLS = COLS * (ROWS - 1);

type G = CanvasRenderingContext2D;
const PALETTES: [string, string, string][] = [
  ['#0b0b12', '#f5c400', '#ffffff'], ['#e8202a', '#ffffff', '#1a1a1a'], ['#1d4fd8', '#ffffff', '#ffd400'], ['#0c0c0c', '#2fe0ff', '#ff2fa0'],
  ['#ff4f9a', '#ffffff', '#3a0a2a'], ['#14a34a', '#ffffff', '#0a2a14'], ['#6b2fd8', '#ffe14f', '#ffffff'], ['#ff7a00', '#ffffff', '#3a1a00'],
  ['#f2efe8', '#101010', '#c8102e'], ['#002b5c', '#c9a65a', '#ffffff'], ['#101820', '#e8e8e8', '#ff5a1f'], ['#ffd400', '#111111', '#e8202a'],
];
const BRANDS = ['VOLTA', 'NOVA', 'KITE', 'ORBIT', 'PULSE', 'ZEST', 'LUMEN', 'AXIS', 'MAVEN', 'RIO', 'HALO', 'BOLT', 'FJORD', 'ECHO', 'NIMBUS', 'APEX'];
const SHOWS = ['THE PHANTOM HOUR', 'LION OF THE NILE', 'WICKED GAME', 'HAMILTON STREET', 'MOULIN NOIR', 'CHICAGO NIGHTS', 'THE BOOK OF MAPS', 'ALADDIN\'S LAMP', 'SIX QUEENS', 'MAMMA SOL'];
const TAGS = ['JUST DROPPED', 'NOW STREAMING', 'LIMITED EDITION', 'TONIGHT 8PM', 'NEW SEASON', 'TASTE THE CITY', 'THINK FASTER', 'MADE IN NY', 'ON SALE NOW', 'ONLY IN THEATERS'];

function grad(g: G, x: number, y: number, w: number, h: number, a: string, b: string, vertical = false) {
  const gr = vertical ? g.createLinearGradient(x, y, x, y + h) : g.createLinearGradient(x, y, x + w, y + h);
  gr.addColorStop(0, a);
  gr.addColorStop(1, b);
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
}
function text(g: G, s: string, x: number, y: number, size: number, color: string, maxW: number, font = 'Impact, "Arial Black", sans-serif', align: CanvasTextAlign = 'left') {
  g.font = `bold ${size}px ${font}`;
  g.textAlign = align;
  g.fillStyle = color;
  g.fillText(s, x, y, maxW);
  g.textAlign = 'left';
}
function glow(g: G, x: number, y: number, r: number, color: string) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, color);
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(x - r, y - r, r * 2, r * 2);
}

// ---------------------------------------------------------------- product hero shots (shaded silhouettes)

function shade(g: G, x: number, y: number, w: number, h: number, base: string, hi = 'rgba(255,255,255,0.55)') {
  const gr = g.createLinearGradient(x, y, x + w, y + h);
  gr.addColorStop(0, hi);
  gr.addColorStop(0.35, base);
  gr.addColorStop(1, 'rgba(0,0,0,0.6)');
  return gr;
}
const PRODUCTS: ((g: G, x: number, y: number, s: number, c: string) => void)[] = [
  // sneaker
  (g, x, y, s, c) => {
    g.save(); g.translate(x, y); g.scale(s, s);
    g.fillStyle = '#f4f4f4'; g.beginPath(); g.moveTo(-90, 30); g.lineTo(95, 30); g.quadraticCurveTo(105, 18, 92, 10); g.lineTo(-90, 18); g.closePath(); g.fill();
    g.fillStyle = shade(g, -90, -40, 180, 60, c); g.beginPath(); g.moveTo(-88, 18); g.quadraticCurveTo(-92, -30, -55, -38); g.lineTo(-20, -30); g.quadraticCurveTo(30, -10, 92, 10); g.lineTo(-88, 18); g.fill();
    g.strokeStyle = '#ffffff'; g.lineWidth = 6; g.beginPath(); g.moveTo(-40, 8); g.quadraticCurveTo(10, -18, 60, 4); g.stroke();
    g.restore();
  },
  // phone
  (g, x, y, s, c) => {
    g.save(); g.translate(x, y); g.scale(s, s); g.rotate(-0.18);
    g.fillStyle = '#16181c'; roundRect(g, -38, -78, 76, 156, 14); g.fill();
    g.fillStyle = shade(g, -32, -70, 64, 140, c, 'rgba(255,255,255,0.8)'); roundRect(g, -32, -70, 64, 140, 9); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.25)'; g.beginPath(); g.moveTo(-32, -70); g.lineTo(10, -70); g.lineTo(-32, 20); g.fill();
    g.restore();
  },
  // bottle
  (g, x, y, s, c) => {
    g.save(); g.translate(x, y); g.scale(s, s);
    g.fillStyle = shade(g, -26, -90, 52, 180, c, 'rgba(255,255,255,0.7)');
    g.beginPath(); g.moveTo(-9, -90); g.lineTo(9, -90); g.lineTo(9, -60); g.quadraticCurveTo(28, -40, 26, -10); g.lineTo(26, 80); g.quadraticCurveTo(0, 92, -26, 80); g.lineTo(-26, -10); g.quadraticCurveTo(-28, -40, -9, -60); g.closePath(); g.fill();
    g.fillStyle = '#ffffff'; g.fillRect(-26, 0, 52, 30);
    g.fillStyle = c; g.font = 'bold 18px Impact, sans-serif'; g.textAlign = 'center'; g.fillText('FIZZ', 0, 22); g.textAlign = 'left';
    for (let i = 0; i < 9; i++) { g.fillStyle = 'rgba(255,255,255,0.5)'; g.beginPath(); g.arc(-20 + (i * 37) % 40, -20 + (i * 53) % 90, 2.5, 0, 7); g.fill(); }
    g.restore();
  },
  // burger
  (g, x, y, s) => {
    g.save(); g.translate(x, y); g.scale(s, s);
    g.fillStyle = shade(g, -80, -70, 160, 50, '#d58a2a'); g.beginPath(); g.ellipse(0, -30, 80, 42, 0, Math.PI, 0); g.fill();
    g.fillStyle = '#4caf3c'; g.fillRect(-84, -32, 168, 10);
    g.fillStyle = '#f2c230'; g.beginPath(); g.moveTo(-82, -22); g.lineTo(82, -22); g.lineTo(60, -8); g.lineTo(-60, -8); g.fill();
    g.fillStyle = '#5a2e18'; roundRect(g, -80, -14, 160, 24, 10); g.fill();
    g.fillStyle = '#c4302a'; g.fillRect(-76, 10, 152, 8);
    g.fillStyle = '#c98a3a'; roundRect(g, -78, 18, 156, 26, 12); g.fill();
    for (let i = 0; i < 12; i++) { g.fillStyle = '#f6e7c0'; g.beginPath(); g.ellipse(-55 + i * 10, -52 + (i % 3) * 6, 3, 1.6, 0.5, 0, 7); g.fill(); }
    g.restore();
  },
  // car
  (g, x, y, s, c) => {
    g.save(); g.translate(x, y); g.scale(s, s);
    g.fillStyle = shade(g, -120, -40, 240, 70, c, 'rgba(255,255,255,0.75)');
    g.beginPath(); g.moveTo(-120, 20); g.lineTo(-115, -5); g.lineTo(-60, -12); g.lineTo(-25, -40); g.lineTo(45, -40); g.lineTo(85, -10); g.lineTo(120, -2); g.lineTo(122, 20); g.closePath(); g.fill();
    g.fillStyle = 'rgba(20,30,40,0.85)'; g.beginPath(); g.moveTo(-50, -13); g.lineTo(-22, -35); g.lineTo(40, -35); g.lineTo(70, -12); g.closePath(); g.fill();
    for (const wx of [-72, 72]) { g.fillStyle = '#111'; g.beginPath(); g.arc(wx, 20, 22, 0, 7); g.fill(); g.fillStyle = '#bbb'; g.beginPath(); g.arc(wx, 20, 11, 0, 7); g.fill(); }
    g.restore();
  },
  // watch
  (g, x, y, s, c) => {
    g.save(); g.translate(x, y); g.scale(s, s);
    g.fillStyle = '#2a2a2a'; g.fillRect(-22, -95, 44, 190);
    g.fillStyle = shade(g, -55, -55, 110, 110, '#c9a65a', 'rgba(255,255,240,0.9)'); g.beginPath(); g.arc(0, 0, 55, 0, 7); g.fill();
    g.fillStyle = c; g.beginPath(); g.arc(0, 0, 45, 0, 7); g.fill();
    g.strokeStyle = '#ffffff'; g.lineWidth = 4; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -34); g.moveTo(0, 0); g.lineTo(24, 10); g.stroke();
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; g.fillStyle = '#fff'; g.fillRect(Math.cos(a) * 38 - 2, Math.sin(a) * 38 - 2, 4, 4); }
    g.restore();
  },
  // headphones
  (g, x, y, s, c) => {
    g.save(); g.translate(x, y); g.scale(s, s);
    g.strokeStyle = '#1a1a1a'; g.lineWidth = 16; g.beginPath(); g.arc(0, 10, 70, Math.PI * 1.05, Math.PI * 1.95); g.stroke();
    for (const sx of [-1, 1]) { g.fillStyle = shade(g, sx * 70 - 28, -10, 56, 80, c); roundRect(g, sx * 70 - 26, -5, 52, 78, 22); g.fill(); }
    g.restore();
  },
  // perfume
  (g, x, y, s, c) => {
    g.save(); g.translate(x, y); g.scale(s, s);
    g.fillStyle = '#c9a65a'; g.fillRect(-16, -88, 32, 26);
    g.fillStyle = shade(g, -50, -62, 100, 140, c, 'rgba(255,255,255,0.85)'); roundRect(g, -50, -62, 100, 140, 18); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(-38, -50, 14, 110);
    g.restore();
  },
];
function roundRect(g: G, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
/** a head-and-shoulders portrait (a model, a star): skin gradient, hair, shoulders, rim light */
function face(g: G, x: number, y: number, s: number, r: Rng, rim: string) {
  g.save(); g.translate(x, y); g.scale(s, s);
  const skin = r.pick(['#f1c7a5', '#d9a07a', '#a8714a', '#7a4a2c', '#5a3420']);
  const hair = r.pick(['#1a120c', '#3a2414', '#c9a060', '#7a2a1a', '#101010']);
  g.fillStyle = r.pick(['#111', '#f2f2f2', '#2a3a6a', '#8a1a2a']); g.beginPath(); g.moveTo(-110, 140); g.quadraticCurveTo(-100, 40, 0, 40); g.quadraticCurveTo(100, 40, 110, 140); g.fill();
  g.fillStyle = skin; g.fillRect(-18, 10, 36, 40);
  g.fillStyle = shade(g, -48, -70, 96, 120, skin, 'rgba(255,255,255,0.35)'); g.beginPath(); g.ellipse(0, -15, 46, 60, 0, 0, 7); g.fill();
  g.fillStyle = hair; g.beginPath(); g.ellipse(0, -48, 52, 38, 0, Math.PI, 0); g.fill();
  if (r.chance(0.5)) { g.beginPath(); g.ellipse(-40, -5, 18, 60, 0.1, 0, 7); g.ellipse(40, -5, 18, 60, -0.1, 0, 7); g.fill(); }
  g.fillStyle = 'rgba(30,20,20,0.85)'; for (const sx of [-1, 1]) { g.beginPath(); g.ellipse(sx * 17, -18, 7, 4, 0, 0, 7); g.fill(); }
  g.strokeStyle = 'rgba(120,40,40,0.8)'; g.lineWidth = 4; g.beginPath(); g.arc(0, 12, 14, 0.2, Math.PI - 0.2); g.stroke();
  g.globalCompositeOperation = 'lighter'; glow(g, 50, -40, 70, rim); g.globalCompositeOperation = 'source-over';
  g.restore();
}
/** dancers / a crowd in silhouette against a light (show posters, sports, concerts) */
function silhouettes(g: G, x: number, y: number, w: number, h: number, n: number, color: string, r: Rng) {
  g.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const px = x + (w * (i + 0.5)) / n + r.range(-10, 10), s = r.range(0.7, 1.15) * (h / 200);
    g.save(); g.translate(px, y + h); g.scale(s, s);
    const arm = r.range(-1.2, 1.2), leg = r.range(0.1, 0.5);
    g.beginPath(); g.arc(0, -170, 14, 0, 7); g.fill();
    g.fillRect(-13, -155, 26, 70);
    g.save(); g.translate(-10, -150); g.rotate(-1 + arm); g.fillRect(-5, 0, 10, 60); g.restore();
    g.save(); g.translate(10, -150); g.rotate(1 - arm * 0.5); g.fillRect(-5, 0, 10, 60); g.restore();
    g.save(); g.translate(-7, -88); g.rotate(leg); g.fillRect(-6, 0, 12, 88); g.restore();
    g.save(); g.translate(7, -88); g.rotate(-leg); g.fillRect(-6, 0, 12, 88); g.restore();
    g.restore();
  }
}

/** one ad in cell (x, y, CW, CH), layout k */
function drawAd(g: G, x: number, y: number, k: number, r: Rng) {
  const [bg, fg, ac] = PALETTES[k % PALETTES.length];
  const layout = k % 8;
  g.save();
  g.beginPath(); g.rect(x, y, CW, CH); g.clip();
  const brand = r.pick(BRANDS), tag = r.pick(TAGS);
  if (layout === 0) {
    // product hero: gradient studio backdrop, spotlight, product, brand + tagline
    grad(g, x, y, CW, CH, bg, '#000000');
    glow(g, x + 360, y + 128, 170, 'rgba(255,255,255,0.35)');
    PRODUCTS[r.int(0, PRODUCTS.length - 1)](g, x + 360, y + 135, r.range(0.95, 1.2), ac === '#ffffff' ? fg : ac);
    text(g, brand, x + 26, y + 110, 70, fg, 250);
    text(g, tag, x + 28, y + 150, 26, '#ffffff', 240, 'Helvetica, Arial, sans-serif');
    g.fillStyle = fg; g.fillRect(x + 28, y + 168, 90, 6);
  } else if (layout === 1) {
    // Broadway poster: black, a gold title, silhouettes of the cast under a spotlight, the theatre line
    grad(g, x, y, CW, CH, '#060608', bg, true);
    glow(g, x + 256, y + 220, 220, 'rgba(255,220,150,0.45)');
    silhouettes(g, x + 120, y + 60, 280, 190, r.int(3, 6), '#050505', r);
    const show = r.pick(SHOWS);
    text(g, show, x + 256, y + 58, 50, '#f5c400', 480, 'Georgia, "Times New Roman", serif', 'center');
    text(g, 'NOW PLAYING · ' + r.pick(['MAJESTIC', 'GERSHWIN', 'MINSKOFF', 'AL HIRSCHFELD', 'WINTER GARDEN']) + ' THEATRE', x + 256, y + 244, 18, '#ffffff', 480, 'Helvetica, Arial, sans-serif', 'center');
  } else if (layout === 2) {
    // fashion / beauty: a portrait with rim light on a gradient, a thin elegant logotype
    grad(g, x, y, CW, CH, ac === '#ffffff' ? bg : ac, '#0b0b10');
    face(g, x + 360, y + 130, 1.05, r, 'rgba(255,200,230,0.6)');
    text(g, brand, x + 30, y + 120, 64, '#ffffff', 260, 'Didot, Georgia, serif');
    text(g, r.pick(['PARIS · NEW YORK', 'EAU DE PARFUM', 'THE NEW FRAGRANCE', 'FALL COLLECTION']), x + 32, y + 156, 18, '#ffffff', 260, 'Helvetica, Arial, sans-serif');
  } else if (layout === 3) {
    // big type brand wall: huge brand across, a logo mark
    g.fillStyle = bg; g.fillRect(x, y, CW, CH);
    g.fillStyle = ac; g.beginPath(); g.arc(x + 70, y + 128, 50, 0, 7); g.fill();
    g.fillStyle = bg; g.beginPath(); g.arc(x + 70, y + 128, 28, 0, 7); g.fill();
    text(g, brand, x + 140, y + 165, 120, fg, 360);
    g.fillStyle = fg; g.fillRect(x + 140, y + 185, 350, 8);
  } else if (layout === 4) {
    // streaming / movie: a dark key-art with a figure, a lens flare, the title and a date
    grad(g, x, y, CW, CH, '#04060c', bg, false);
    silhouettes(g, x + 290, y + 30, 120, 220, 1, '#020203', r);
    g.globalCompositeOperation = 'lighter'; glow(g, x + 350, y + 70, 120, 'rgba(120,200,255,0.5)'); g.globalCompositeOperation = 'source-over';
    text(g, r.pick(['NIGHTFALL', 'THE LAST SIGNAL', 'IRON HARBOR', 'BLUE HOUR', 'ZERO POINT']), x + 26, y + 120, 56, '#ffffff', 270);
    text(g, r.pick(['NOW STREAMING', 'ONLY IN THEATERS', 'FRIDAY']), x + 28, y + 158, 22, ac, 260, 'Helvetica, Arial, sans-serif');
  } else if (layout === 5) {
    // sports / sneaker: diagonal stripes, an athlete silhouette mid-stride, a slogan
    g.fillStyle = bg; g.fillRect(x, y, CW, CH);
    g.fillStyle = ac;
    for (let i = -2; i < 6; i++) { g.beginPath(); g.moveTo(x + i * 110, y + CH); g.lineTo(x + i * 110 + 60, y + CH); g.lineTo(x + i * 110 + 200, y); g.lineTo(x + i * 110 + 140, y); g.fill(); }
    g.globalAlpha = 0.9; silhouettes(g, x + 300, y + 30, 120, 220, 1, '#0a0a0a', r); g.globalAlpha = 1;
    text(g, r.pick(['JUST RUN', 'PLAY LOUD', 'NO OFF DAYS', 'BE FASTER']), x + 24, y + 120, 64, fg, 280);
    text(g, brand, x + 26, y + 160, 28, fg, 200);
  } else if (layout === 6) {
    // food / drink: a warm gradient, a big product, a price burst
    grad(g, x, y, CW, CH, ac === '#ffffff' ? '#ffb000' : ac, bg);
    PRODUCTS[r.pick([2, 3])](g, x + 150, y + 140, 1.25, bg);
    g.fillStyle = '#ffd400'; g.beginPath();
    for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2, rr = i % 2 ? 46 : 60; g.lineTo(x + 420 + Math.cos(a) * rr, y + 70 + Math.sin(a) * rr); }
    g.fill();
    text(g, '$' + r.int(1, 9) + '.99', x + 420, y + 82, 32, '#c8102e', 90, 'Impact, sans-serif', 'center');
    text(g, brand, x + 290, y + 200, 58, '#ffffff', 210);
  } else {
    // tech / bank: clean white, a device, a minimalist line, a QR-ish block
    grad(g, x, y, CW, CH, '#f6f6f4', '#d8dde2');
    PRODUCTS[r.pick([1, 5, 6])](g, x + 130, y + 128, 1.0, bg);
    text(g, brand, x + 260, y + 118, 58, '#111111', 230, 'Helvetica, Arial, sans-serif');
    text(g, r.pick(['Think faster.', 'Bank anywhere.', 'All-day power.', 'Hear everything.']), x + 262, y + 152, 24, '#444444', 230, 'Helvetica, Arial, sans-serif');
    g.fillStyle = bg; for (let i = 0; i < 25; i++) if (r.chance(0.55)) g.fillRect(x + 440 + (i % 5) * 9, y + 190 + Math.floor(i / 5) * 9, 8, 8);
  }
  g.restore();
}
/** a ticker strip (2 cells wide): headlines or quotes on a dark band, repeated so it scrolls seamlessly */
function drawTicker(g: G, x: number, y: number, w: number, kind: number, r: Rng) {
  g.fillStyle = kind ? '#04121e' : '#140404';
  g.fillRect(x, y, w, CH);
  g.fillStyle = kind ? '#1d4fd8' : '#c8102e';
  g.fillRect(x, y + 20, w, 8);
  g.fillRect(x, y + CH - 28, w, 8);
  const items = kind
    ? Array.from({ length: 8 }, () => `${r.pick(['NYX', 'TKR', 'MSFT', 'GLD', 'AAPX', 'BNKR', 'OILX', 'SPY'])} ${r.range(10, 600).toFixed(2)} ${r.chance(0.5) ? '▲' : '▼'}${r.range(0.1, 4).toFixed(2)}`)
    : ['BREAKING: SUBWAY SERVICE RESTORED ON THE 7', 'YANKEES WIN 6–3 IN THE BRONX', 'WEATHER: CLEAR, HIGH OF 68°', 'MARKETS CLOSE HIGHER', 'BROADWAY WEEK: 2-FOR-1 TICKETS', 'CITY COUNCIL VOTES ON NEW BIKE LANES'];
  let tx = x + 20;
  g.font = 'bold 120px Helvetica, Arial, sans-serif';
  for (const it of items) {
    const parts = kind ? [it] : [it];
    for (const p of parts) {
      g.fillStyle = kind ? (p.includes('▲') ? '#3cff7a' : '#ff4a4a') : '#ffffff';
      g.fillText(p, tx, y + 172);
      tx += g.measureText(p).width + 90;
      if (tx > x + w - 40) break;
    }
    g.fillStyle = kind ? '#2fe0ff' : '#f5c400';
    g.fillText('•', tx - 60, y + 172);
    if (tx > x + w - 40) break;
  }
}

let atlas: THREE.Texture | null = null;
function adAtlas() {
  if (atlas) return atlas;
  const c = document.createElement('canvas');
  c.width = COLS * CW;
  c.height = ROWS * CH;
  const g = c.getContext('2d');
  if (g) {
    const r = new Rng(9091);
    for (let i = 0; i < AD_CELLS; i++) drawAd(g, (i % COLS) * CW, Math.floor(i / COLS) * CH, i, r);
    drawTicker(g, 0, (ROWS - 1) * CH, 2 * CW, 0, r);
    drawTicker(g, 2 * CW, (ROWS - 1) * CH, 2 * CW, 1, r);
  }
  atlas = new THREE.CanvasTexture(c);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 8;
  atlas.wrapS = THREE.ClampToEdgeWrapping;
  return atlas;
}

let mat: THREE.MeshStandardMaterial | null = null;
/** LED screen material: atlas cell per screen (aCell), animation (aAnim), LED pixel grid (aSize, metres) */
export function screenMat() {
  if (mat) return mat;
  const t = FLAGS.notex ? null : adAtlas();
  const m = new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.85, roughness: 0.55, color: t ? '#ffffff' : '#8a3a6a' });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uT = WF_TIME;
    sh.uniforms.uNight = WF_NIGHT;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aCell;\nattribute vec4 aAnim;\nattribute vec2 aSize;\nvarying vec4 vCell;\nvarying vec4 vAnim;\nvarying vec2 vLoc;\nvarying vec2 vSize;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvCell = aCell;\nvAnim = aAnim;\nvLoc = uv;\nvSize = aSize;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uT;
uniform float uNight;
varying vec4 vCell;
varying vec4 vAnim;
varying vec2 vLoc;
varying vec2 vSize;`)
      .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>
#ifndef USE_MAP
uniform sampler2D map;
#endif
vec2 cellUv(vec4 c, vec2 l) { return vec2(c.x + l.x * c.z, c.y + l.y * c.w); }
vec4 adSample(vec2 l) {
  // aAnim.x: 0 still, 1 ticker (scroll l.x), 2 crossfade to the cell in aAnim.zw
  if (vAnim.x > 0.5 && vAnim.x < 1.5) l.x = fract(l.x * vAnim.y + uT * 0.05);
  vec4 a = texture2D(map, cellUv(vCell, l));
  if (vAnim.x > 1.5) {
    float k = smoothstep(0.42, 0.58, fract(uT / 9.0 + vAnim.y));
    a = mix(a, texture2D(map, cellUv(vec4(vAnim.zw, vCell.zw), l)), k);
  }
  return a;
}
float ledMask() {
  // LED pixels at a 3 cm pitch: visible up close, faded out once a pixel is under ~2 screen pixels
  vec2 p = vLoc * vSize / 0.03;
  vec2 f = abs(fract(p) - 0.5);
  float dot = smoothstep(0.5, 0.32, max(f.x, f.y));
  float fade = clamp(1.5 - 1.2 * max(fwidth(p.x), fwidth(p.y)), 0.0, 1.0);
  return mix(1.0, 0.35 + 0.9 * dot, fade);
}`)
      .replace('#include <map_fragment>', `#ifdef USE_MAP
  vec4 adC = adSample(vLoc);
  diffuseColor *= adC;
#endif
  float led = ledMask();`)
      .replace('#include <emissivemap_fragment>', `#ifdef USE_EMISSIVEMAP
  totalEmissiveRadiance *= adC.rgb * led * (1.0 + 1.8 * uNight);
#endif`);
  };
  m.customProgramCacheKey = () => 'nbhd-led';
  m.name = 'led-screens';
  return (mat = m);
}

/** builds one block's screens into a single geometry */
export class ScreenBatch {
  private pos: number[] = [];
  private uv: number[] = [];
  private cell: number[] = [];
  private anim: number[] = [];
  private size: number[] = [];
  private idx: number[] = [];
  private used = new Set<number>();
  constructor(private r: Rng) {}
  /** a screen centred at (cx, cy, cz), w × h, facing ry; kind: 'ad' | 'ticker' */
  add(cx: number, cy: number, cz: number, w: number, h: number, ry: number, kind: 'ad' | 'ticker' = 'ad') {
    const r = this.r;
    const cw = 1 / COLS, ch = 1 / ROWS;
    let c: number[], a: number[];
    if (kind === 'ticker') {
      const t = r.int(0, 1);
      // a ticker cell is 2 columns wide; show ~w/h strips of it and scroll
      c = [t * 2 * cw, 0, 2 * cw, ch];
      a = [1, Math.max(0.25, Math.min(1, (w / h) / 8)), 0, 0];
    } else {
      // no ad twice on one block while unused ones remain
      let i = r.int(0, AD_CELLS - 1);
      for (let k = 0; k < 6 && this.used.has(i); k++) i = r.int(0, AD_CELLS - 1);
      this.used.add(i);
      const j = (i + 1 + r.int(0, AD_CELLS - 2)) % AD_CELLS;
      const v0 = 1 - (Math.floor(i / COLS) + 1) * ch;
      c = [(i % COLS) * cw, v0, cw, ch];
      // a third of the screens crossfade between two ads
      a = r.chance(0.35) ? [2, r.next(), (j % COLS) * cw, 1 - (Math.floor(j / COLS) + 1) * ch] : [0, 0, 0, 0];
    }
    const dx = Math.cos(ry) * (w / 2), dz = -Math.sin(ry) * (w / 2);
    const b = this.pos.length / 3;
    this.pos.push(cx - dx, cy - h / 2, cz - dz, cx + dx, cy - h / 2, cz + dz, cx + dx, cy + h / 2, cz + dz, cx - dx, cy + h / 2, cz - dz);
    this.uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let k = 0; k < 4; k++) {
      this.cell.push(...c);
      this.anim.push(...a);
      this.size.push(w, h);
    }
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  mesh() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aCell', new THREE.Float32BufferAttribute(this.cell, 4));
    g.setAttribute('aAnim', new THREE.Float32BufferAttribute(this.anim, 4));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(this.size, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, screenMat());
    m.name = 'led-screens';
    m.userData.owned = true;
    return m;
  }
}
