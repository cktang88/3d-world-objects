# Working on this repo (parallel agents)

Several agents work at once, each in its **own git worktree**, each owning a set of files. Commit small and often straight to `main`.

## Setup in your worktree

```bash
ln -s /home/user/3d-world-objects/node_modules node_modules   # share deps; do not npm install
npx vite --port <your port> --strictPort &                    # your own dev server
```

The Blender + sand3d Python env (for rebuilding objects from their programs) is at
`/tmp/claude-0/-home-user-3d-world-objects/8099eee9-d314-5309-8ed7-ba7c5d8c746e/scratchpad/venv/bin/python`.

## Hard limits (read first)

Nothing may run long or crash-loop. Shots and perf runs stop at `--max` seconds (default 240). Lock waits use `flock -w 300`. Batch jobs run in chunks of 15 minutes or less that can resume. Log progress to a file. After two failures, shrink the experiment rather than retrying it. `scripts/reap.sh` kills overruns. The full workflow is in `.claude/skills/fast-3d-testing/SKILL.md`.

## Testing: fast first

Most questions don't need pixels. Answer them in Node, with no browser:

- **Logic and proportions:** run `npm run qa:changed` (the tests covering files you changed) or `npm run qa -- <area>`. Areas include `nyc`, `people`, `vehicles`, `shop`, `interior`, `museum`, `seamless` and `districts`. The checks run the real generators: sizes, distances, angles, overlaps, reachability, simulations, budgets and determinism. One area takes a few seconds; the whole suite takes under 30 s. Run the whole suite only at check-ins.
- **Writing tests:** add one in `tests/` for each rule you care about. See the skill for the helpers.
- **Known bugs:** they are listed in `docs/research/qa-findings.md`.
- **Screenshots are only for how things look.** Take them in a lab, small, with `--fast` (or `--notex --nopost`). Never render the full city in dev/QA.

The full workflow is in `.claude/skills/fast-3d-testing/SKILL.md`.

## Iterate fast: the lab

Never iterate in the full world. Make a lab scene showing just your thing:

- `src/lab/<name>.ts` default-exports a `LabScene` (see `src/lab.ts`; `src/lab/vehicles.ts` is a minimal example). Files there are picked up automatically.
- Open `/?lab=<name>&cam=x,y,z&look=x,y,z&env=studio|nyc|museum|night`. `?lab=index` lists all scenes.
- Screenshot it: `node scripts/shot.mjs --port <port> --url "/?lab=<name>" --out /tmp/…/x.png --fast`. Then look at the PNG.
- **Defaults:** 480×270, `--quality low`.
- **Fast preset:** `--fast` (`?fast=1`) also turns off textures, post-processing, shadows and people, and streams only your block.
- **Materials:** drop `--fast` only when materials matter. Even then, avoid `ultra`.
- **Full-world runs (`?mode=world`, `?mode=museum`) use ~2 GB RAM each and the machine has 16 GB shared by many agents.** Run them one at a time across all agents: `flock -w 300 /tmp/claude-0/world-shot.lock node scripts/shot.mjs --max 600 ...`. Lab scenes don't need the lock.
- `--eval "<js>"` runs code first. `window.__world` exposes the renderer, player and level (in the full game).

## References first, always

Before modelling or arranging anything, research real reference images on the web: photos of the real thing, and real museum, store or street layouts. Look at them (download an image and Read it to see it).

Write what you learned to `docs/research/<area>.md` with the image URLs and the concrete details you will copy: proportions, colours, materials, typical dimensions, layouts. Build to the references, and compare your lab screenshots side by side with them.

## Assets from outside

- **Licences:** only use **CC0** (preferred: Poly Haven, ambientCG, Kenney, Quaternius, …) or **CC-BY** (credit it). Record every asset in `CREDITS.md` with its source URL and licence.
- **Where:** put files in `public/assets/<area>/`.
- **Size:**
  - Compress GLBs with `npx gltf-transform optimize in.glb out.glb --compress meshopt --texture-compress webp --texture-size 2048`. The viewer's GLTF loader (`gltf()` in `src/detail.ts`) supports Draco, Meshopt and KTX2.
  - Keep any single file under about 8 MB and your total under about 60 MB.
- **CDNs:** big texture sets can stream from a CDN with CORS (Poly Haven does, see `src/pbr.ts`) instead of being committed.

## Commits

- **Size:** small and frequent, each a working state: `npx tsc --noEmit -p .` passes, plus only the tests relevant to what you changed (`npm run qa:changed` or `npm run qa -- <area>`). Don't run the full suite or re-render scenes on every commit.
- **Pushing:** `git fetch origin main && git rebase origin/main && git push origin HEAD:main`. If the push is rejected, rebase and push again. Never force-push `main`.
- **Messages:** say what changed and why. End with:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BpmvtRiJVKMpkdosebwfjq
  ```

- **Ownership:** only edit the files you own. If you must touch a shared file (`main.ts`, `level.ts`, `build.ts`, `textures.ts`, `nyc/common.ts`), keep the edit minimal and self-contained, and rebase carefully.

## Performance budget

It must run in a browser on a desktop GPU.

- **Frequently repeated things** (cars, people, buildings, street props) get the most detail, but use instancing, shared geometry/materials and LODs.
- **Rare things** can be simpler.
- **Watch the counts:** `renderer.info` for draw calls and triangles. Aim for under ~1500 draw calls and ~5M triangles on screen.
