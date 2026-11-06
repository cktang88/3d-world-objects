/**
 * Room archetypes, after real museums (docs/research/museum.md). The collection picks the
 * archetype (its look and the displays it prefers); the objects' real sizes pick each display.
 */
export type Arch = 'hangar' | 'motor' | 'maritime' | 'machine' | 'period' | 'whitecube' | 'treasury' | 'study' | 'science' | 'openair' | 'glasshouse';
export type Floor = 'parquet' | 'marble' | 'concrete' | 'oak' | 'tiles' | 'carpet' | 'lawn' | 'terrazzo';
export type Ceiling = 'flat' | 'coffer' | 'lantern' | 'truss' | 'vault' | 'glass' | 'open';
export type Barrier = 'rope' | 'rail' | 'glass' | 'line' | 'edge';

export interface Style {
  arch: Arch;
  /** wall colours to choose from */
  walls: string[];
  floors: Floor[];
  ceilings: Ceiling[];
  /** dark rooms rely on spotlights */
  dark: boolean;
  /** base ceiling height range */
  height: [number, number];
  /** room depth / width */
  aspect: [number, number];
  barrier: Barrier[];
  /** platform / plinth colour */
  plinth: string[];
  trim: string;
  /** text on walls */
  ink: string;
  /** small things: wall cases, tall vitrines, table cases, hooded plinths */
  small: ('wallcase' | 'vitrine' | 'table' | 'hood' | 'storage')[];
  /** medium things: open plinths, stepped risers */
  medium: ('plinth' | 'riser' | 'cluster')[];
  hang: boolean;
  mount: boolean;
  /** wall case frame */
  caseFrame: string;
  light: string;
  hemi: number;
  outdoor?: boolean;
}

const S = (s: Style) => s;

