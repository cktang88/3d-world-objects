# Vertical circulation: stairs, elevators, floors that load as you climb

Code: `src/rooms/vertical.ts` (the building floors as levels: stair column, halls, lobbies, lift
shafts, roof), `src/vertical.ts` (game glue: walking between floors, neighbour floors shown through
the stairwell, the elevator ride), lab: `/?lab=vertical` (a cut-away of three floors of a building
with the stair column, `&type=walkup|prewar|office|loft&floor=n&floors=n`).

## References

| what | source | what to copy |
|---|---|---|
| Art-deco elevator entrances, 70 Pine St | https://commons.wikimedia.org/wiki/File:Art_Deco_elevator_entrances_in_lobby_of_70_Pine_Street,_New_York,_New_York_-_20221123.jpg | two cars side by side ~1.2 m apart; stepped marble surrounds ~0.25 m wide in a darker stone than the wall; brushed metal doors ~1.1 m wide x 2.3 m; call button plate centred between the cars at ~1.1 m; indicator above |
| Elevator floor indicator | https://commons.wikimedia.org/wiki/File:Elevator_floor_indicator.jpg | stainless plate above the doors, red dot-matrix digit between up/down arrows; brushed stainless cab doors |
| Steel fire stair (switchback) | https://commons.wikimedia.org/wiki/File:Stairs-6304.jpg | steel channel stringers ~0.3 m deep painted grey-blue, pan treads, pipe rails (3 horizontal + top rail ~1.07 m), fluorescent strip under every landing, landing as deep as the flight is wide |
| Corbin Building stair, 11 John St | https://commons.wikimedia.org/wiki/File:Eighth_Floor_Interior_Stair_Case_looking_up_to_Ninth_Floor_-_Corbin_Building,_11_John_Street,_New_York,_New_York_County,_NY_HABS_NY-6372-25.tif | cast-iron open-riser stair, dark treads, ornate iron balustrade panels, heavy newel post with a finial at the bottom, wooden handrail ~0.9 m; marble wainscot ~1.1 m in the hall; flush elevator door beside the stair |
| Tenement Museum, 97 Orchard St | https://commons.wikimedia.org/wiki/File:Interior_view_of_the_Tenement_Museum,_located_on_the_Lower_East_Side_of_Manhattan_at_97_Orchard_Street,_New_York,_New_York_LCCN2011631246.tif | (the apartments behind the hall doors — InteriorLevel already does these) worn wide-plank floors, dark wainscot rail ~0.9 m, patterned paper |
| Brass mailboxes in a foyer | https://commons.wikimedia.org/wiki/File:Interior_view,_first_floor,_detail,_brass_mailboxes,_west_wall_in_foyer_-_W._K._Bowman-O%27Neal_Apartment_Building,_4313_East_Kellogg_Street,_Wichita,_Sedgwick_County,_KS_HABS_KANS,87-WICH.V,1-37.tif | a recessed bronze panel: a row of narrow doors (~0.13 x 0.3 m) each with a slot, a name-card window and a lock; a hinged postman's panel across the top |
| 1928 Otis cab | https://commons.wikimedia.org/wiki/File:Interior_view_1928-29_building,_second_floor,_1928_Otis_elevator_cab_detail_-_L._S._Ayres_and_Company_Department_Store,_1_West_Washington_Street,_Indianapolis,_Marion_County,_IN_HABS_IND,49-IND,45-41.tif | wood-panelled cab, brass handrail, a vertical column of round buttons on a brass plate beside the door |

Also from memory of NYC buildings (and the existing facades in `src/nyc/buildings.ts`): old-law
tenements have one narrow switchback stair in the middle of the building, open to a short hall with
two to four apartment doors per landing, hex mosaic floors at the entry, a skylight over the stair
well and a roof bulkhead; pre-war elevator buildings have a marble/terrazzo lobby with a brass dial
above the elevator door, wood-panelled cab, a separate fire stair; office towers have a lobby with a
security desk, turnstiles and an elevator bank (cars facing each other), and steel-pan fire stairs in
painted CMU shafts with the floor number stencilled at each landing.

## Dimensions used

