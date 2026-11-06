/**
 * Realistic scale. sand3d objects inherit whatever scale their source used (a 1 m cottage,
 * a 4 m teacup). We know what things are from their titles and families, so we know
 * roughly how big they should be. Values: typical largest dimension in metres.
 */
const SIZE: Record<string, number> = {
  // vehicles
  car: 4.5, sedan: 4.8, taxi: 4.7, cab: 4.7, truck: 7.5, lorry: 8, pickup: 5.5, van: 5, bus: 12, minibus: 6, tram: 20, train: 20, locomotive: 18, wagon: 3.2,
  cart: 1.6, carriage: 4, tractor: 4.2, bike: 1.8, bicycle: 1.8, motorcycle: 2.1, motorbike: 2.1, scooter: 1.8, vespa: 1.8, skateboard: 0.8, forklift: 3,
  tank: 7.5, jeep: 4.2, ambulance: 6.5, firetruck: 9, kart: 1.8, buggy: 3, tire: 0.7, tyre: 0.7, wheel: 0.7, limousine: 6, suv: 4.8, rover: 3,
  // aircraft & space
  plane: 30, airplane: 30, aeroplane: 30, aircraft: 25, airliner: 60, jet: 18, fighter: 17, biplane: 8, helicopter: 13, drone: 0.45, quadcopter: 0.4,
  rocket: 40, spaceship: 35, spacecraft: 30, shuttle: 37, satellite: 6, ufo: 12, glider: 15, blimp: 60, balloon: 18, starfighter: 13,
  // watercraft
  boat: 6, ship: 80, yacht: 18, canoe: 5, kayak: 4, submarine: 60, sailboat: 9, raft: 3, ferry: 70, tugboat: 25, gondola: 11, galleon: 45, dinghy: 3,
  // furniture
  chair: 0.95, stool: 0.65, armchair: 1.0, recliner: 1.0, sofa: 2.1, couch: 2.1, loveseat: 1.5, bench: 1.6, table: 1.6, desk: 1.4, bed: 2.1, bunk: 2.0,
  shelf: 1.8, shelving: 1.9, bookcase: 1.9, bookshelf: 1.9, cabinet: 1.4, cupboard: 1.8, wardrobe: 2.0, dresser: 1.3, drawer: 0.8, nightstand: 0.6,
  locker: 1.8, crib: 1.3, ottoman: 0.7, sideboard: 1.8, headboard: 1.6, mattress: 2.0, throne: 1.6, counter: 2.4,
  // lighting
  lamp: 1.5, chandelier: 0.9, lantern: 0.45, candle: 0.25, candlestick: 0.35, bulb: 0.12, streetlight: 6, lamppost: 4.5, torch: 0.5, sconce: 0.35, spotlight: 0.35, floodlight: 0.4,
  // electronics
  tv: 1.2, television: 1.0, monitor: 0.6, laptop: 0.35, computer: 0.45, pc: 0.45, phone: 0.15, smartphone: 0.15, telephone: 0.25, radio: 0.4, speaker: 0.4,
  camera: 0.15, keyboard: 0.45, mouse: 0.11, console: 0.3, gamepad: 0.16, controller: 0.16, headphones: 0.2, headset: 0.2, microphone: 0.22, printer: 0.5,
  router: 0.25, remote: 0.18, tablet: 0.25, arcade: 1.8, server: 2.0, walkman: 0.12, cassette: 0.1, vhs: 0.19, gameboy: 0.15, projector: 0.35, amplifier: 0.5, turntable: 0.45,
  // appliances
  fridge: 1.8, refrigerator: 1.8, freezer: 1.8, oven: 0.9, microwave: 0.5, toaster: 0.3, kettle: 0.25, blender: 0.42, washing: 0.85, washer: 0.85, dryer: 0.85,
  stove: 0.9, dishwasher: 0.85, fan: 0.5, heater: 0.6, radiator: 0.9, vacuum: 1.1, mixer: 0.38, espresso: 0.35, airconditioner: 0.9,
  // tableware & cookware
  cup: 0.1, mug: 0.12, teacup: 0.09, glass: 0.15, goblet: 0.2, plate: 0.26, dish: 0.28, bowl: 0.18, bottle: 0.3, jar: 0.2, teapot: 0.25, pan: 0.45, saucepan: 0.4,
  pot: 0.3, spoon: 0.18, fork: 0.19, knife: 0.25, chopsticks: 0.23, vase: 0.35, jug: 0.25, pitcher: 0.25, tray: 0.45, wok: 0.4, ladle: 0.3, spatula: 0.32, kettlebell: 0.25,
  // food
  apple: 0.08, banana: 0.2, orange: 0.08, burger: 0.12, hamburger: 0.12, pizza: 0.35, cake: 0.25, bread: 0.3, loaf: 0.3, donut: 0.1, doughnut: 0.1, pumpkin: 0.35,
  mushroom: 0.12, carrot: 0.18, watermelon: 0.3, cheese: 0.2, egg: 0.06, sushi: 0.06, sandwich: 0.15, cookie: 0.07, lemon: 0.08, pear: 0.1, tomato: 0.08,
  cherry: 0.025, grapes: 0.15, croissant: 0.15, icecream: 0.15, candy: 0.05, chocolate: 0.15, soda: 0.12, beer: 0.25, wine: 0.3, cupcake: 0.08, pie: 0.25,
  fries: 0.15, hotdog: 0.18, taco: 0.15, avocado: 0.11, pineapple: 0.3, strawberry: 0.04, onion: 0.08, potato: 0.1, steak: 0.25, fish: 0.4, meat: 0.3,
  // toys & games
  lego: 0.06, toy: 0.3, doll: 0.3, teddy: 0.35, dice: 0.02, die: 0.02, puzzle: 0.3, chess: 0.08, pawn: 0.05, rubik: 0.06, yoyo: 0.06, kite: 1.0, marble: 0.016, figurine: 0.15,
  // stationery
  pen: 0.14, pencil: 0.18, book: 0.24, notebook: 0.21, eraser: 0.05, ruler: 0.3, stapler: 0.15, scissors: 0.18, envelope: 0.22, paperclip: 0.03, globe: 0.4, inkwell: 0.08, quill: 0.3, calculator: 0.16,
  // tools
  hammer: 0.33, wrench: 0.25, spanner: 0.25, screwdriver: 0.22, saw: 0.6, chainsaw: 0.8, drill: 0.3, axe: 0.8, shovel: 1.2, spade: 1.1, rake: 1.5, pliers: 0.2, chisel: 0.25,
  ladder: 2.5, toolbox: 0.5, anvil: 0.5, wheelbarrow: 1.5, crowbar: 0.6, mallet: 0.35, trowel: 0.3, pickaxe: 0.9, sledgehammer: 0.9, grinder: 0.4, vise: 0.3, clamp: 0.3,
  // fasteners & hardware
  screw: 0.04, bolt: 0.06, nut: 0.02, nail: 0.06, hinge: 0.08, key: 0.06, lock: 0.08, padlock: 0.07, chain: 0.5, knob: 0.05, hook: 0.08, latch: 0.1, doorknob: 0.07, faucet: 0.25,
  // weapons & armour
  sword: 1.0, katana: 1.0, shield: 0.7, helmet: 0.3, spear: 2.0, bow: 1.5, crossbow: 0.8, arrow: 0.8, dagger: 0.35, gun: 0.3, pistol: 0.2, revolver: 0.25, rifle: 1.1, shotgun: 1.1,
  cannon: 2.5, armor: 0.7, armour: 0.7, mace: 0.7, halberd: 2.2, grenade: 0.12, bazooka: 1.4,
  // musical instruments
  guitar: 1.0, violin: 0.6, viola: 0.67, cello: 1.25, piano: 1.6, drum: 0.6, drums: 1.6, trumpet: 0.5, saxophone: 0.7, flute: 0.65, harp: 1.7, accordion: 0.5, banjo: 0.95,
  ukulele: 0.55, xylophone: 0.7, trombone: 1.1, clarinet: 0.66, tuba: 0.9, harmonica: 0.1, synthesizer: 1.0, organ: 1.6, cymbal: 0.45, tambourine: 0.25, bagpipes: 1.0,
  // garden & outdoor
  tree: 7, palm: 9, bush: 1.2, shrub: 1.2, plant: 0.6, flower: 0.3, flowerpot: 0.3, planter: 0.6, cactus: 0.5, bonsai: 0.4, fence: 2.0, well: 2.2, fountain: 3.0, tent: 3.0,
  mailbox: 1.2, hydrant: 0.8, swing: 2.2, slide: 3.0, grill: 1.0, barbecue: 1.0, umbrella: 2.2, parasol: 2.2, statue: 2.2, signpost: 2.5, cone: 0.7, bollard: 1.0, gate: 2.0,
  birdhouse: 0.35, wateringcan: 0.4, hose: 0.5, mower: 1.5, pergola: 3.5, trampoline: 3.5,
  // buildings & architecture
  house: 12, cottage: 9, cabin: 8, hut: 5, tower: 40, castle: 50, church: 30, cathedral: 80, temple: 22, shop: 10, store: 10, building: 25, apartment: 30, skyscraper: 200,
  barn: 15, garage: 6, shed: 3.5, lighthouse: 25, windmill: 18, bridge: 50, kiosk: 3, booth: 2.5, pavilion: 8, gazebo: 4, bungalow: 12, villa: 18, mansion: 30, palace: 80,
  pagoda: 20, mosque: 40, warehouse: 40, factory: 50, hospital: 60, school: 50, station: 40, bank: 25, hotel: 40, igloo: 3.5, tipi: 4,
  door: 2.1, window: 1.4, column: 4, pillar: 4, stairs: 3, staircase: 4, arch: 4, balcony: 3, chimney: 2, fireplace: 1.5, railing: 1.5,
  // containers & packaging
  box: 0.4, crate: 0.6, barrel: 0.9, chest: 0.9, basket: 0.4, bucket: 0.3, bag: 0.5, handbag: 0.35, suitcase: 0.7, backpack: 0.5, trunk: 0.9, can: 0.12, carton: 0.3, pallet: 1.2,
  dumpster: 2, bin: 0.8, trashcan: 0.9, canister: 0.4, jerrycan: 0.45, tin: 0.12, coffin: 2.1, urn: 0.4, safe: 0.8,
  // bathroom & personal care
  toilet: 0.75, sink: 0.6, bathtub: 1.7, bath: 1.7, shower: 2.1, tap: 0.2, mirror: 0.8, towel: 0.6, toothbrush: 0.19, comb: 0.18, razor: 0.15, perfume: 0.12, lipstick: 0.08,
  syringe: 0.15, pill: 0.02, stethoscope: 0.7, wheelchair: 1.1, crutch: 1.3, bandage: 0.1, thermometer: 0.15,
  // sports
  ball: 0.22, football: 0.28, basketball: 0.24, soccer: 0.22, volleyball: 0.21, baseball: 0.075, tennis: 0.07, racket: 0.7, racquet: 0.7, bat: 0.85, golf: 0.043, club: 1.1,
  ski: 1.8, skis: 1.8, snowboard: 1.55, surfboard: 2.1, dumbbell: 0.35, barbell: 2.2, hockey: 1.5, puck: 0.076, glove: 0.3, hoop: 3.0, trophy: 0.35, medal: 0.08, skate: 0.3,
  bowling: 0.38, boxing: 0.3, frisbee: 0.27,
  // measuring & science
  clock: 0.3, watch: 0.04, wristwatch: 0.04, scale: 0.3, compass: 0.08, barometer: 0.25, microscope: 0.4, telescope: 1.2, caliper: 0.2, hourglass: 0.25, sextant: 0.3, gauge: 0.15,
  // machines & industry
  engine: 1.0, motor: 0.5, generator: 1.5, pump: 0.6, gear: 0.15, turbine: 3, crane: 30, excavator: 9, bulldozer: 6, conveyor: 3, compressor: 1.0, valve: 0.3, robot: 1.2,
  lathe: 2, press: 1.5, boiler: 2.5, transformer: 2, reactor: 5,
  // animal gear
  saddle: 0.6, collar: 0.3, leash: 1.5, horseshoe: 0.13, kennel: 1.0, doghouse: 1.0, cage: 0.6, aquarium: 0.8, birdcage: 0.5, feeder: 0.3,
};

