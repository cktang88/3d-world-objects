---
name: fast-3d-testing
description: Fast, cheap testing and iteration for this three.js world on a GPU-less, shared, CPU/RAM-limited machine. Use before verifying or iterating on any 3D change (proportions, placement, game logic, looks, perf counts) instead of full-world screenshots.
---

# Fast 3D testing and iteration

This machine has **no GPU** (SwiftShader software rendering), 4 CPUs shared by many agents and 16 GB RAM. A full-world screenshot costs minutes and ~2 GB and often crashes. Most questions don't need pixels. Pick the cheapest check that answers the question:

| Question | Cheapest check | Cost |
|---|---|---|
| Does it compile? | `npx tsc --noEmit -p .` | seconds |
| Sizes, distances, angles, overlaps, reachability, game logic, budgets, determinism | `npm run qa:changed` or `npm run qa -- <area>` (Node only: real generators, no renderer, no textures) | 2–15 s per area |
| One number from a real scene (tris, mesh count, a position) | lab scene + `--eval` returning JSON, tiny viewport | ~10–30 s |
| Does it *look* right? | lab scene screenshot with `--fast` (or `--notex --nopost` at small size) | ~30–60 s under load |
| Draw calls / triangles of the real world | `node scripts/perf.mjs` (counts only, takes the world lock) | minutes |
| Why is a page slow to boot / to its first frame? | `node scripts/boot.mjs --url "/?lab=x&fast=1" [--profile] [--programs] [--frames 5] [--steady 30]` | ~10–60 s |
| Does a player journey still work end to end (street, shop, building, elevator, museum, districts, edges)? | `npm run e2e -- <journey>[,...] --port <port>`: the real game, logic only (no drawing), takes the world lock, ≤ 240 s each, RAM watchdog; see `scripts/e2e/lib.mjs`, `docs/research/e2e-findings.md` | 1–3 min each |
| Full-world screenshot | last resort, under the lock | minutes, ~2 GB |

## 0. Never the full city while developing

**Never render the full city in dev/QA. Use Node `qa` first, then `?fast=1` labs.** Don't render or simulate the whole city for dev, QA or e2e work. Use the smallest slice that answers the question:
- **Node `qa` tests:** no rendering at all.
- **A lab scene:** one object, building, room or corner.
- **`?mode=world&r=0`:** only the block you're on. `&r=1` gives a 3×3 patch. Add `&people=0` and the fast flags.

Even a three-car lab takes minutes to render here under load. Full-city counts are a one-off measurement at the end, never part of an iteration loop.

## 1. Logic and proportions: `npm run qa`

- **Run only what you touched:**
  - `npm run qa:changed` picks the tests for the files you changed vs `origin/main` (the `SRC_MAP` in `scripts/qa.mjs`).
  - `npm run qa -- <area>` runs one area: `nyc`, `ground`, `people`, `vehicles`, `shop`, `interior`, `vertical`, `museum`, `seamless`, `districts`, … (`AREAS` in `scripts/qa.mjs`), or any test-file path pattern.
  - `-t "<regex>"` picks tests by name. `QA_VERBOSE=1` lists passes and known-issue notes.
  - The whole suite (`npm run qa`) takes about 15–30 s under load. Run it only at check-ins.
- **Hard limits:** 20 s per test (`QA_TEST_TIMEOUT`), 45 s per file (`QA_FILE_TIMEOUT`, the process is killed), 120 s total (`QA_MAX`).
- **How it works:** `tests/*.test.ts` are bundled by esbuild and run in plain Node processes (three.js scene graphs work without a renderer).
  - `tests/shim.ts` fakes `document`, canvas (no-op 1×1), `Image` (loads at once), `fetch`, `Worker` and `localStorage`. `fetch` serves `public/` from disk and blocks remote URLs; binary assets 404 unless a test calls `allowModels(/assets\/people\//)`. `Worker` answers every request with an error.
  - **Helpers:**
    - `tests/qa.ts`: `test`, `expect`, `between`, `none`, `soft`, `stats()` (meshes/tris/materials), `sceneHash()`, `Grid` (collider flood fill).
    - `tests/world.ts`: `nycChunk(seed, cx, cz)` builds one block, not the 3×3 the level constructor builds.
    - `tests/env.ts`: `settle`, `allowModels`, `setSearch('people=40')`. A URL flag must be set before you dynamically `import()` the module that reads it.
  - **Known bugs** go in `docs/research/qa-findings.md`. In the test they are `soft(false, 'KNOWN …')`: a NOTE that does not fail. Remove the allowance when you fix the bug.
  - **New test file:** add its area to `AREAS` and its source files to `SRC_MAP` in `scripts/qa.mjs`.
