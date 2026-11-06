---
name: fast-3d-testing
description: Fast, cheap testing and iteration for this three.js world on a GPU-less, shared, CPU/RAM-limited machine. Use before verifying or iterating on any 3D change (proportions, placement, game logic, looks, perf counts) instead of full-world screenshots.
---

# Fast 3D testing and iteration

This machine has **no GPU** (SwiftShader software rendering), 4 CPUs shared by many agents and 16 GB RAM. A full-world screenshot costs minutes and ~2 GB and often crashes. Most questions don't need pixels. Pick the cheapest check that answers the question:

| Question | Cheapest check | Cost |
|---|---|---|
| Does it compile? | `npx tsc --noEmit -p .` | seconds |
| Sizes, distances, angles, overlaps, reachability, game logic, budgets, determinism | `npm run qa [-- <pattern>]` (Node only: real generators, no renderer, no textures) | < 30 s for all |
| One number from a real scene (tris, mesh count, a position) | lab scene + `--eval` returning JSON, tiny viewport | ~10–30 s |
| Does it *look* right? | lab scene screenshot, small, low quality, no textures/post if the look doesn't depend on them | ~20–60 s |
| Draw calls / triangles of the real world | `node scripts/perf.mjs` (counts only, takes the world lock) | minutes |
| Full-world screenshot | last resort, under the lock | minutes, ~2 GB |

## 1. Logic and proportions: `npm run qa`

- Tests live under `tests/` and run the real level generators (NYC chunks, buildings, shops, interiors, museum, people, vehicles) in Node with a shim for canvas/Image/fetch/Worker/localStorage. No textures, no remote models.
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

- Never iterate in the full world. Build only your thing in `src/lab/<name>.ts` (see `src/lab.ts`; files there are auto-registered; `?lab=index` lists them).
- Screenshot:
  `node scripts/shot.mjs --port <port> --url "/?lab=<name>&cam=x,y,z&look=x,y,z" --out <scratchpad>/x.png --w 480 --h 270 --quality low`
- **Flags:**
  - `--quality low` (G key levels)
  - `?notex=1` / `--notex`: flat colours, no texture/HDRI/PBR loads
  - `?post=0` / `--nopost`: no GTAO/bloom
  - `--wait <ms>`: wait for streaming
  - `&settle=<ms>`: lab settle time

  Use `--notex --nopost` whenever you are judging shape, layout or proportion, not materials.
- Use a 480×270 viewport by default. Go bigger only for a final comparison shot.
- Prefer one `--eval "JSON.stringify(...)"` over a screenshot when you need a number (`window.__world` exposes renderer, player and level; `window.__world.perf()` gives counts).
- Compare against reference photos side by side (download a reference, Read both images).

## 3. Perf counts

- `window.__world.perf()` returns whole-frame and per-pass draw calls, triangles and programs. `perf({top: 20})` lists the heaviest in-frustum meshes. `?perf=1` shows the overlay.
- `node scripts/perf.mjs [--poses avenue,...] [--compare docs/research/perf-baseline.json]` records counts at fixed poses. **Counts only.** SwiftShader frame times are meaningless; never report them.

## 4. Rules for the shared machine

- **Full-game runs** (`?mode=world` / `?mode=museum`) run one at a time across all agents:
  `flock /tmp/claude-0/world-shot.lock node scripts/shot.mjs ...` (`perf.mjs` takes the lock itself).
- **Your own dev server:** `npx vite --port <port> --strictPort &` in your worktree. Kill it when done.
- **Parallel workers:** keep Python/Blender worker counts low (≤ 4–16).
- **Memory errors:** if a headless page crashes ("Target crashed"), it is usually RAM. Retry under the lock with a smaller scene, not a bigger timeout.

## 5. Iteration loop

1. Write or extend a `qa` test for the rule. It runs in seconds: make it fail, fix it, make it pass.
2. Tune looks in a lab scene with tiny screenshots (`--notex --nopost` until materials matter).
3. Run `tsc` and the relevant `npm run qa -- <area>` before each commit. Commit small, push to main.
4. Only at the end of a feature: one perf count or one full-world shot under the lock.
