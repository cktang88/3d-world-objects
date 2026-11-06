import * as THREE from 'three';
import { loadCatalog, loadLibraryModel, attribution, type LibraryEntry } from '../libraries';
import type { Rng } from '../rng';

/**
 * Photoreal CC0 furniture and decor from Poly Haven (src/libraries.ts) for interiors.
 * Sizes are copied from public/libraries/polyhaven.json so rooms can be planned synchronously;
 * models stream in afterwards. All face +z (Blender front, -Y, exported to glTF +Z).
 */
export const LIB: Record<string, [number, number, number]> = {
  // seating
  Sofa_01: [1.571, 0.797, 0.658],
  sofa_02: [1.807, 0.709, 0.818],
  ArmChair_01: [0.848, 1.065, 0.766],
  GreenChair_01: [0.673, 1.059, 0.664],
  modern_arm_chair_01: [0.82, 1.023, 0.987],
  mid_century_lounge_chair: [1.009, 1.169, 1.19],
  Ottoman_01: [0.885, 0.624, 0.621],
  dining_chair_02: [0.434, 0.973, 0.576],
  painted_wooden_chair_01: [0.432, 0.956, 0.54],
  bar_chair_round_01: [0.483, 0.751, 0.486],
  metal_stool_02: [0.448, 0.458, 0.473],
  GothicBed_01: [1.494, 1.534, 2.04],
  dining_table: [2.256, 0.877, 1.39],
  WoodenTable_03: [1.327, 0.83, 0.562],
  small_wooden_table_01: [0.916, 0.533, 0.44],
  wooden_bookshelf_worn: [1.374, 2.063, 0.581],
  // tables
  modern_coffee_table_01: [1.202, 0.39, 0.6],
  modern_coffee_table_02: [1.199, 0.369, 1.2],
  coffee_table_round_01: [1.301, 0.491, 1.301],
  industrial_coffee_table: [0.778, 0.638, 0.758],
  side_table_01: [0.55, 0.551, 0.45],
  side_table_tall_01: [0.384, 0.761, 0.384],
  round_wooden_table_02: [0.796, 0.746, 0.796],
  // storage
  ClassicNightstand_01: [0.568, 0.7, 0.424],
  painted_wooden_nightstand: [0.505, 0.616, 0.509],
  ClassicConsole_01: [1.543, 0.949, 0.589],
  GothicCommode_01: [1.201, 1.212, 0.581],
  painted_wooden_cabinet: [1.195, 1.182, 0.617],
  steel_frame_shelves_01: [1.097, 2.141, 0.502],
  // lighting
  Chandelier_01: [0.746, 0.798, 0.816],
  Chandelier_02: [0.679, 0.848, 0.619],
  modern_ceiling_lamp_01: [0.432, 0.952, 0.432],
  hanging_industrial_lamp: [0.55, 1.355, 0.55],
  desk_lamp_arm_01: [0.617, 0.879, 0.408],
  // plants and decor
  potted_plant_01: [0.589, 1.351, 0.637],
  potted_plant_02: [0.701, 0.841, 0.657],
  potted_plant_04: [0.17, 0.268, 0.186],
  ceramic_vase_01: [0.205, 0.401, 0.206],
  ceramic_vase_02: [0.22, 0.309, 0.221],
  ceramic_vase_03: [0.112, 0.414, 0.112],
  ceramic_vase_04: [0.183, 0.342, 0.182],
  brass_vase_03: [0.083, 0.2, 0.083],
  antique_ceramic_vase_01: [0.255, 0.44, 0.255],
  mantel_clock_01: [0.484, 0.161, 0.251],
  standing_picture_frame_01: [0.201, 0.25, 0.1],
  book_encyclopedia_set_01: [0.551, 0.237, 0.163],
  alarm_clock_01: [0.228, 0.174, 0.168],
  marble_bust_01: [0.272, 0.515, 0.3],
  concrete_cat_statue: [0.153, 0.283, 0.25],
  wooden_candlestick: [0.098, 0.22, 0.1],
  brass_goblets: [0.453, 0.273, 0.298],
  jug_01: [0.275, 0.211, 0.168],
  pot_enamel_01: [0.263, 0.178, 0.18],
  food_apple_01: [0.098, 0.085, 0.096],
  food_pears_asian_01: [0.156, 0.11, 0.178],
  bananas: [0.6, 0.179, 0.244],
  carved_wooden_plate: [0.272, 0.038, 0.269],
  classic_laptop: [0.652, 0.543, 0.486],
  Television_01: [0.6, 0.457, 0.471],
};

