---
name: mesh-simplification
description: Detail-preserving polygon reduction and LOD chains for this three.js world. Covers meshoptimizer 1.3 attribute-aware simplification, simplifying a whole asset at one shared error budget, rebuilding crease normals, removing back-to-back twin triangles, sloppy fallback, normal-map baking in Blender, screen-space-error LOD switching (ScreenLOD), and cheap Node checks (14-view z-buffer error, Hausdorff). Use before you simplify any GLB, build vehicle/prop/scan LODs, add runtime LODs to heavy streamed models, or judge whether a LOD lost visible detail.
---

# Mesh simplification that keeps the detail

**Goal:** fewer triangles where nobody can see the difference.

**Rule:** a LOD is good when its error, projected to the screen at the distance where it is shown, stays under about 1 px. Measure what a viewer sees. Hidden geometry does not count.

## Tools in the repo

| What | Where |
|---|---|
| meshoptimizer **1.3** simplifier, vendored (MIT). The npm `meshoptimizer` here is 0.18: it has no `simplifyWithAttributes`, `Permissive`, `ErrorClamped`, `Prune` or `simplifySloppy` lock. Don't upgrade the shared node_modules. | `src/vendor/meshopt_simplifier.js` |
| Array API: `simplifyMesh`, `simplifySloppyMesh`, `lodChain`, `switchDistance`/`pixelSize`, `uvSeamLock`, `autoUvWeight`, `compact`, and the metrics `viewError` and `surfaceDistance` | `src/meshlod-core.ts` (works in the browser and in plain `node`; Node ≥22.18 strips TS types) |
| Whole glTF-Transform document → triangle budget | `scripts/lib/simplify-doc.mjs`: `simplifyDocument`, `dropTwinTriangles`, `fixInvertedNormals`, `creaseNormals` |
| Runtime LOD chains for streamed models | `src/meshlod.ts`: `addLods(root)`, `ScreenLOD`, `lodTris`; work runs in `src/meshlod.worker.ts` |
| Triangle/attribute census | `node scripts/mesh_stats.mjs a.glb ...` |
| Error vs source (Hausdorff + 14-view z-buffer) | `node scripts/lod_compare.mjs source.glb lod1.glb lod2.glb ...` |
| Plain GLB for Blender (+ `--clean`) | `node scripts/glb_plain.mjs in.glb out.glb [--clean]` |
| Normal-map bake from high to low | `scripts/bake_normals.py` (Blender venv from AGENTS.md, run under `nice -n 19`) |
| Labs | `?lab=lod-compare&files=a.glb,b.glb[&wire=1&paint=#hex&nonormal=1]`<br>`?lab=lod-runtime[&cat=&i=&px=0]` |
| Tests | `npm run qa -- meshlod` |

## Technique by asset type

| Asset | Technique | Settings that worked |
|---|---|---|
| **Hard-surface exports** (cars, Sketchfab/Objaverse props: faceted, many materials, double shells) | `simplifyDocument(doc, { targetTris, normals: 'rebuild' })`:<br>1. drop normals and the uvs of untextured parts<br>2. snap to a 0.1 mm grid and weld<br>3. drop twin triangles<br>4. bisect ONE world-space error shared by every primitive<br>5. rebuild 35° crease normals | near ~14k (cars with fine relief 18–22k): `maxError 0.03`<br>mid 7k: `0.15` + `sloppyFallback`<br>far 2k: `0.5` + `dropUv` + `sloppyFallback` |
| **Scans / organic, connected, textured** (Smithsonian, GSO, Objaverse scans) | `lodChain(m, [0.25, 0.06], { normalWeight: 0.5 })`: attribute-aware, auto uv weight, uv seams kept. The model's own colour and normal maps still fit. | Errors here are tiny: a 1M-tri bumpy sphere gives 0.8 mm at 25 % and 3.1 mm at 6 %. A 1M-tri chain takes 1.8 s in wasm, so build it in the worker. |
| **Organic with lost relief** (a low LOD of a sculpt) | Simplify, then bake a tangent-space normal map from high to low (`bake_normals.py`). | A 204k → 3k blob got its ridges back. Size 1024, `--extrusion 0.02 --ray 0.05`, Smart UV Project at 66°. |
| **Far, tiny on screen** | `simplifySloppyMesh`, or an impostor/billboard (see `src/nyc/streettrees.ts`). | Use it only where edge collapse saturates. |

Why one shared error and not one ratio per primitive: gltf-transform's `simplify({ratio})` cuts every part by the same fraction. Seams then stop it early: the old near LODs stayed at 25–61k. With a shared error, flat panels lose the most and wheels and grilles keep their triangles. This is a uniform screen-space error.

## Results here

Measured with `node scripts/lod_compare.mjs`. Each LOD is compared with the unsimplified source; "seen" is the 14-view result, given as outline (silhouette) mismatch and visible depth error.

**Near LOD** (shown within 12 m; default budget 14k, per-car `near` budgets for accord, suburban and charger):