| | walk-up | pre-war | office | loft |
|---|---|---|---|---|
| floor to floor | 3.05 m | 3.2 m | 3.9 m | 3.8 m |
| risers per floor (rise) | 16 (0.191) | 18 (0.178) | 22 (0.177) | 22 (0.173) |
| run | 0.25 | 0.27 | 0.28 | 0.27 |
| flight width | 0.95 | 1.1 | 1.15 | 1.1 |
| well between flights | 0.12 | 0.30 | 0.25 | 0.20 |
| hall width | = stair (2.0) | 1.8 + lobby | 2.4 | 2.2 |
| lifts | none | 1 | 2 + 2 facing | 1 freight |

Handrail at 0.9 m above the nosings, guard at landings 1.07 m. Landings at least the flight width.
Elevator cab 1.6 x 1.4 x 2.4 m inside, door 0.95–1.1 m clear, two leaves.

## How floors work (the design)

- A building is a stack of levels `{ kind: 'floor', seed, name, type, floor, floors }`; `floor 0`
  is the lobby, `floor = floors` is the roof. Each is generated from the seed + floor number.
- Every floor shares the same plan in x/z, so going between floors only moves the player by the
  floor height. The stair is a **periodic column**: one storey segment (flight up to the half
  landing, flight up to the next floor, landings, walls, balusters, a light) built once, merged per
  material and drawn as an `InstancedMesh` repeated for every storey (one draw call per material for
  the whole stair tower). Far floors' landings show a short stub of hall with a closed door.
- Walking: `FloorLevel.ground(x, z, y)` returns the stair ramp height under you, periodic in the
  floor height (`f + H·round((y − f)/H)`), and `Player.ground` follows it (step-up snap, step-down
  stick). Rect colliders stay 2D: walls, the well between the flights; at the lobby the flight
  down (to the cellar door) and on the roof the flight up are blocked.
- Switching: past 0.55·H above the floor you are on the next floor's level (same x/z, y − H, same
  frame); below −0.55·H on the one under. The neighbour floors are prefetched (seamless.ts builds
  them in 4 ms slices) as soon as you are near the stair, and shown at ±H through the stairwell
  (lights stripped, their copy of the stair hidden), so walking up is one continuous space.
- Only the current floor, the floors you are heading to and the street stay pinned; the rest falls
  out of seamless.ts' LRU cache.
- Elevators: E on the call button brings the car, doors slide open (hall + cab doors), E on the
  panel (or the number keys) picks a floor, the doors close, the destination is prefetched and the
  ride lasts until it is built (or the travel time, whichever is longer); then the level switches
  behind the closed doors and they open onto the new floor.

## Houses (brownstones)

A house with `floors > 1` gets a `HouseCore` (src/rooms/vertical.ts) through marked hooks in
src/interior.ts. It has the same footprint on every floor (W/D from the seed) and a stair hall
behind the back wall, with its doorway 1.05 m from the -x corner, where no BSP wall ever ends. The
stair has wood treads, white risers and walnut rails, and closed doors on far floors. Each floor
has 12 point lights, so climbing never recompiles shaders. The old in-room stair portal (a fade to
the next floor) is gone. Any level that exposes `vcore` works with src/vertical.ts.

## Checks and numbers

- `npm run qa -- vertical` (tests/vertical.test.ts) runs on each building type. It checks the
  rise (0.17–0.19 m), run (0.25–0.28 m) and flight width (≥ 0.95 m). It walks from the street
  door up two floors and back, finds no flight down at the lobby, climbs to the roof and out of
  the bulkhead, finds no flight up from the roof, reaches every door, and checks determinism.
  A floor of a walk-up has about 50 meshes and 21k triangles, all storeys of the stair included.
- `npm run qa -- vertical-play` (tests/vertical-play.test.ts) drives the real Seamless + Vertical +
  Player at 60 Hz:
  - a walk-up, lobby to roof and back: 12 one-frame switches and no synchronous ("forced") builds;
    the cache stays at 8 levels or fewer
  - the pre-war elevator: called, opened, floor chosen, ridden, arrived, walked out
  - floor → apartment (prebuilt) → cells and containers → back to the same cached floor
  - a 4-floor brownstone climbed to the top and back
- A floor switch on the stair costs about 1 ms in the browser (`__world.vert.stats.maxSwitchMs`):
  nothing is built, and the light count stays the same.
- A floor builds in about 10 slices of 1–20 ms in node (the first slice builds the building's
  stair column, and later floors reuse it). The slowest slices in the halls come from the
  apartments that seamless.ts prebuilds when you face their doors (InteriorLevel, 30–300 ms in node).