- Tests run the real level generators (NYC chunks, buildings, shops, interiors, museum, people, vehicles). No textures, no remote models.
- Add a test for every rule you care about, instead of eyeballing a screenshot:
  - **real-scale ranges:** door 2.0–2.4 m, stair rise 15–20 cm / run 25–30 cm, counter ~0.9 m, curb 15–18 cm, car 4–5.5 m, person 1.5–1.95 m; museum objects never scaled down
  - **AABB overlaps:** props vs walls vs each other, nothing blocking doors
  - **reachability:** flood fill over the colliders from the spawn to every portal
  - **orientation:** dot product of each object's forward with the room centre or the street
  - **simulation:** step `update(dt)` N times at fixed dt and assert behaviour (pedestrians on sidewalks/crosswalks, cars stop at red, containers only generate after open)
  - **budgets:** count meshes, triangles and materials from the scene graph
  - **determinism:** same seed gives the same hash
- If a module won't import in Node, add the smallest guard (`typeof document !== 'undefined'`) rather than skipping the test.

## 2. Look: lab scenes, small and stripped

### Render only the changed block (instead of a world shot)

A street-level check of a city change does not need `?mode=world&r=1` (minutes, ~2 GB, often "Target crashed"). Render only the chunk you changed, by the real generator, at its world position, with the camera at the world pose:

- `?lab=block&pose=x,y,z,yaw[,pitch]` — builds chunk (round(x/120), round(z/64)) (or `&cx=&cz=`) exactly as `NycLevel.block` does, camera at the eye (y ≈ 1.7, yaw as `player.yaw`: 0 looks north/-z, π/2 looks -x).
- `&ring=1` adds the 8 neighbours as HLOD proxies (cheap to draw; still built on the CPU), `&ring=2` as real blocks; `&water=0` drops the rivers and far shores; `&wait=` seconds for showcase objects (default 8).
- No world lock needed. Example: `node scripts/shot.mjs --port <port> --url "/?lab=block&pose=592,1.7,89.5,1.57,0.15&people=0" --w 768 --h 432 --out <scratchpad>/x.png` (~30–60 s, ~130 draws).
- If you do need the full game: `r=0` and teleport, and poll `__world.level` (`pending` empty, chunks built) instead of a fixed wait. Shoot from a frozen copy of `src/` on its own vite port if you keep editing: the live dev server reloads the page on every file change.

- Never iterate in the full world. Build only your thing in `src/lab/<name>.ts` (see `src/lab.ts`; files there are auto-registered; `?lab=index` lists them).
- Screenshot:
  `node scripts/shot.mjs --port <port> --url "/?lab=<name>&cam=x,y,z&look=x,y,z" --out <scratchpad>/x.png --fast`
- **Defaults:** 480×270, `--quality low`. Go bigger only for a final comparison shot.
- **Flags** (in `src/flags.ts`, which works for labs, the world and the museum):
  - `?fast=1` / `--fast`: the preset. It is `r=0` (just your block), `people=0`, `notex=1`, `post=0`, `shadows=0` and `quality=low` (pixel ratio 1). Flags you give explicitly win, e.g. `--fast --url "/?lab=x&people=20"`.
  - `?notex=1` / `--notex`: flat colours. No image/texture/HDRI/PBR downloads (shot.mjs aborts them), and every material's maps are removed. Alpha-cut cards such as leaves become solid quads.
  - `?post=0` / `--nopost`: no GTAO/bloom/grading passes, a direct render.
  - `?shadows=0` / `--noshadows`: no shadow maps.
  - `--quality low|high|ultra`
  - `--wait <ms>`: wait for streaming.
  - `&settle=<ms>`: lab settle time.

  Use `--fast` (or `--notex --nopost`) whenever you are judging shape, layout or proportion, not materials.