| Car | Tris old → new | Visible depth mean old → new | Outline mismatch old → new |
|---|---|---|---|
| accord | 57,357 → 21,522 | 6.3 → 4.1 mm | 0.31 → 0.34 % |
| suburban | 32,922 → 19,571 | 11.3 → 7.5 mm | 0.65 → 0.46 % |
| charger | 61,125 → 18,120 | 11.4 → 5.8 mm | 0.54 → 0.49 % |
| prius | 29,166 → 13,879 | 6.7 → 4.4 mm | — |
| escalade | 28,027 → 13,860 | 16.2 → 6.2 mm | — |
| explorer | 44,596 → 14,116 | 13.9 → 8.2 mm | — |
| taxi_cv | 24,994 → 14,043 | 0.1 → 1.0 mm | — |
| sprinter | 24,991 → 14,007 | 0.2 → 1.5 mm | — |
| accord19 (400k source) | 24,415 → 30,961 | 34.8 → 18.5 mm | — |

- **taxi_cv and sprinter:** their errors stay under 1 px at 1 m.
- **accord19:** it stays over budget because the error cap is hit.

**Mid LOD, 7k budget** (was 4.5k; at 4.5k the 150 mm error cap made the outline worse than the old LODs):

- Every car is better than before. Outline mismatch is 0.2–3.3 % (old: 1.7–5.1 %), and visible depth error is 4–86 mm (old: 26–172 mm).

**Far LOD, 2k budget** (3k for charger):

- Outline mismatch is 0.9–15 % (old: up to 21 %). Charger: 7.05 → 5.39 %.

**Totals:**

- Lab line-up: 367k → 160k triangles on screen.
- Vehicle GLBs: 6.8 → 6.3 MB.

**Runtime LODs:**

- **Smithsonian scan:** a 150k-tri scan shown at 1.5 / 6 / 24 m draws 55.5k instead of 450k triangles and looks the same.
- **Objaverse original:** member 1:4 of museum theme 1 (a 38 MB GLB with 1.07M tris) was fitted to 1 m and placed at 1.5 / 6 / 24 m. Its meshes that got LODs draw 201k / 71k / 38k instead of 840k each.
- **px=0 (originals forced):** the same scene is about 3.2M tris per frame, and the software renderer timed out taking the screenshot.

## Recipes

### Build LODs of a GLB offline

```js
import { simplifyDocument } from './lib/simplify-doc.mjs';
// after flatten()/join()/weld(), before textureCompress()/meshopt()
const r = await simplifyDocument(doc, { targetTris: 14000, normals: 'rebuild', creaseDeg: 35, maxError: 0.03 });
// r = { before, tris, error (m), sloppy }; when tris stays above the target, the error cap was hit (keep it, don't melt the near LOD)
```

See `scripts/build_vehicles.mjs`. It defaults to `NEAR=attr`. `NEAR=legacy` gives the old path, and `NEAR=none` writes an unsimplified near LOD as a comparison source.

### Add runtime LODs to anything streamed

```ts
import { addLods, lodTris } from './meshlod';
await addLods(scene);  // meshes >= 40k tris -> ScreenLOD [100 %, 25 %, 6 %], index buffers only
const budgetTris = lodTris(scene); // finest level only
```

- **Hooks already in place:** `fetchOriginal` in `src/detail.ts`, and `loadLibraryModel` in `src/libraries.ts` (full quality only).
- **Cloning** with `clone(true)` keeps the chain.
- **`ScreenLOD.pixels`:** default 1. Set it to 0 to force the originals for comparison shots.
- **`ScreenLOD.screenHeight`** follows the window.

### Pick the switch distance