export const STYLES: Record<Arch, Style> = {
  // Udvar-Hazy / Science Museum Flight: aircraft hang from a steel vault, the rest stands on the floor behind low rails
  hangar: S({
    arch: 'hangar', walls: ['#dfe3e6', '#cfd5da', '#e8e6e1'], floors: ['concrete', 'terrazzo'], ceilings: ['vault', 'truss'], dark: false, height: [9, 12], aspect: [1.3, 2.2],
    barrier: ['rail'], plinth: ['#8b9096', '#5d6166'], trim: '#c8ccd0', ink: '#2c3238', small: ['vitrine', 'wallcase', 'table'], medium: ['plinth'], hang: true, mount: false,
    caseFrame: '#9aa0a6', light: '#f4f7ff', hemi: 1.05,
  }),
  // Petersen / Mercedes-Benz / Making the Modern World: dark hall, cars on low platforms, spotlit
  motor: S({
    arch: 'motor', walls: ['#55595f', '#5e5449', '#3f4f5e', '#6a6158'], floors: ['concrete', 'terrazzo'], ceilings: ['truss', 'flat'], dark: true, height: [6.5, 9], aspect: [0.7, 1.2],
    barrier: ['rope', 'glass', 'edge'], plinth: ['#e9e7e2', '#202224', '#7a7f85'], trim: '#55595e', ink: '#f2efe8', small: ['vitrine', 'wallcase'], medium: ['plinth', 'riser'], hang: false, mount: true,
    caseFrame: '#1a1a1a', light: '#fff4e6', hemi: 0.7,
  }),
  // Vasa / National Maritime: boats on cradles in a dim, tall hall
  maritime: S({
    arch: 'maritime', walls: ['#24323d', '#2f2a26', '#3b4a52'], floors: ['oak', 'concrete'], ceilings: ['truss', 'flat'], dark: true, height: [7, 10], aspect: [1.2, 2.4],
    barrier: ['rope', 'rail'], plinth: ['#3d3127', '#2a2a2a'], trim: '#5a4a3a', ink: '#efe6d2', small: ['wallcase', 'vitrine', 'table'], medium: ['plinth'], hang: false, mount: true,
    caseFrame: '#2a2018', light: '#ffe8c8', hemi: 0.7,
  }),
  // Deutsches Museum Kraftmaschinen / Science Museum Energy Hall: brick, cast-iron, machines on the floor behind yellow lines
  machine: S({
    arch: 'machine', walls: ['#8c5a44', '#6f6a61', '#a49a86', '#53606a'], floors: ['concrete', 'tiles'], ceilings: ['truss', 'lantern'], dark: false, height: [6, 9], aspect: [1.4, 2.6],
    barrier: ['line', 'rail'], plinth: ['#4a4d50', '#6b5d4c'], trim: '#3b3f44', ink: '#f3eee4', small: ['wallcase', 'table', 'vitrine'], medium: ['plinth', 'cluster'], hang: false, mount: false,
    caseFrame: '#2f3337', light: '#fff2df', hemi: 0.95,
  }),
  // V&A British Galleries / Met period rooms: coloured walls, parquet, coffered ceilings, furniture on stepped risers
  period: S({
    arch: 'period', walls: ['#6e2a2a', '#2f4a3a', '#2d3d5a', '#7a6340', '#4b2f45', '#8a8f78'], floors: ['parquet', 'marble', 'carpet'], ceilings: ['coffer', 'lantern', 'flat'], dark: false, height: [5, 7], aspect: [1.2, 2.8],
    barrier: ['rope', 'edge'], plinth: ['#e7dfcf', '#3a2e24', '#d8cfbd'], trim: '#efe6d2', ink: '#f5ecda', small: ['wallcase', 'vitrine', 'hood'], medium: ['riser', 'plinth'], hang: false, mount: true,
    caseFrame: '#2b241c', light: '#ffeacc', hemi: 0.8,
  }),
  // MoMA design galleries / Vitra / Design Museum: white cube, pale floor, plinths of many heights, track lights
  whitecube: S({
    arch: 'whitecube', walls: ['#f4f3ef', '#eeeeea', '#f2efe9'], floors: ['oak', 'concrete', 'terrazzo'], ceilings: ['flat', 'lantern'], dark: false, height: [4.5, 6], aspect: [0.9, 1.8],
    barrier: ['edge'], plinth: ['#fbfbf9', '#f0efea', '#1d1d1d'], trim: '#e0ded8', ink: '#1d1d1b', small: ['hood', 'table', 'wallcase'], medium: ['cluster', 'plinth'], hang: false, mount: true,
    caseFrame: '#d8d8d8', light: '#fffaf0', hemi: 1.0,
  }),
  // Met musical instruments / Wallace Collection armoury: dark walls, each object a pool of light
  treasury: S({
    arch: 'treasury', walls: ['#2f4f86', '#7a2e2e', '#3d5e4c', '#4d4170'], floors: ['oak', 'parquet', 'carpet'], ceilings: ['flat', 'coffer'], dark: true, height: [4.5, 6], aspect: [1.0, 2.2],
    barrier: ['edge', 'rope'], plinth: ['#d8c4a0', '#2a2622'], trim: '#c9b48a', ink: '#f3ead6', small: ['vitrine', 'wallcase', 'hood'], medium: ['plinth'], hang: false, mount: true,
    caseFrame: '#2a2622', light: '#ffe6c0', hemi: 0.7,
  }),
  // V&A ceramics visible storage / Pitt Rivers / Science Museum stores: dense glass cabinets, flat table cases
  study: S({
    arch: 'study', walls: ['#c9cdc4', '#b7c0bd', '#d6d0c2', '#8f9a94'], floors: ['parquet', 'tiles', 'oak'], ceilings: ['lantern', 'flat'], dark: false, height: [4.5, 6], aspect: [1.6, 3.2],
    barrier: ['edge'], plinth: ['#e5e2da', '#59605c'], trim: '#e9e6de', ink: '#26302c', small: ['storage', 'table', 'wallcase'], medium: ['plinth'], hang: false, mount: false,
    caseFrame: '#a8adb0', light: '#fbf6ec', hemi: 0.95,
  }),
  // Science Museum Wonderlab / mechanisms: deep blue, lit-top plinths, things that move
  science: S({
    arch: 'science', walls: ['#1d3557', '#243b2f', '#3a2d5c'], floors: ['terrazzo', 'concrete'], ceilings: ['flat', 'truss'], dark: true, height: [4.8, 6.5], aspect: [1.0, 1.8],
    barrier: ['edge'], plinth: ['#f2f2f0', '#e9c46a', '#2a2d34'], trim: '#3f5f8a', ink: '#f1f5fb', small: ['hood', 'vitrine', 'table'], medium: ['plinth', 'cluster'], hang: false, mount: false,
    caseFrame: '#1b1b1b', light: '#f3f7ff', hemi: 0.75,
  }),
  // Skansen / Weald & Downland: buildings stand outdoors on a lawn within a park wall
  openair: S({
    arch: 'openair', walls: ['#8a5a44'], floors: ['lawn'], ceilings: ['open'], dark: false, height: [4, 4], aspect: [0.8, 1.4],
    barrier: ['rope'], plinth: ['#b9b1a2'], trim: '#7d6f60', ink: '#2b2a24', small: ['vitrine', 'hood'], medium: ['plinth'], hang: false, mount: false,
    caseFrame: '#3a3a3a', light: '#fff7e8', hemi: 1.0, outdoor: true,
  }),
  // Kew Palm House / a garden court: glass roof, gravel and planting
  glasshouse: S({
    arch: 'glasshouse', walls: ['#e9ece6'], floors: ['terrazzo', 'lawn'], ceilings: ['glass'], dark: false, height: [7, 9], aspect: [1.0, 2.0],
    barrier: ['edge', 'rope'], plinth: ['#cfc7b4', '#7c8a6e'], trim: '#ffffff', ink: '#24321f', small: ['hood', 'table', 'vitrine'], medium: ['plinth', 'cluster'], hang: false, mount: false,
    caseFrame: '#e8e8e8', light: '#fffdf4', hemi: 1.1, outdoor: true,
  }),
};