export const SETS: Record<string, string[]> = {
  sofa: ['sofa_02'],
  loveseat: ['Sofa_01'],
  armchair: ['ArmChair_01', 'GreenChair_01', 'modern_arm_chair_01'],
  coffee: ['modern_coffee_table_01', 'modern_coffee_table_02', 'industrial_coffee_table'],
  side: ['side_table_01', 'side_table_tall_01'],
  nightstand: ['ClassicNightstand_01', 'painted_wooden_nightstand'],
  diningchair: ['dining_chair_02'],
  stool: ['bar_chair_round_01', 'metal_stool_02'],
  dresser: ['GothicCommode_01', 'painted_wooden_cabinet', 'ClassicConsole_01'],
  chandelier: ['Chandelier_01', 'Chandelier_02'],
  pendant: ['modern_ceiling_lamp_01', 'hanging_industrial_lamp'],
  bigplant: ['potted_plant_01', 'potted_plant_02'],
  smallplant: ['potted_plant_04'],
  vase: ['ceramic_vase_01', 'ceramic_vase_02', 'ceramic_vase_03', 'ceramic_vase_04', 'antique_ceramic_vase_01', 'brass_vase_03'],
  mantel: ['mantel_clock_01', 'wooden_candlestick', 'ceramic_vase_03', 'marble_bust_01', 'brass_vase_03', 'standing_picture_frame_01'],
  table: ['ceramic_vase_02', 'potted_plant_04', 'standing_picture_frame_01', 'alarm_clock_01', 'concrete_cat_statue', 'wooden_candlestick', 'book_encyclopedia_set_01'],
  kitchen: ['jug_01', 'pot_enamel_01', 'food_apple_01', 'food_pears_asian_01', 'bananas', 'carved_wooden_plate', 'potted_plant_04'],
  shelf: ['ceramic_vase_04', 'brass_vase_03', 'concrete_cat_statue', 'standing_picture_frame_01', 'wooden_candlestick', 'mantel_clock_01', 'potted_plant_04'],
};

export function pickLib(set: string, r: Rng, fits?: (s: [number, number, number]) => boolean): string | null {
  const opts = (SETS[set] ?? []).filter((id) => LIB[id] && (!fits || fits(LIB[id])));
  return opts.length ? r.pick(opts) : null;
}

let byId: Promise<Map<string, LibraryEntry>> | null = null;
function entries() {
  byId ??= loadCatalog('polyhaven')
    .then((all) => new Map(all.map((e) => [e.id, e])))
    .catch(() => new Map());
  return byId;
}

/** whether library loading is allowed (lab: &lib=0 turns it off to compare with the procedural fallbacks) */
export let libEnabled = true;
export function setLibEnabled(v: boolean) {
  libEnabled = v;
}

/**
 * Put library model `id` into `holder` (already placed and rotated in the room). Anything already in the
 * holder is a procedural stand-in, replaced when the model arrives. Resolves with the model or null.
 */
export async function fillHolder(holder: THREE.Object3D, id: string, opts: { height?: number } = {}): Promise<THREE.Object3D | null> {
  if (!libEnabled) return null;
  try {
    const e = (await entries()).get(id);
    if (!e) return null;
    const m = await loadLibraryModel(e, { height: opts.height });
    if (holder.userData.disposed) return null;
    for (const c of [...holder.children]) {
      holder.remove(c);
      c.traverse((o) => {
        const mm = o as THREE.Mesh;
        if (mm.isMesh && mm.userData.owned) mm.geometry.dispose();
      });
    }
    holder.add(m);
    holder.userData.attribution = attribution(e);
    return m;
  } catch (err) {
    console.warn('library model failed', id, err);
    return null;
  }
}
