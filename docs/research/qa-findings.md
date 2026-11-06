# QA findings (from `npm run qa`)

These are real problems that the Node-only invariant tests in `tests/` found. Each one is
reported as a `KNOWN` note, so the suite stays green. To list them, run `QA_VERBOSE=1 npm run qa`.

When you fix one, remove its `known(...)` allowance in the test. That makes the test fail if the problem comes back.

| # | Area / owner file | What is wrong | Test |
|---|---|---|---|
| 1 | Interiors: `src/interior.ts` `placeStairs` + `src/rooms/furniture.ts` `stair()` | House floors (H = 3.35 m) get `round(3.35/0.19)` = 18 steps in a fixed 4.2 m run. That gives a **23.3 cm run** (code minimum is about 25 cm) and an 18.6 cm rise: too steep. Fix: make the stair length `steps × 0.27`, or allow a landing/turn. | `interior.test.ts` › stairs |
| 2 | Interiors: `src/rooms/contents.ts` vs `src/interior.ts` `container()` | Contents do not fit their carcass. `drawerContents` is laid out from the front (z = 0 is the front, it puts clothes at `-d/2`), but `container()` shifts every content group back by another `d/2`. As a result, dresser and nightstand contents poke **~0.1 m out of the back** (through the wall). `cabinetContents` fills `while (x < w/2 - 0.15)` with ~0.26 m items, so narrow cabinets and fridges overflow **sideways** (up to 0.18 m on a 0.31 m cabinet). Closet hats sit 0.1–0.15 m above the 2.1 m carcass. | `interior.test.ts` › containers |
| 3 | Interiors: `src/interior.ts` | The same 2.1 × 0.85 collider (a sofa-sized piece) is registered twice in several rooms. Two code paths probably both push it: `onWall`/`freeAt` plus a second push. It is harmless for collision, but check that nothing is drawn twice. | `interior.test.ts` › furniture overlap |
| 4 | People: `src/nyc/people.ts` `walkSignal` | People may start crossing an avenue (16 m) up to 17.5 s into the cycle. Street green ends at 22 s and avenue traffic gets green at 24 s, so at 1.2–1.5 m/s walkers are **still in the avenue for several seconds after cars get green**. Over 48 s this was ~100 person-frames. Cars do not stop for pedestrians. Fix: stop new crossings at about `greenEnd - width/speed`. (#4b: in rare cases (1 in ~20 crossings) someone steps off on yellow.) **Fixed** (4729f14); now asserted strictly | `crossing.test.ts` |
| 5 | Signals: `src/nyc/common.ts` `lightFor` | There is **no all-red interval**: avenue red starts at exactly the moment street green starts (12.5 s), and the reverse happens at 24 s. Yellow-light runners meet cross traffic. NYC uses ~1–2 s of all-red. **Fixed**: 26 s cycle with 2 s all-red after each yellow (`SIGNAL` in common.ts; ped countdowns follow it); now asserted strictly | `vehicles.test.ts` › all-red |
| 6 | Traffic: `src/nyc/vehicles.ts` `Traffic.update` | Cars run red lights: ~4 times in 72 s, some at 9–13 m/s, 7 s into the red. The likely cause is that `k` (which intersection is next) is recomputed from the front bumper with a +4 m lookahead. Once a braking car overshoots its stop point (`stopAt`) by more than ~0.2 m, it targets the *next* intersection and drives through. Fix: latch the intersection the car is stopping for, or compute `k` from the stop line. **Fixed**: `k` is the first intersection whose near edge is still ahead, and cars only go on yellow if they reach the box before red; now asserted strictly (0 runs) | `vehicles.test.ts` › red |
| 7 | Traffic: `src/nyc/vehicles.ts` `Traffic.place` | Re-placed cars are dropped onto a lane without a check for a car already there. The follow logic ignores gaps below −1 m, so the two cars **drive through each other** (~200 car-in-car frames in 72 s, overlap up to 8.5 m). This mostly happens 60–140 m away, which is still visible on avenues. **Fixed**: `place()` backs a car off until its lane is clear and the follow logic also handles overlapping cars; now asserted strictly (0 frames) | `vehicles.test.ts` › same-lane overlap |
| 8 | People: `src/nyc/people.ts` | A few people are under 1.5 m (shortest 1.47 m). This is plausible, but it sits under the 5th-percentile adult. **Fixed** (4729f14: women 1.58–1.74 m); strict | `crossing.test.ts` |
| 9 | Shops: `src/shopkit/layouts.ts` (deli) | **Fixed** (ATM moved to the end of the wall shelving; test strict). The deli has a 0.55 × 0.6 m fixture ~1.3 m inside the entrance, within 0.7 m of the door's axis. Customers walk into it. | `shop.test.ts` › entrance |
| 10 | Shops: `src/shopkit/layouts.ts` | **Fixed** (toy tables back to back, no endcap into the deli back bar, garden benches clear of the racks, electronics service counter moved, hardware drawers out of the wall; test strict). Fixture colliders overlap. In toys, two 1.85 × 1.18 tables overlap by 0.74 m. In deli, the counter and the back bar overlap by 0.4 × 0.37 m. In garden, the end racks overlap the back shelf, and a rack overlaps the 1.45 m display. In electronics, there is a 0.19 m overlap. In hardware, one fixture sits 0.19 m into the right wall. | `shop.test.ts` › fixtures |
| 11 | Museum: `src/museum/atrium.ts` | `new Rng(Date.now())`: the atrium is different on every visit. Its layout cannot be tested for determinism and it does not come back identical (galleries do). This may be intentional. | (not asserted) |
| 12 | NYC: `src/nyc.ts` `street()` | **Fixed here.** A subway entrance (2.2 × 5.4 m) could be placed in front of a shop door, which put the door's return point inside the stairs. Subway entrances now skip spots within 4.5 m of a door. | `nyc.test.ts` › doors reachable / return points |

Minor items:

- ~~`people.ts` called `toNonIndexed()` on already non-indexed geometry~~ (fixed in 787b233).
- `public/museum/s/*.json` (offline size shards) is not in the repo. Without it, sand3d galleries in Node (and the first visit in a browser) must stream every object to measure it. The qa suite therefore tests sand3d galleries through `assemble`/`planRoom` on synthetic objects, and tests real galleries through the Smithsonian rooms, whose sizes come with the catalog.

## Real scale (`src/realscale.ts`), checked by `tests/realscale.test.ts`

- **Before:** objects were corrected only when the title or the entry contained a word from the hand-written SIZE table. Otherwise only very wide family ranges applied (vehicle 0.5–25 m), so a 0.6 m "BMW 4" (label `coupe`) stayed toy-sized. Title words also beat compound labels: a `puzzle_cube` became a 0.3 m "puzzle".
- **Now:**
  - **Label table:** `scripts/build_realsize.py` measures every object's raw size (`public/museum/t` + `public/museum/s`, 79,985 objects). It writes `src/realsize-labels.ts`: the median size for each of 2,984 entry labels (n ≥ 3), the measured 10th–90th percentile spread for 373 broad labels, and measured per-family ranges.
  - **Lookup order:** the entry label (measured) comes first, then the hand SIZE table, then title head nouns. A guess from a title word must also fit the family range.
  - **Corrections:** anything inside its plausible band is never touched. Clearly wrong objects are fixed by a unit factor (mm/cm/inch/ft read as metres) when that lands within 1.6× of typical; otherwise they are scaled to the typical size.
- **Stats** (46,227 objaverse objects, measured against the new bands):
  - Plausible as modelled: 86.8%. After the old realScale: 86.6%. After the new one: 100%.
  - The new realScale rescales 6,111 objects (old: 8,455): 3,370 by a unit factor, 3,059 of them down (old: 3,438 down).
  - Example: "BMW 4" at 0.6 m comes out at 4.28 m (old: 0.6 m).
- **Hand SIZE values that disagree with the measured label medians by more than 3×** (the label wins for entry labels): tower, console, airplane, reactor, press, bridge, flower, transformer, hoop, carriage, lamp, handbag, clock, candle, warehouse, floodlight, train, crane, turbine, dryer, tugboat. These are worth a look by their owners.

## Shop aisles (tests/shopaudit.test.ts)

- Customer aisles in every shop type are now >= 0.9 m between facing fixtures (deli case queue 0.48 -> 1.23 m, pharmacy counter queue 0.86 -> 1.25 m, electronics demo tables 0.55 -> >= 1 m, sports plinths/bins 0.65-0.8 -> 1.0 m).
- KNOWN (soft): staff-side gaps under 0.9 m remain in deli (0.68-0.76 m behind the deli case, 0.63 m behind the counter), pharmacy (0.48 m between the checkout counter and its back gondola), lighting (0.75-0.86 m between lamp vignettes) and furniture (0.45 m at one vignette).
