# End-to-end playtest findings (`npm run e2e`)

Headless playtests of the real game (`window.__world`), driven with scripted input. They find
integration bugs that the Node `qa` suite misses, because that suite tests one system at a time.

## How to run

```bash
npx vite --port <port> --strictPort &                  # your own dev server
npm run e2e -- street --port <port>                    # one journey
npm run e2e -- shop,building --port <port> --shots     # several, with key screenshots
npm run e2e -- all --port <port>                       # every journey, one after another
```

Journeys live in `scripts/e2e/<journey>.mjs` and share the harness `scripts/e2e/lib.mjs`.

**Limits the harness enforces:**
- **World lock:** each journey re-runs itself under `flock -w 300 /tmp/claude-0/world-shot.lock`.
- **Time:** each journey is capped at 240 s (`--max` can only lower it).
- **RAM:** a watchdog kills the browser past `--maxmb` (default 6000) of RSS for the browser tree.

**Slice and flags:** the world runs at `?mode=world&fast=1` (r=0). Shop, building, elevator, museum and edges add `&seamless=1`, because fast turns seamless off.

**No drawing:** SwiftShader draws the r=0 city at about **0.7 fps** here, which is too slow to walk anywhere. So journeys stub out `renderer.render` while they play. `main.ts`' `frame()` still runs player, level, seamless, vertical, lazy, lighting and weather every frame, at about 27 fps. `shot()` turns drawing back on for each 480×270 screenshot. A screenshot costs 20–60 s, so `--shots` takes only the key ones. `--shots all` takes every one, and `--shots a,b` takes the named labels.

**Input:** walking holds `KeyW` in `player.keys`, which is the real `Player.update` path with the level's (and seamless') colliders. The yaw is pointed at each waypoint. `walkPath()` plans around colliders on a 0.2 m grid. Keys (E, Q, T, Y, digits) are dispatched as real `keydown` events. Containers and doors are aimed at with the real `target()` / `lazy.aim()` prompt before E is pressed.

**Errors:** `pageerror` and `console.error` are collected per check. Any error fails the journey.

**Results** go to `/tmp/claude-0/e2e/<journey>/result.json`, with screenshots alongside.

**`window.__world` additions** (main.ts, read-only): `stack`, `desc`, `started`, `transitioning`, `lazy`, `aimedBox`, `infoOpen`, `mode`.

| Journey | What it does | Checks |
|---|---|---|
| `street` | spawn → 30 m north on the 5 Av sidewalk → kerb → cross W 35 St → T ×6, Y ×7 → walk into the building lines of the spawn block and the newly streamed block | 13 |
| `shop` | walk to the nearest glass storefront → wait for its prebuilt preview → walk through the threshold (no E) → open a cooler (E) → walk out → walk in again | 12 |
| `building` | E on the walk-up street door → stair to floor 2 → E on apartment 2C → open the closet → Q ×4 back to the street | 16 |
| `elevator` | E into the pre-war 303 5 Av → E on the call button → into the car → key 3 → ride → walk out → Q, Q | 13 |
| `museum` | atrium → north doorway (preview, seamless walk-through) → E on an exhibit, E closes it → next doorway → Q, Q | 12 |
| `districts` | teleport to Central Park, Auto Row, the Hudson piers and LaGuardia at r=0 → block streams, arrival toast, walkable spot, showcase sizes | 20 |
| `edges` | T and Q inside a shop; Q while the lift is riding, then the lift again; down the stairs to the lobby (stack pop) → Q | 10 |