const BY_COLLECTION: Record<string, Arch> = {
  'Aircraft & Spacecraft': 'hangar',
  Vehicle: 'motor',
  Watercraft: 'maritime',
  'Machine & Industrial': 'machine',
  'Mechanical Assemblies': 'machine',
  'Power Tool': 'machine',
  Furniture: 'period',
  'Architectural Element': 'period',
  'Bathroom Fixture': 'period',
  'Animal Gear': 'period',
  Container: 'period',
  'Food & Drink': 'whitecube',
  'Toy & Game': 'whitecube',
  'Kitchen Appliance': 'whitecube',
  'Home Appliance': 'whitecube',
  Electronics: 'whitecube',
  Packaging: 'whitecube',
  'Sports Equipment': 'whitecube',
  Cookware: 'whitecube',
  'Musical Instrument': 'treasury',
  Lighting: 'treasury',
  'Weapon & Armour': 'treasury',
  'Measuring Instrument': 'treasury',
  'CAD Parts': 'study',
  'Fastener & Hardware': 'study',
  'Hand Tool': 'study',
  Stationery: 'study',
  'Medical & Personal Care': 'study',
  Tableware: 'study',
  'SimReady Assets': 'study',
  'Articulated Mechanisms': 'science',
  Building: 'openair',
  'Garden & Outdoor': 'glasshouse',
};

export function styleFor(collection: string): Style {
  return STYLES[BY_COLLECTION[collection] ?? 'whitecube'];
}

/** how many objects a room of this collection holds (big things get fewer per room) */
export function pageSize(collection: string) {
  const a = BY_COLLECTION[collection];
  if (a === 'openair') return 6;
  if (a === 'hangar' || a === 'maritime') return 10;
  if (a === 'motor') return 12;
  if (a === 'period' || a === 'machine') return 18;
  return 24;
}