/** plausible range of the largest dimension per family (metres) */
const FAMILY: Record<string, [number, number]> = {
  furniture: [0.3, 3.2], electronics: [0.03, 2.2], tableware: [0.03, 0.6], 'food and drink': [0.02, 0.6], vehicle: [0.5, 25], 'aircraft or spacecraft': [0.25, 80],
  watercraft: [0.5, 120], building: [3, 250], lighting: [0.05, 6], 'hand tool': [0.05, 2.5], 'power tool': [0.1, 1.2], 'toy or game': [0.02, 1.5], stationery: [0.01, 0.6],
  container: [0.05, 2.5], packaging: [0.03, 1.5], 'musical instrument': [0.1, 3], 'weapon or armour': [0.1, 3], 'sports equipment': [0.02, 3.5], cookware: [0.05, 0.8],
  'kitchen appliance': [0.1, 1.2], 'home appliance': [0.15, 2.2], 'bathroom fixture': [0.1, 2.4], 'medical or personal care': [0.01, 1.5], 'measuring instrument': [0.02, 1.5],
  'machine or industrial': [0.05, 15], 'garden or outdoor': [0.05, 12], 'architectural element': [0.1, 40], 'fastener or hardware': [0.005, 0.6], 'animal gear': [0.05, 3],
};