**Last full run** (`npm run e2e -- all --shots`, 2026-11-06): every check passed in street, shop, elevator, museum and edges. Two journeys failed:
- **building:** the 4 GB watchdog then in force killed it at boot (#4). The default limit is now 6 GB. The journey passed 16/16 in every run before that.
- **districts:** the intermittent Auto Row check failed (#5).

There were no page errors after the #1 fix.

## Bugs, by priority

| # | Pri | Area / owner | Status |
|---|---|---|---|
| 1 | P1 | `src/nyc/district-showcase.ts` `flatten()` | **Fixed** (2454d9f) |
| 2 | P2 | museum gallery planner (`src/museum/*`, `planRoom`/`assemble`) | open |
| 3 | P3 | `src/main.ts` `goBack()` seamless branch / `seamless.ts` `carry('out')` | open |
| 4 | P3 | boot: world + `seamless=1` | open (perf) |
| 5 | P3 | `src/nyc/district-showcase.ts` loading after a teleport | open, intermittent |
| 6 | P4 | `src/vertical.ts` / `main.ts` Q handler | open |
| 7 | P4 | `src/nyc/district-build.ts` `districtStyle` + `buildings-shop.ts` `storefront` | open |
| 8 | P4 | `src/main.ts` `enter()` toast | **Fixed** (this commit) |

### 1. Quantized showcase models were squashed into a 2 m cube or lost parts (fixed)

- **Repro:** `npm run e2e -- districts --only airport`. Before the fix: teleport to LaGuardia (−310, −128) at r=0.
- **Expected:** aircraft on the apron at real size: every airport slot has `min` ≥ 2.5 m, and planes are 6–75 m.
- **Actual:**
  - "Airplane biplane" was **2.0 × 2.0 m**, "Potez25" was **0.16 m**, and a pier "Boat" was 2.0 m.
  - The console showed `THREE.BufferGeometryUtils: .mergeGeometries() failed while trying to merge the uv attribute`.
- **Cause:**
  - `flatten()` merges a model's meshes. It applied the world matrix to meshopt-quantized attributes (`public/rebuilt/*.glb`: normalized Int16/Uint16 positions and uvs) *in place*, which clamps them to [−1, 1].
  - Mixed array types then made `mergeGeometries` return null for a material bucket, and `if (!merged) continue` silently dropped those parts.
  - The size checks (`realScale`, `plausible`, slot `min`) all ran *before* flatten, on the correct sizes, so they passed.
- **Fix:** convert position, normal and uv to plain `Float32Array` before transforming. After the fix the biplane is 9 m and the Potez 25 is 9 m, with no console errors.
- **Follow-up for the owner:** a qa test that runs `flatten()` on a quantized geometry. It needs a meshopt-decoded fixture in Node.

### 2. Museum: the last row of plinths stands right in front of every far doorway

- **Repro:** `npm run e2e -- museum`. Atrium → "Enter the Vehicles wing" → gallery *Cart & Wagon* (theme 3829). The plinth and wall rectangles below come from `level.colliders()`.
- **Expected:** you can see the next rooms through the three far doorways, which is the point of the seamless preview, and walk straight to them from the room.
- **Actual:**
  - The doorways sit at x = −4.45, 0 and 4.45 (2.2 m wide) in the N wall, whose inner face is at z = −35.25.
  - The last row of plinths is centred on them, 1.15 m from the wall: x −7.66..−3.47, −2.37..1.84 and 2.94..7.66, at z −34.1..−29.9.
  - Every doorway is hidden behind an exhibit from the room's centre line (see the `gallery1` key shot).
  - A straight walk at any doorway hits a plinth. The original journey got stuck at z −10 and z −16, and it needed a grid path planner to thread the 1.15 m gap along the wall.
- **Why the qa test passes:** `tests/museum.test.ts` "a 1.2 m apron inside every doorway is free of displays" only clears the apron, and the plinths sit just outside it.
- **Suggestion:** keep a sight corridor about (door width + 0.6 m) wide and 4 m deep clear in front of each doorway, or offset the plinth rows between doorways.

### 3. Q through a seamless (glass or museum) door keeps your facing: you look back into the door you just left

- **Repro:** `npm run e2e -- edges` (shop part) or `museum` (Q step). Walk into the 24hr Deli and press Q. Or, in the museum, cross into the next gallery and press Q.
- **Expected:** the same result as solid doors and the fade path (`f.exact` → `returnPos`/`returnYaw`): you are on the step or pavement, facing away from the door.
- **Actual:**
  - In the shop, you are on the pavement 1.5 m from the door, with yaw 1.54, which faces the shop window.
  - In the museum, you are placed *inside the doorway passage* (gallery z = −35.3, atrium (−7, −32.75)) with yaw 0, facing the room you just left.
  - One more step forward re-enters it, once `seam.armed()` re-arms.
- **Cause:** the `goBack()` seamless branch uses `seam.carry(child, 'out', player.pos, player.yaw)`, and `carry` adds only the placement rotation to the yaw.
- **Suggestion:** for Q (as opposed to walking out), add π to the carried yaw. In the museum, use the portal's `returnPos` (1.6 m inside the room).

### 4. World boot with seamless on peaks at 2–4.7 GB RSS and sometimes takes ~100 s

- **Repro:** `?mode=world&fast=1&seamless=1`, measured by the harness watchdog over the browser process tree.
- **Numbers:**

  | Run | Peak RSS | Boot time |
  |---|---|---|
  | street (seamless off) | 1.6 GB | 19 s |
  | edges | 2.3 GB | 19 s |
  | shop | 1.7 GB | 98 s and 27 s |
  | elevator | 3.9 GB | 102 s and 45 s |
  | building | 4.7 GB (killed at boot by the then 4 GB watchdog) | 21–123 s |

  The museum run peaked at 3.5 GB.
- **Expected:** about 2 GB (AGENTS.md).
- **Suspect:** at boot, `prewarmShops()` builds a staged `ShopLevel` per shop type, and seamless prebuilds the 2 nearest shops (`builds: 3, prebuilds: 2` at `started`). Under `notex` this probably still makes the per-pixel canvas textures and compiles their programs.
- **Next step:** `node scripts/boot.mjs --url "/?mode=world&fast=1&seamless=1" --profile`. Consider skipping `prewarmShops` under `FLAGS.notex`/`fast`.

### 5. Auto Row's showroom cars sometimes never appear after arriving from the park (intermittent)

- **Repro:** `npm run e2e -- districts --only park,autorow`. Teleport to the park (20, −384), wait about 10–25 s, then teleport to Auto Row (529.8, −320).
- **Expected:** showroom and lot cars (slots `carShow`/`car`, radius 85–120 m) appear within seconds.
- **Actual:**
  - In 3 of the 4 completed runs that came from the park, **no** showcase object was shown within 40 s.
  - In runs that started at Auto Row directly, and in one slower probe that stayed 20 s at the park, 3–46 objects were up.
  - The block itself streams in 0.6–2.4 s.
- **Suspects:**
  - Loads queued behind the park's in-flight slot loads (`SHOWCASE.loads` = 4 concurrent).
  - The `shownTris` budget not being released for slots whose holder was disposed while `loading`.
  - A slot that is `failed` forever after its pool fetches error.
- **Note:** the harness's dynamic import of `/src/nyc/district-showcase.ts` gets a second module instance, so `showcaseStats()` is not readable from a journey. Exposing it on `__world` would help.

### 6. Q works inside a moving lift car

- **Repro:** `npm run e2e -- edges` (lift part). Call the lift, step in, press 4, and press Q while `vert.state === 'riding'`.
- **Expected:** you cannot leave a closed, moving car, or Q waits for the doors.
- **Actual:**
  - You are put back on the street at once, and `vert.state` stays `'riding'` there (harmless).
  - Back in the same building later, the lift works again: call, ride and arrive all pass.

### 7. Same-type storefront runs: four pharmacies in one avenue building, in the first view

- **Where:** at the spawn, 119 5 Av has Ace Chemist, Ray's Drugs & Cosmetics, Drugs & Cosmetics and Big Apple Drugs & Cosmetics, all pharmacies, side by side on the 5 Av frontage.
- **Cause:**
  - `districtStyle()` gives a building 1–2 shop types.
  - `storefront()` picks each unit's type only from those.
  - So a wide avenue building lines up 4+ identical shop types.
- **Suggestion:** allow up to one repeat per building, or pick per unit from the district mix with the building's types weighted up.

### 8. Entering an apartment toasted "Welcome to 119 5 Av · 2C" (fixed)

- **Cause:** `enter()` shows `Welcome to ${name}` for every `interior`, shops and homes alike.
- **Fix:** homes now toast just their name; "Welcome to" is kept for shops.

## What works (each asserted by the journeys)

**Street**
- The spawn is on the sidewalk.
- A 30 m walk and the crossing stay on `walkable()` ground and never enter a collider.
- The block across the street streams in at r=0, and its building line blocks you.
- T cycles four times of day, with "(outside)" shown indoors.
- Y cycles seven weather states, each with a toast.

**Shop**
- The nearest storefront is prebuilt and shown behind its glass within 0.5 s of facing it.
- The door corridor is open.
- Walking through enters seamlessly, with 0 fades and 0 builds.
- The cooler opens, and its 7 meshes appear.
- Walking out puts you 1.5 m outside the door.
- Re-entering costs **0 rebuilds** and 0 fades.

**Building**
- E enters the lobby.
- The half landing is at H/2.
- Flight B switches to floor 2 in the same frame, with `forced` 0.
- The stack is [street, lobby] on every upper floor.
- The apartment and the closet work (17 meshes).
- Q steps back apartment → hall (outside the door) → lobby → street (2.2 m out on the pavement) → "outermost world".
- Going down the stairs pops the lobby again.

**Elevator**
- Call → car arrives (9.5 s from 0) → doors open → key 3 selects floor index 2.
- The car closes, rides and opens. The floor is built during the ride (forced 0).
- You stand at y 0, and the stack is unchanged.

**Museum**
- The preview through the north doorway is ready on arrival, and crossing is seamless.
- The info panel opens with the exhibit's title, and E closes it.
- The second doorway works the same way.
- Q, Q returns to the atrium, never inside a wall.

**Districts**
- The park, Auto Row, the piers and the airport each stream in within 0.05–4.7 s.
- Each arrival toast names the district with its tagline.
- Each arrival spot is walkable.
- Airport objects are 8–15 m after fix #1.

## Harness notes

- **`Target crashed`:** during one early districts run, a different process on the machine grew to about 10 GB and the page was killed. That is why each journey now has its own RSS watchdog, which counts only its own browser tree.
- **Teleport check:** `walk()` treats less than 0.15 m of progress in 1 s as stuck. A teleport (`player.place`) is used only in `openOne(…, {teleport: true})` when furniture blocks the straight walk to a container, and it is logged (`teleported: true`).