- **meshoptimizer's rule:** a level with absolute error `e` (world units, so multiply by the object's world scale) is OK while `e <= pixels * d * 2 tan(fov/2) / screenHeight`, where `d` = distance to the bounding sphere's surface.
- **One pixel at 1080p and 60° fov:** about 1.07 mm per metre of distance. So a 1 cm error becomes invisible beyond about 9.4 m (`switchDistance(0.01, 60, 1080)`).
- **Hysteresis:** keep about 10 % on the way to coarser levels.
- **Fixed-distance LODs** (like the vehicles' NEAR 12 m / MID 40 m): choose each level's error cap from that rule. At 12 m, 1 px ≈ 13 mm, so a mid LOD at 150 mm error is visibly coarse at its near end. Raise its budget or push its switch distance out, rather than lowering the error cap.

### Bake a normal map

```bash
node scripts/glb_plain.mjs hi_meshopt.glb hi.glb --clean   # Blender cannot read EXT_meshopt_compression; --clean = twins + inverted normals
node scripts/glb_plain.mjs lo_meshopt.glb lo.glb --clean
nice -n 19 $VENV/bin/python scripts/bake_normals.py hi.glb lo.glb out.glb out_normal.png --size 1024 --extrusion 0.02 --ray 0.06
```

The script:

1. imports the low first, so its material names stay exact;
2. joins each mesh and bakes its transforms in;
3. `remove_doubles` the low (otherwise every face becomes its own UV island);
4. Smart UV Project into a new `bake` UV set;
5. runs a Cycles bake: NORMAL, TANGENT space, selected-to-active, cage extrusion and max ray distance in metres;
6. wires a Normal Map node on the `bake` UVs and exports with tangents. The result is `normalTexture.texCoord = 1`.

One bake takes 1–3 s here.

**Before baking, clean both meshes** with `glb_plain.mjs --clean`, which runs `dropTwinTriangles(doc, true)` (by position) and `fixInvertedNormals(doc)`. Otherwise the cage rays hit back faces and you get "olive" texels, which are inverted (0.5, 0.5, 0) normals.

## Pitfalls found (each cost real time)

1. **Seams stop a ratio-per-primitive simplify.**
   - **Symptom:** the near LODs stayed at 25–61k tris.
   - **Fix:** weld without normals (`normals: 'rebuild'`), or use `Permissive` together with attribute weights.
2. **`Permissive` with the original normals gives dark, wrong shading.**
   - **Cause:** collapsed vertices keep the normals of other facets. This was seen on wheel rims.
   - **Fix:** when you collapse across normal seams, rebuild the normals afterwards (`creaseNormals`).
3. **Twin triangles: the same 3 positions with opposite winding ("double-sided by duplication").**
   - **What happens:** once welded, every edge has 4 faces and the simplifier tears panels apart, so windscreens vanish.
   - **Scale:** accord had 10,727 of them and accord19 had 152,930.
   - **Fix:** `dropTwinTriangles` keeps the one facing away from the part's centre and sets the material double-sided.
4. **Some meshes are a soup of open patches.**
   - **Example:** accord19 saturated at about 24k from 0.01 to 0.2 m error.
   - **Why the obvious fix fails:** snapping and welding does not help, and neither does `Prune`.
   - **Fix:** `sloppyFallback` for the mid and far LODs only.
5. **Don't trust `surfaceDistance`/Hausdorff alone.**
   - **Why:** it counts hidden inner shells (trunk floors, inner panels). They gave a 273 mm "loss" that was invisible.
   - **Use instead:** `viewError`, which z-buffers from 14 directions and reports silhouette mismatch and visible depth error.
   - **Bounding boxes:** they can shrink legitimately when invisible junk goes. The sprinter lost a 0.7 m stray part.
6. **Normal-map baking on fragmented hard-surface cars did not work.**
   - **Cause:** 27 materials, hundreds of small parts and a 6× ratio left per-triangle islands and inverted texels. Even with clean twins, the result had white specular patches.
   - **Decision:** not adopted for vehicles. The crease-normal LOD already matches the 57k original.
   - **Where to bake:** connected organic surfaces, as in the table above.
7. **Raw Objaverse scale.** Primitives can sit under a 0.006 node scale. Convert errors with each primitive's world scale (`worldScale` in simplify-doc), never in raw units.
8. **three.js `SimplifyModifier`:** O(n²)-ish, unaware of seams, and it ignores UV error. Don't use it at runtime for anything above a few thousand triangles. Use `addLods` instead (wasm, worker, attribute-aware).
9. **Quantised GLBs** (gltf-transform `meshopt()` quantises by default):
   - read positions with `getElement` (dequantised) and apply the node matrix;
   - `MeshoptSimplifier.getScale` asserts on non-Float32 input.
10. **Texture LOD** is separate from geometry: use mipmaps (automatic), KTX2/webp, and `textureCompress` resize per LOD. The vehicles use 1024/256/64 px. The `shrinkTextures` cap in detail.ts is 2048.
11. **Bisection early exit.**
   - **Symptom:** prius mid fell to 952 tris.
   - **Cause:** a hit 3 % *over* the target was not accepted as the result. The loop then fell through to `maxError` and melted the LOD.
   - **Fix:** the loop now accepts a close hit from either side. Always compare the final triangle count with the target in the build log.

## Verify cheaply (no full world)

1. **Numbers:** `node scripts/mesh_stats.mjs out/*.glb` and `node scripts/lod_compare.mjs src.glb out/lod*.glb`. Watch the "seen" line:
   - near LOD depth mean under about 1 px at its closest distance;
   - silhouette under 1 % for near and under about 8 % for mid.
2. **Rules:** `npm run qa -- meshlod` checks the vehicle budgets, ratios, silhouette, normals and uvs, plus ScreenLOD behaviour.
3. **Looks:** put the GLBs under the gitignored `public/_lodtmp/` (it holds a `.gitignore` of `*`). Then shoot `?lab=lod-compare&files=_lodtmp/a.glb,...` one file per shot at the same `cam`, and montage them side by side.
   - **Wait:** car labs load slowly; use `--wait 3000`. If the shot reports `tris=14` it was taken before the load. Retry with a longer wait.
4. **Runtime LOD counts:** `?lab=lod-runtime`. Use `--eval` with a promise that polls `window.__lodRuntime` until it is non-empty.