- Prefer one `--eval "JSON.stringify(...)"` over a screenshot when you need a number (`window.__world` exposes renderer, player and level; `window.__world.perf()` gives counts).
- Compare against reference photos side by side (download a reference, Read both images).

## 3. Perf counts

- `window.__world.perf()` returns whole-frame and per-pass draw calls, triangles and programs. `perf({top: 20})` lists the heaviest in-frustum meshes. `?perf=1` shows the overlay.
- `node scripts/perf.mjs --poses avenue[,...] [--compare docs/research/perf-baseline.json]` records counts at fixed poses (city at `?r=1`; `--full` only once at the end). **Counts only.** SwiftShader frame times are meaningless; never report them.
- `node scripts/boot.mjs --url ...` times the boot stages (`src/boot.ts` marks: modules, manifest, museum data, pbr, level build, programs, first frame) and with `--profile` / `--steady 30` shows where the CPU goes. Typical costs found so far: shader compiles (~0.3–1 s per program here: keep program counts down), per-pixel canvas texture generation (skip it under `notex`), work in background systems (seamless prebuilding).

## 4. Rules for the shared machine

**Nothing runs long, and nothing crash-loops.** These are hard limits:
- **Time caps:** every screenshot/perf run is capped (`shot.mjs --max`, default 240 s, max 600 s). Batch jobs (Python/Blender) run in chunks of 15 min or less that resume from a cache. Waiting on the world lock is capped: `flock -w 300`. `scripts/reap.sh` kills anything over these limits (lock waits over 5 min, shots/perf/browsers over 10 min, Python/Blender over 20 min), and the coordinator runs it every check-in.
- **Logging:** log progress with timestamps to a file in your scratchpad (`... 2>&1 | tee <scratchpad>/run.log`), so a slow or dying run shows *where* it is stuck. `shot.mjs` prints `[shot +Ns]` stages.
- **Failures:** if a run fails or times out **twice**, do not retry the same thing. Make the experiment smaller:
  - a lab instead of the world
  - one building, one room or one object
  - `?notex=1&post=0`, `--quality low`, a smaller viewport
  - a `qa` test instead of pixels
  - fewer chunks or people (`?people=0`)
- **Background jobs:** never start a background job without a timeout (`timeout 600 ...`).

- **Full-game runs** (`?mode=world` / `?mode=museum`) run one at a time across all agents:
  `flock -w 300 /tmp/claude-0/world-shot.lock node scripts/shot.mjs --max 600 ...` (`perf.mjs` takes the lock itself).
- **Your own dev server:** `npx vite --port <port> --strictPort &` in your worktree. Kill it when done.
- **Parallel workers:** keep Python/Blender worker counts low (≤ 4–16).
- **Memory errors:** if a headless page crashes ("Target crashed"), it is usually RAM. Retry under the lock with a smaller scene, not a bigger timeout.

## 5. Iteration loop

1. Write or extend a `qa` test for the rule. It runs in seconds: make it fail, fix it, make it pass.
2. Tune looks in a lab scene with tiny screenshots (`--notex --nopost` until materials matter).
3. Before each commit run `tsc` and only the tests for what you touched (`npm run qa:changed`, or `npm run qa -- <area or file pattern>`). Never run the whole suite per commit. Run the full suite only occasionally, e.g. at the end of a feature, and the coordinator runs it at check-ins. Commit small, push to main.
4. Only at the end of a feature: one perf count or one full-world shot under the lock.