const WORD = /[a-z]+/g;
function singular(w: string) {
  if (SIZE[w] !== undefined) return w;
  if (w.endsWith('ies') && SIZE[w.slice(0, -3) + 'y'] !== undefined) return w.slice(0, -3) + 'y';
  if (w.endsWith('es') && SIZE[w.slice(0, -2)] !== undefined) return w.slice(0, -2);
  if (w.endsWith('s') && SIZE[w.slice(0, -1)] !== undefined) return w.slice(0, -1);
  return w;
}

/** What the object most likely is: the last known noun in its title (head nouns come last in English). */
export function typicalSize(title: string, entry?: string | null): { word: string; size: number } | null {
  for (const text of [title, (entry ?? '').replace(/_/g, ' ')]) {
    const words = (text.toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').match(WORD) ?? []).map(singular);
    for (let i = words.length - 1; i >= 0; i--) {
      const s = SIZE[words[i]];
      if (s !== undefined) return { word: words[i], size: s };
    }
  }
  return null;
}

/**
 * Factor to multiply an object's size by so it is realistically sized.
 * `maxDim` is its current largest dimension in metres.
 */
export function realScale(title: string, entry: string | null | undefined, family: string, maxDim: number, dataset = 'objaverse'): number {
  if (!(maxDim > 0)) return 1;
  // CAD parts, Articraft, SimReady and AutoMate are modelled at real size already
  if (dataset !== 'objaverse') return 1;
  const t = typicalSize(title, entry);
  if (t) {
    const r = maxDim / t.size;
    if (r > 2.2 || r < 1 / 2.2) return t.size / maxDim;
    return 1;
  }
  const range = FAMILY[family];
  if (range) {
    if (maxDim > range[1]) return range[1] / maxDim;
    if (maxDim < range[0]) return range[0] / maxDim;
  }
  return 1;
}
