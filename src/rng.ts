export function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function hashN(...ns: number[]): number {
  let h = 0x9e3779b9;
  for (const n of ns) {
    h ^= Math.imul((n | 0) ^ 0x85ebca6b, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 15), 0x27d4eb2d);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  fork(salt: number): Rng {
    return new Rng(hashN(Math.floor(this.next() * 4294967296), salt));
  }
}

const FIRST = ['Maple', 'Oak', 'Cedar', 'Birch', 'Elm', 'Willow', 'Juniper', 'Harbor', 'Lantern', 'Copper', 'Velvet', 'Quartz', 'Amber', 'Fern', 'Rook', 'Sparrow', 'Marble', 'Ember', 'Tinker', 'Clover', 'Saffron', 'Indigo', 'Pebble', 'Thistle', 'Gable', 'Hollow', 'Mosaic', 'Fable'];
const SUFFIX = ['St', 'Ave', 'Lane', 'Row', 'Way', 'Court', 'Rd', 'Place', 'Terrace', 'Walk'];
export function streetName(r: Rng): string {
  return `${r.int(1, 240)} ${r.pick(FIRST)} ${r.pick(SUFFIX)}`;
}
const PAINT_A = ['Blue', 'Quiet', 'Golden', 'Restless', 'Folded', 'Distant', 'Small', 'Infinite', 'Crimson', 'Sleeping', 'Nested', 'Recursive'];
const PAINT_B = ['Study', 'Harbor', 'Garden', 'Machine', 'Afternoon', 'Window', 'Orchard', 'Signal', 'Archive', 'City', 'Interior', 'Echo'];
export function paintingName(r: Rng): string {
  return `${r.pick(PAINT_A)} ${r.pick(PAINT_B)} No. ${r.int(1, 99)}`;
}
