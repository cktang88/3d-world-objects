import * as THREE from 'three';

export interface Line {
  text: string;
  size: number;
  color?: string;
  weight?: number;
  font?: string;
}

export const SANS = "'Helvetica Neue', Helvetica, Arial, system-ui, sans-serif";
export const SERIF = "Georgia, 'Times New Roman', serif";

function draw(c: HTMLCanvasElement, lines: Line[], px: number, bg: string | null, align: CanvasTextAlign, valign: 'middle' | 'top') {
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  if (bg) {
    g.fillStyle = bg;
    g.fillRect(0, 0, c.width, c.height);
  }
  const total = lines.reduce((s, l) => s + l.size * px * 1.25, 0);
  let y = valign === 'middle' ? (c.height - total) / 2 : c.height * 0.08;
  g.textAlign = align;
  g.textBaseline = 'top';
  const x = align === 'center' ? c.width / 2 : align === 'left' ? c.width * 0.06 : c.width * 0.94;
  for (const l of lines) {
    g.fillStyle = l.color ?? '#fff';
    g.font = `${l.weight ?? 600} ${Math.round(l.size * px)}px ${l.font ?? SERIF}`;
    let text = l.text;
    while (g.measureText(text).width > c.width * 0.9 && text.length > 4) text = text.slice(0, -2);
    if (text !== l.text) text = text.trimEnd() + '…';
    g.fillText(text, x, y);
    y += l.size * px * 1.25;
  }
}

/** A flat text panel w x h metres (sizes in metres too). */
export function textPlane(lines: Line[], w: number, h: number, bg: string | null, px = 256, align: CanvasTextAlign = 'center', valign: 'middle' | 'top' = 'middle') {
  const c = document.createElement('canvas');
  c.width = Math.min(2048, Math.round(w * px));
  c.height = Math.min(2048, Math.round(h * px));
  const k = c.width / w;
  draw(c, lines, k, bg, align, valign);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, transparent: !bg, toneMapped: false, depthWrite: !!bg }));
  m.userData.owned = true;
  (m.material as THREE.Material).userData.owned = t.userData.owned = true; // per label: freed with it
  m.userData.tex = t;
  m.userData.redraw = (nl: Line[]) => {
    draw(c, nl, k, bg, align, valign);
    t.needsUpdate = true;
  };
  return m;
}

export function fmtLen(m: number) {
  return m >= 1 ? `${m.toFixed(2)} m` : m >= 0.01 ? `${(m * 100).toFixed(1)} cm` : `${(m * 1000).toFixed(1)} mm`;
}

export function fmtDims(v: THREE.Vector3) {
  return `${fmtLen(v.x)} × ${fmtLen(v.y)} × ${fmtLen(v.z)}`;
}

export function titleCase(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function roman(n: number) {
  const map: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of map) while (n >= v) { s += r; n -= v; }
  return s;
}
