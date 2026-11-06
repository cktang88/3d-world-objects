# Rendering performance: research and plan

Target: desktop GPU, **< 1500 draw calls, ~5M triangles on screen, 60 fps** (16.6 ms), at `quality=ultra`.
Starting point (stated by the team): streamed NYC with 49 resident chunks, ~1,950 meshes and ~10.6M triangles before culling.
three.js r170, WebGLRenderer, EffectComposer (4x MSAA HalfFloat target, GTAO, Unreal bloom, grade), CSM shadows.

This doc is for this codebase, not general advice. Every recommendation names the files and functions it changes.
"Win" figures are estimates from reading the code. They are **not measured**. Work package 1 builds the counters to measure them, and every other package should record before/after counts in its commit message.

---

## 0. What the code does today (findings that drive the ranking)

Most of these come from reading the code, so each one should be confirmed with a count before anyone acts on it (see §9).

1. **Every scene object is drawn in up to 5 passes.** These are the main pass, the GTAOPass normal/depth pass (`GTAOPass.setGBuffer()` with no textures, so `_renderGBuffer = true` and the scene is re-rendered with `scene.overrideMaterial = normalMaterial`), and 3 CSM cascades (`lighting.ts makeCsm()`, `cascades: 3`, 2048² each, `maxFar 260`). Shadow casters are culled against each cascade frustum, but the near cascades still overlap most of the city around the player. **Draw calls and triangles per frame are therefore roughly 2.5–4× the "on screen" numbers.** This multiplier is the single biggest lever in the project.
   - Side effect: the override `MeshNormalMaterial` drops the `onBeforeCompile` vertex patch in `buildings-win.ts anchored()` (`transformed.xy += aAnchor * aSize`). The GTAO normal buffer therefore sees instanced windows at the wrong size, which is a correctness bug as well as a cost.
2. **49 chunks are resident and all of them are visible.** `nyc.ts NycLevel.update()` builds rings up to `RX = RZ = 2` (25 chunks) but only removes chunks beyond `RX + 1`, so the ring-3 hysteresis band (another 24 chunks) keeps rendering at full detail. `camera.far = fogFar + 60 = 480 m`. There is no distance-based hiding and no HLOD.
3. **Parked cars are probably baked with both LODs into chunk static geometry.** In `nyc.ts street()`, `stat.add(carMesh(...))`, and `bake(stat)` (`nyc/common.ts`) traverses every mesh, including both `THREE.LOD` levels from `vehicleFleet.ts fleetObject()`. `vehicleFleet.ts` says near LOD is ~30–75k triangles and far LOD ~6k. With ~10–20 parked cars per block, that is **~0.4–1.5M triangles per chunk, always drawn, in every pass**. If the fleet was not loaded when the chunk was built, a stand-in is baked, and the later `dress()` swaps the children of an orphaned object, so the real model never appears. *Verify first: this alone may account for most of the 10.6M.*
4. **`bake()` de-indexes everything** (`if (g.index) g = g.toNonIndexed()`). Merged chunk meshes have 3 vertices per triangle (unit boxes go from 24 to 36 vertices; smooth cylinders and spheres grow 3–6×). The post-transform vertex cache cannot help, so vertex work is roughly doubled in all 5 passes, and memory and upload size grow too.
5. **Culling granularity is one chunk.** The merged static meshes, the window `InstancedMesh`es (`buildings-win.ts WindowBatch.build`, one per kind per chunk) and the tree batches all have chunk-sized bounding spheres (a 120 × 64 m block, with radius ≈ 70 m plus height). Frustum culling removes whole chunks or nothing.
6. **Nothing exploits street-canyon occlusion.** Manhattan blocks are lined with continuous street walls: buildings fill the frontage from `-LX` to `LX`, and `nyc.ts block()` adds a backyard core box. From the sidewalk, chunks that are not on the player's street or avenue corridor are almost entirely hidden.
7. **Pedestrians (COUNT = 110 in `people.ts`).** Each one has its own `SkinnedMesh` plus skeleton (Quaternius rig), plus hair, clothing and skirt meshes, and its own `AnimationMixer`. Animation is LODed (every 1st, 2nd or 4th frame) and so are shadows (`< 30 m`), which is good. But `scene.updateMatrixWorld()` still walks every bone of every pedestrian every frame, and `Skeleton.update()` re-uploads every visible bone texture every frame, even for pedestrians not animated that frame.
8. **Lights.** Interiors have up to 12 point lights plus 1 shadow-casting point light (`interior.ts`). That light's cube shadow re-renders the room 6× **every frame**, even though rooms are static. Museum rooms use 5–12 spot lights plus fill lights. In WebGL forward rendering, every light costs every lit fragment. A change in light count changes the program key, which forces a recompile of every material (a hitch on room or level change).
9. **Post-processing at DPR 2.** `setPixelRatio(min(dpr, 2))` with a 4x MSAA HalfFloat target, plus full-resolution GTAO (16 samples, plus a 16-sample Poisson denoise), plus bloom. On a 4K or Retina panel that is 4× the pixels of 1080p.
10. **Shaders.** `materials.ts enhance()` builds `MeshPhysicalMaterial`s with clearcoat, sheen and anisotropy, triplanar projection (3 projections) × texture bombing (2 lookups) × 3 maps, plus detail. That can reach ~20 texture fetches per fragment. Fine for hero props near the camera, expensive for a full screen of them.
11. **Streaming.** `ensure()` builds one whole chunk synchronously per frame (procedural geometry, canvas textures, `mergeGeometries`). That is a guaranteed hitch every time the player crosses a chunk boundary.
12. `renderer.info` is reset on every `renderer.render()` call (`info.autoReset = true` by default). With EffectComposer, `info.render.calls` therefore only shows the **last** pass (OutputPass or grade, with 1 call). Any count read today is meaningless (see §9).

---

## 1. Ranked recommendations

Columns: win (estimated), cost (engineer-days), risk.

| # | Recommendation | Win | Cost | Risk | Files |
|---|---|---|---|---|---|
| 1 | Measurement harness: per-pass counts, `info.autoReset = false`, headless count script | enables everything else | 1 d | none | `main.ts`, new `src/perf.ts`, new `scripts/perf.mjs` |
| 2 | Stop baking parked cars into static geometry (keep their LOD, or instance them) | −4…−8M tris (if §0.3 is confirmed) | 0.5 d | low | `nyc.ts street()`, `nyc/vehicles.ts` |
| 3 | GTAO: reuse the main pass depth (`setGBuffer(depthTexture)`), half resolution, fewer samples | −1 full scene pass (≈ −25–35% draws) | 1 d | low–med | `main.ts` |
| 4 | Keep `bake()` indexed (`mergeVertices` / indexed merge) | −40–60% vertex work in all passes | 0.5 d | low | `nyc/common.ts bake()`, `rooms/kit.ts flush()` |
| 5 | Chunk visibility by distance plus HLOD proxies for ring ≥ 2 | −50–70% city draws and tris | 3 d | med | `nyc.ts`, new `nyc/hlod.ts`, `nyc/buildings.ts` (footprint export) |
| 6 | Street-canyon occlusion (2.5D occlusion horizon) per chunk and per building | another −50–80% of what is left at street level | 3 d | med | new `nyc/occlusion.ts`, `nyc.ts` |
| 7 | Shadow budget: far cascade throttled, casters filtered by size and distance, static interior shadows | −30–50% shadow-pass draws | 1.5 d | low–med | `lighting.ts`, `interior.ts`, `nyc/*` castShadow flags |
| 8 | Time-sliced chunk build (generator with a ms budget), later a worker for geometry | removes hitches (frame time p99) | 2–4 d | med | `nyc.ts ensure()/block()`, `nyc/buildings*.ts` |
| 9 | Resolution: DPR cap 1.5 plus dynamic resolution, MSAA 4 → 2 at DPR > 1 | −30–55% fragment cost on hi-DPI | 0.5 d | low | `main.ts applyQuality()` |
| 10 | Pedestrians: bone-update LOD, far crowd as VAT `InstancedMesh` | −100–300 draws, −CPU ms | 3–5 d | med | `nyc/people.ts` |
| 11 | Shader cost: triplanar or anti-tile LOD by distance, physical features only where they show, `compileAsync` on level enter, fixed light-pool sizes | −GPU ms, no compile hitches | 2 d | low–med | `materials.ts`, `main.ts`, `museum/base.ts`, `interior.ts`, `lighting.ts` |
| 12 | BatchedMesh per chunk for buildings (per-building culling in one draw) | finer culling at no draw cost | 3 d | med (r170 BatchedMesh CPU cost) | `nyc/common.ts` (new `bakeBatched`), `nyc/buildings.ts` |
| 13 | Tree impostors (octahedral) beyond ~120 m, shadows from impostors | −tris, −shadow draws | 2–3 d | med | `nyc/streettrees.ts` |
| 14 | Interior and museum cell/portal culling | small to moderate (rooms are small) | 2 d | low | `interior.ts`, `rooms/kit.ts`, `museum/*` |
| 15 | KTX2 / Basis for the Poly Haven PBR sets and the big canvas atlases | −VRAM 4–8×, faster uploads | 2 d | med (asset pipeline, 60 MB budget) | `pbr.ts`, `textures.ts`, scripts |
| 16 | Baked lighting for static city geometry (vertex AO already exists; extend it to chunks) | lets GTAO go to half-res or off | 3+ d | med | `nyc/common.ts`, `nyc/buildings*.ts` |
| 17 | WebGPURenderer migration | not now (see §8) | 15+ d | high | everything |

Items 2, 3, 4 and 9 are each under a day and should come first. Together they are expected to more than halve the frame cost before any culling work starts.

---

## 2. Frustum culling granularity, bounding volumes, BVH

**Today:** one merged mesh per material bucket per chunk (`bake()`), one `InstancedMesh` per window part per chunk, and one `THREE.LOD` with tree batches per chunk. Bounding spheres are computed by `mergeGeometries`/`computeBoundingSphere` per mesh (that part is fine).

**Is the merge too coarse?** For the *main* pass at street level the frustum contains about half the resident chunks, so chunk-level culling is acceptable. It does not shrink the 5-pass multiplier, though. The CSM cascades are wide (the 3rd cascade covers ~260 m) and include almost everything. Finer granularity only pays off once it is combined with occlusion (§3) or when one draw call can cull per object (BatchedMesh, §4).

Recommendations:

- **Split the chunk bake by façade side, not by building.** Bucket key `material|castShadow|side` with side ∈ {N, S, E, W, core}. That is ×4–5 meshes per chunk, but each mesh's bounding box is a thin slab along one street, which is exactly the shape the occlusion test (§3) wants. Only do this together with §3, because on its own it adds draws. (`nyc/common.ts bake()` gets an optional `keyFn`. `buildings.ts` sets `userData.side` on parts. `BCtx` already knows `front: Side`.)
- **Use Box3 for chunk-level tests, not spheres.** Chunks are 120 × 64 m with towers up to ~200 m, so spheres are very loose. Keep a precomputed world `Box3` per chunk and per side-slab (`Chunk.bounds`). Do custom tests in `NycLevel.update()` and set `.visible` on the chunk's groups; three's internal per-mesh sphere test still runs afterwards.
- **three-mesh-bvh:** not needed for rendering. It accelerates raycasts and shapecasts against triangles. This project collides against 2D `Rect`s and aims at portal `Box3`s, so there is nothing to accelerate today. Use it only if mesh-accurate picking or camera collision against GLBs is added (`detail.ts`/`remote.ts` models). https://github.com/gkjohnson/three-mesh-bvh
- **Shadow-camera culling:** three culls casters per shadow camera (`WebGLShadowMap` uses the light camera frustum). Make sure dynamic objects that move have correct bounds. For skinned pedestrians, a fixed `boundingSphere` per pedestrian (radius ≈ 1.2 m) is cheaper and safer than the recomputed one.

---

## 3. Occlusion culling

### 3.1 Street-canyon occlusion with an occlusion horizon (recommended, CPU, no GPU readback)

The NYC grid is the textbook case for 2.5D urban occlusion. From a viewpoint at street level, the continuous street walls of the adjacent blocks hide everything except (a) the street and avenue corridors and (b) whatever rises above the street walls (towers).

- Downs, Möller, Séquin, *Occlusion Horizons for Driving through Urban Scenery* (I3D 2001): a 1D horizon (max occluder elevation per azimuth) is built front to back from the nearest blocks, and objects whose top lies below the horizon over their whole azimuth span are culled. https://dl.acm.org/doi/10.1145/364338.364374 (verify link)
- Wonka & Schmalstieg, *Occluder Shadows for Fast Walkthroughs of Urban Environments* (Eurographics 1999): same domain, using a 2.5D occluder shadow volume. Wonka, Wimmer & Schmalstieg, *Visibility Preprocessing with Occluder Fusion for Urban Walkthroughs* (EGWR 2000) is the PVS-precompute version. TU Wien publication pages: https://www.cg.tuwien.ac.at/research/publications/ (search the titles)

**Design for this code (`src/nyc/occlusion.ts`, new):**

1. At chunk build, every building records an **occluder** (its frontage rectangle, the street-wall height = top of the lowest continuous storey band, ignoring setbacks and roof stuff) and an **occludee** (its world AABB). `buildings.ts building()` already knows `r: Rect`, `floors` and floor height. Add `ctx.hulls.push({ rect, h, top })` to `BCtx`. The block core box (`2.5 m`) is not an occluder.
2. Each frame (or when the camera moves more than 0.5 m or turns more than 2°), rasterise the occluders of the ~12 nearest blocks into a horizon buffer of e.g. 720 azimuth bins (0.5°). Each bin holds `max(atan((h - eyeY) / dist))`, computed front to back. With 49 blocks × ~20 buildings this is well under 0.1 ms in JS.
3. Test each occludee (chunk side-slab, chunk HLOD, tree batch, street-level dynamic objects like cars and pedestrians via their chunk): if for **all** bins of its azimuth span, its top elevation is below the horizon, set `visible = false`. Conservative: use the AABB corner nearest the eye for the elevation and the full angular span.
4. When the eye is above the lowest street walls (balconies, stoops, roofs, the shrink-into transitions), the horizon flattens and the culler stops culling on its own. No special case is needed.
5. **Shadows:** a hidden building can still cast a visible shadow onto the street (sun 30° elevation, so a 150 m tower casts a 260 m shadow). Option A: occluded chunks keep only their **HLOD proxy** as a shadow caster (`material.colorWrite = false`, or put the proxy on a layer only the shadow cameras render). Option B: occlusion culling applies only to the main and GTAO passes, using `onBeforeRender`-free layer tricks. A is simpler and also reduces shadow cost (see §6).

Expected: at street level, visible chunks drop from ~25–49 to ~8–14 (your block, the corridor along your street, the corridor along your avenue, and towers above the walls). Street-level props, cars, trees and pedestrians in hidden chunks are all culled.

### 3.2 PVS precompute per chunk

Because the city is procedural, seed-stable, and has an exact grid, a **conservative from-region PVS can be computed analytically per chunk cell**. For a viewer at street level anywhere inside chunk (cx, cz), the potentially visible set is {chunks in row cz ± 1} ∪ {chunks in column cx ± 1} ∪ {chunks whose tallest building exceeds the occluder horizon from the cell}. This is a good fallback or first step: a few lines in `nyc.ts`, no per-frame work, but much less precise than 3.1 at corridor crossings. Implement it as the coarse pass and let 3.1 refine it.

### 3.3 GPU occlusion queries (WebGL2)

- WebGL2 has core occlusion queries: `gl.createQuery()`, `gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, q)`. No extension is needed. (Note: `EXT_disjoint_timer_query_webgl2` is the *timer* extension, not occlusion.) Results arrive asynchronously, 1–3 frames later. Polling with `getQueryParameter(q, QUERY_RESULT_AVAILABLE)` must not block.
- three's WebGLRenderer has **no built-in support**. You would issue the queries yourself via `renderer.getContext()` and draw proxy boxes with depth test on and color/depth write off after the depth of the occluders is laid down. That conflicts with EffectComposer's MSAA target, so `renderer.setRenderTarget(composer.readBuffer)` has to be managed. The npm package `threejs-occlusion-query` exists but is unmaintained (https://npmjs.com/package/threejs-occlusion-query).
- Latency causes popping when you turn a corner, which happens constantly in a street grid. The usual mitigation is "visible last frame → draw" plus temporal coherence (Bittner et al., *CHC++*, 2008: https://www.cg.tuwien.ac.at/research/publications/2008/mattausch-2008-CHC/).
- **Verdict:** not worth it here. The analytic horizon (3.1) is exact for this geometry, costs nothing on the GPU, and has no latency. Reconsider only for interiors with arbitrary GLB clutter, where queries would also be cheaper to manage.
- WebGPURenderer has occlusion queries (`object.occlusionTest = true`, `renderer.isOccluded(object)`, example `webgpu_occlusion`, PR https://github.com/mrdoob/three.js/pull/26335). This is not a reason to migrate on its own.

### 3.4 Hierarchical-Z

Build a depth mip pyramid from the previous frame's depth (or from a low-res depth prepass of large occluders) and test bounding boxes against it. Reference: Rákos, *Hierarchical-Z map based occlusion culling* (https://rastergrid.com/blog/2010/10/hierarchical-z-map-based-occlusion-culling/) and Haar & Aaltonen, *GPU-Driven Rendering Pipelines* (SIGGRAPH 2015, https://advances.realtimerendering.com/s2015/aaltonenhaar_siggraph2015_combined_final_footer_220dpi.pdf). In WebGL2 the test would have to run in a fragment shader with the results read back to the CPU (`readPixels` stalls or needs a PBO plus fence, `gl.fenceSync`), because there is no indirect draw. Doable, but it is a research project, and 3.1 covers the city case better. **Skip** in WebGL; it becomes natural with WebGPU compute (§8).

### 3.5 Interiors and museum: cells and portals

`interior.ts` already has the structure: BSP leaves are rooms and `Split.door` openings are portals. The classic method is Luebke & Georges, *Portals and Mirrors* (I3D 1995, https://dl.acm.org/doi/10.1145/199404.199422). From the camera's room, project each door rectangle to the screen, intersect it with the current screen rectangle, recurse into the neighbouring room, and mark the reached rooms visible.

- **Precondition:** `rooms/kit.ts Kit` merges the whole floor by material, so there is nothing to hide per room. `Kit.flush` has to bin by `material × roomId`. That is ×(rooms ≈ 5–12) meshes, so it only pays when portal culling removes most rooms. With 3–6 rooms visible on average it is roughly neutral on draws and a win on triangles and fragments.
- **The bigger interior win is lights, not geometry** (§6, §7): only the lights in the rooms reached through portals need to be on. Keep the pool size fixed and move or dim lights rather than adding or removing them, so the program does not recompile.
- Museum galleries (`museum/gallery.ts`) are one room per level. Portal culling only matters in the atrium (`museum/atrium.ts`, six wings). Low priority.

---

## 4. Draw-call reduction: BatchedMesh, InstancedMesh, merging, atlases

- **BatchedMesh (r159+, multi-draw via `WEBGL_multi_draw`).** One draw call for many geometries with one material, per-object visibility and matrices, and (since r166-ish) per-object frustum culling (`perObjectFrustumCulled`, `sortObjects`). Docs: https://threejs.org/docs/#api/en/objects/BatchedMesh. Codrops intro: https://tympanus.net/codrops/2024/10/30/interactive-3d-with-three-js-batchedmesh-and-webgpurenderer/
  - Caveats in r170: the per-object culling and sorting run on the CPU every frame, for every camera, including **every shadow camera** (3 CSM cascades). Users report CPU-bound slowdowns with thousands of objects (https://discourse.threejs.org/t/significant-performance-drop-and-high-cpu-usage-with-batchedmesh/67324). Culling was sped up in https://github.com/mrdoob/three.js/pull/27219. If `WEBGL_multi_draw` is missing, it falls back to one draw per object. It is supported on desktop Chrome, Edge and Firefox (check web3dsurvey).
  - Where it fits here: **buildings within a chunk** (~20–40 per chunk, one BatchedMesh per material bucket). Per-building occlusion (§3.1) then becomes `setVisibleAt(id, false)` with no extra draws. It is also a candidate for all cars (both LODs as separate geometries, toggled per car) to replace 26 traffic cars × ~6–10 meshes × LOD.
  - Vertex colours are fine (geometry attribute). Per-object colour is `setColorAt` (r166+).
  - Turn `sortObjects = false` for opaque city batches. Sorting helps overdraw but costs CPU, and the city's depth complexity at street level is low once occlusion works.
- **InstancedMesh** (already used for windows, trees, light pools, shop products):
  - Windows: one InstancedMesh per kind per chunk with a chunk-wide bound. Fine. Combined with §3, split into N/S/E/W instance sets per chunk (4× draws, culled as slabs) only if counts show windows dominate.
  - Library option: InstancedMesh2 (`@three.ez/instanced-mesh`, https://github.com/agargaro/instanced-mesh) adds per-instance frustum culling with a BVH, per-instance LOD and shadow LOD. A good fit for trees and parked cars across chunks: one global instanced set per model per LOD instead of per-chunk batches.
- **Merging by material (what `bake()` does).** Keep it, but keep the index (§0.4) and add the `side` key (§2). `vcMat(rough, metal)` quantises plain materials into a few shared vertex-colour materials, which is already good.
- **Atlases and array textures.** The remaining split reasons in `bake()` are per-material textures: facade PBR sets (`surface('nyc_brick'...)`), sign atlases, glass. A `DataArrayTexture` / `CompressedArrayTexture` (WebGL2) holding all facade sets as layers, with the layer index in a vertex attribute, collapses every facade bucket in a chunk into one draw. That needs a shader hook in `pbr.ts surface()` and the same resolution for every layer. Est. −5–15 draws per chunk; worth it only after HLOD and occlusion. three example: https://threejs.org/examples/#webgl2_materials_texture2darray

---

## 5. LOD, impostors, HLOD

- **THREE.LOD** works but traverses and switches per object on the CPU. It is fine for cars (26 traffic plus parked) and trees (one LOD per chunk). Make sure parked cars are actually LODed (§0.3).
- **HLOD per chunk (recommended).** At chunk build, after `building()` calls, emit a proxy mesh per chunk: each building as a box or extruded footprint (plus a setback tier for towers). The facade comes from a *procedural window-grid shader* (floor height, bay width, sill colour, lit-window hash at night from `setNight`) or from a tiny per-chunk facade atlas rendered once. ~12–40 tris per building means ~1k tris and **1–2 draws per chunk**, which can cast shadows cheaply.
  - Ring 0–1 (≤ ~120 m): full detail plus `fine` group. Ring 2: full shell, no `fine`, no street props, windows as HLOD shader. Ring 3: HLOD only.
  - The HLOD is also the shadow caster for distant or occluded chunks (§3.1, §6).
  - Store HLOD proxies of all resident chunks in **one BatchedMesh** owned by `NycLevel` (one draw for the whole skyline).
- **Impostors and billboards.**
  - Trees: octahedral impostors (Ryan Brucks, https://shaderbits.com/blog/octahedral-impostors). three implementation: https://github.com/agargaro/octahedral-impostor (forum: https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735). Three species × a few variants, baked once at startup into a 2048² atlas (albedo plus normal), drawn as an InstancedMesh of quads beyond ~120 m. That replaces the `lo` model (`streettrees.ts TREE_LOD_DIST = 95`). Hemi-octahedron is enough (no views from below).
  - Distant buildings: plain box HLODs with a window shader beat impostors here, because buildings are boxes. Use impostors only for unusual rooftop items (water towers in `buildings.ts`), and drop them at distance instead.
  - Cars beyond ~80 m: drop to LOD1 (already) and then to a box stand-in (`vehicles.ts standin()` exists). Shadows off beyond ~40 m.
- **Mesh simplification for GLBs:** `meshoptimizer` (0.18 in node_modules, 0.22 via gltf-transform) includes `MeshoptSimplifier`. Use `gltf-transform simplify` offline to generate LOD1/LOD2 for heavy rebuilt or remote GLBs in museum and shops (`remote.ts`), or at load time in a worker. https://github.com/zeux/meshoptimizer, https://gltf-transform.dev/cli

---

## 6. Shader, post-processing and shadow cost

### 6.1 Post-processing (`main.ts`)

- **GTAO without the extra scene pass.** `GTAOPass.setGBuffer(depthTexture)` with no normal texture makes it reconstruct normals from depth (`NORMAL_VECTOR_TYPE 0`) and skip its own scene render (`_renderGBuffer = false`). Give the composer's render target a `DepthTexture` (`rt.depthTexture = new THREE.DepthTexture()`; the MSAA depth is resolved on `samples > 0` targets in r170) and pass it in. Verify that EffectComposer's cloned `renderTarget2` handles the depth texture correctly (RenderPass writes into `readBuffer`), and check the ping-pong order. This also removes the sprite/glass hide hack in `main.ts` and the window-anchor mismatch (§0.1). Win: one whole scene pass.
- **Half-res AO:** `gtao.setSize(w/2, h/2)` (or render AO into a half-size target and upsample). GTAO at 16 samples plus a 16-sample denoise at full res DPR 2 is several ms. Try `samples: 8`, denoise `samples: 8`. Alternative: N8AO (https://github.com/N8python/n8ao), which has `halfRes`, depth-only input and depth-aware upsampling and is widely used with three.
- **Bloom:** UnrealBloomPass already downsamples into 5 mips. Its first high-pass runs at full resolution, so set the bloom pass to half size (`bloom.setSize(w/2, h/2)` after `composer.setSize`).
- **DPR and MSAA:** cap DPR at 1.5 on ultra and 1 on high. Add dynamic resolution (scale DPR 0.75–1.5 from the measured frame time, with hysteresis). With DPR > 1, MSAA `samples: 2` is visually indistinguishable from 4.
- **Pass merging:** the grade pass (`lighting.grade`) and OutputPass can be one ShaderPass (tone map plus grade plus vignette): one full-screen pass less.

### 6.2 Materials (`materials.ts`, `pbr.ts`, `buildings-win.ts`)

- Physical features cost per fragment: clearcoat adds a second specular lobe, sheen an extra BRDF plus LUT, anisotropy extra ALU, and transmission an **extra opaque render to a transmission target** (three renders the opaque scene again for any visible transmissive object). Check `glassFrom()` (`transmission: 1`): **any** visible transmissive mesh triggers a full extra scene render at DPR resolution (`WebGLRenderer.renderTransmissionPass`). Use transmission only for hero glass close to the camera. Elsewhere use plain transparent `MeshPhysicalMaterial` with `transmission = 0` (or the `roomMaterial` fake). This may be a hidden full scene pass in museum and shops: count it with §9.
- Triplanar plus bombing: 3 projections × 2 bombing taps × (albedo, ARM, normal) plus detail can reach ~20 fetches. Mitigations:
  1. With `TRI_UV` (rebuilt GLBs with metric UVs), skip triplanar entirely (already partly done; make sure the bombing is off too unless `antiTile`).
  2. Fade the bombing (`TRI_ANTITILE`) to a single tap beyond ~8 m. A `branch on uniform/varying` is cheap on desktop, and the `textureGrad` taps are the expensive part.
  3. Pick the dominant axis only when one weight > 0.9 (most fragments on axis-aligned furniture), so that is 1 projection instead of 3.
- `customProgramCacheKey = () => 'tri3'` is fine (defines are part of the key), but the number of `KINDS` × define combinations × light configurations is the program count. Log `renderer.info.programs.length` per level.
- **Precompile:** `await renderer.compileAsync(scene, camera)` (r158+, uses `KHR_parallel_shader_compile`) during the fade in `main.ts enter()/goBack()/setLevel()`, after the new level is built and before the fade-in. https://threejs.org/docs/#api/en/renderers/WebGLRenderer.compileAsync. Also compile CSM shadow and depth variants by rendering one frame into a 1×1 target with shadows on. Keep **light counts per place fixed**: a museum room with 5 spots and one with 12 have different programs. Use a fixed pool (e.g. 12 spots in every gallery, unused ones at intensity 0 and pointing at the floor) so programs are shared across rooms.

### 6.3 Shadows (`lighting.ts`, `interior.ts`)

- **CSM:** 3 cascades × 2048² (ultra). Ideas, ordered by win/cost:
  1. **Throttle the far cascade:** `csm.lights[2].shadow.autoUpdate = false` and set `needsUpdate = true` every 3rd frame (or when the camera moves > 2 m). WebGLShadowMap only calls `updateMatrices` when it re-renders, so the stale map stays consistent with its own matrix. Win: −2/3 of cascade-3 draws. (Verify there is no shimmer. CSM snaps texels? Check `CSMFrustum`; if it does not snap, add texel snapping.)
  2. **Caster filtering:** small stuff should not cast in cascades 2–3: the `fine` group, street props, pedestrians beyond 30 m (done), parked cars beyond ~40 m, tree LOD `lo`. The tools are `castShadow` per mesh (bake buckets already split by castShadow), and for HLOD chunks, cast only the HLOD proxy.
  3. **`maxFar` 260 → 180 m** on high, with HLOD proxies casting beyond that as a static "far shadow" (option 4).
  4. **Static far shadow for the city:** one extra 2048² directional shadow over a ~600 m area, rendered only when the sun direction changes (`setTime`) or the player moves > 100 m, with only HLOD proxies as casters. CSM handles the near 0–150 m. three does not combine these out of the box: you need a second `DirectionalLight` with `shadow.autoUpdate = false` lighting nothing (intensity 0 does not work, because shadows multiply light) or a custom shadow lookup in the facade shader. Medium cost; do it only if counts show cascades dominate.
- **Interiors:** the one shadow-casting `PointLight` (`interior.ts`, 512² cube = 6 scene renders per frame). Rooms are static, so set `sl.shadow.autoUpdate = false` and `sl.shadow.needsUpdate = true` when it moves to another room (in `InteriorLevel.update()`). Win: −6 interior scene passes per frame. If pedestrians or animated objects exist indoors, re-render every 4th frame.
- **Street lamps at night:** 8 spot lights (`LAMP_POOL`) on ultra, all evaluated in every lit fragment. Fine because the count is fixed. Do not make it variable.

---

## 7. Prebaking

- **Baked AO for the city:** `bake()` already supports a per-vertex AO multiplier (`userData.ao`). Extend it to facades and street meshes with an analytic AO, which costs nothing at runtime: darken the bottoms of walls near the sidewalk, inside window reveals (already geometry), under cornices and in courtyards, from height and normal, at build time. Combined with GTAO at half-res, that hides the half-res artefacts. True lightmaps (UV2 plus a path-traced bake) are not practical for procedural, streamed chunks. Generating per-chunk lightmaps on the fly (render-to-texture AO in a worker or on the GPU) is possible but costly; skip it.
- **Baked shadows:** at street level the dominant shadows are building-on-street and building-on-building. With a fixed time of day per session, they could be baked into the road and sidewalk texture of each chunk (render the HLODs from the sun into a 512² per-chunk "shadow mask" once when the chunk loads or the sun changes). That lets CSM drop buildings beyond ~60 m. Medium cost; later.
- **Vertex AO for GLBs:** `materials.ts` already supports `TRI_BAKE` from `scripts/rebuild.py --bake`. Make sure every museum and shop GLB gets it, which allows GTAO to be off indoors on `high`.
- **KTX2 / Basis:** `detail.ts` already wires `KTX2Loader`. The big VRAM users are the Poly Haven PBR sets streamed as JPG/PNG (`pbr.ts`, 1k/2k: a 2048² RGBA8 with mips is ~22 MB in VRAM; ×3 maps × ~10 sets ≈ 0.6 GB). Convert them offline to KTX2 (UASTC for normals and ARM, ETC1S for albedo) with `toktx` / `gltf-transform uastc|etc1s`. Commit them under `public/assets/pbr/` within the 60 MB budget (ETC1S 2k ≈ 0.5–1.5 MB each), keeping the CDN fallback. https://github.com/KhronosGroup/KTX-Software, https://gltf-transform.dev/cli. Canvas-generated atlases (signs, facades, `textures.ts`) cannot be Basis-compressed at runtime cheaply. Keep them small and shared.
- **Meshopt:** keep using `gltf-transform optimize --compress meshopt` (AGENTS.md). Add `--simplify` LODs for the heavy fleet near LOD (30–75k tris is a lot for a car seen at 10–26 m; 15–25k is usually indistinguishable).

---

## 8. Skinned meshes (pedestrians, `nyc/people.ts`)

- **Costs today:** per pedestrian: `AnimationMixer.update`, a skeleton with ~60–70 bones, `updateMatrixWorld` on all bones every frame, a bone texture upload every frame (`Skeleton.update()` when rendered), and 3–6 draw calls (body, LOD body, hair, coat skirt, phone) × passes (main, GTAO normal, shadows when < 30 m). 110 pedestrians ≈ 300–600 draw calls across passes, plus a lot of CPU.
- **Cheap fixes (1 d):**
  - For pedestrians not updated this frame (`every = 2/4`), skip the bone matrix work. Set `model.matrixWorldAutoUpdate = false` and call `updateMatrixWorld(true)` only on the frames where the mixer ran. three's skinning reads `bone.matrixWorld` via `skeleton.update()`, so stale bones mean a stale pose, which is the intended effect.
  - Cull animation for off-screen pedestrians: skip `mixer.update` when the pedestrian's bounding sphere is outside the frustum or occluded (§3), and accumulate `acc`.
  - Merge hair, clothing and body into one skinned geometry per outfit at spawn when they share a skeleton (`mergeGeometries` keeps `skinIndex`/`skinWeight`). That turns 3–5 draws into 1–2.
  - Clamp `COUNT` per quality (`ultra 110`, `high 70`, `low 40`).
- **Vertex animation textures (VAT) for the far crowd (3–5 d):** bake the walk, idle and phone clips of each base body (2 genders) into a float texture (per frame × bone matrices, or per frame × vertex positions; bone-matrix VAT is much smaller: ~65 bones × 4 texels × ~60 frames). Draw all pedestrians beyond ~25 m as **one InstancedMesh per gender** with per-instance clip, phase, outfit colours (instanced attributes; the clothing painter shader already works from bind-pose position) and LOD body geometry. Near pedestrians stay real SkinnedMeshes, so the swap is at the existing `setLod` boundary. References: Babylon baked texture animations (https://doc.babylonjs.com/features/featuresDeepDive/animation/baked_texture_animations), the three.js forum thread on instanced skinned meshes (https://discourse.threejs.org/t/animated-instanced-skinned-meshes-gltf/41958), the PlayCanvas VAT PR (https://github.com/playcanvas/engine/pull/9123). Win: far crowd goes from ~70 × 3 draws to 2 draws, and most mixer CPU disappears.
- GPU skinning limits: three uses a bone **texture** (no uniform limit). Cost is per vertex × 4 influences, which is fine. The limit is CPU-side bone updates, not GPU.

---

## 9. Streaming and hitches (`nyc.ts`)

- **Time-sliced build:** turn `block()` into a generator that yields after each building or street run. `NycLevel.update()` drives it with a budget (`performance.now()` deadline ≈ 4 ms per frame) and only `ensure`s a chunk once the generator finishes (until then the chunk stays invisible or shows its HLOD). Canvas texture generation (`canvasTex`) and `mergeGeometries` are the heavy parts. Cache canvas textures across chunks by content key (many already are).
- **Prefetch direction:** build ring 2 in the direction of travel first (velocity-weighted ring order).
- **Workers:** the building generator is pure maths plus `THREE.BufferGeometry` construction. A worker can produce position/normal/uv/color/index `Float32Array`s and transfer them (zero-copy) for the main thread to wrap in `BufferGeometry`. The obstacles are canvas textures (OffscreenCanvas in the worker works for 2D canvas in Chrome and Firefox) and shared material identity (send material keys, not materials). Est. 3–5 d. Do it after time slicing, and only if p99 frame time is still bad.
- **OffscreenCanvas rendering in a worker:** not recommended. The HUD, pointer lock, input and portal UI live on the main thread and the GPU cost is the bottleneck, not main-thread JS.
- **GC and disposal:** `disposeTree(ch.group)` on unload frees GPU buffers. Make sure that (a) shared materials (`vcMat`, `surface()`, `windowMats`) are **not** disposed (`userData.owned` is the convention), and (b) unload is also time-sliced (deleting 40 buffers per frame is fine; deleting a chunk with hundreds is not). Avoid per-frame allocations in hot loops: `k.split(',').map(Number)` runs twice per chunk per frame in `NycLevel.update()`. Store `cx, cz` on the `Chunk`.
- **Upload:** `renderer.initTexture(tex)` and `renderer.compileAsync` for a new chunk's new materials before making it visible spread the GL uploads.

---

## 10. Measurement

- **Per-frame totals with EffectComposer:** `renderer.info.autoReset = false`, then call `renderer.info.reset()` at the start of `frame()`. Log `info.render.calls`, `triangles`, `points`, `lines` and `info.memory.geometries/textures` and `info.programs.length`. For **per pass**, wrap `renderPass.render`, `gtao.render`, `bloom.render` and the shadow map (`renderer.shadowMap.render` is called inside `render()`, so diff `info` around the main render with `shadowMap.autoUpdate` toggled on a probe frame) and record deltas.
- Expose `window.__world.perf()` returning `{calls, tris, perPass, programs, geometries, textures, chunksVisible, pedsAnimated}` (AGENTS.md already exposes `window.__world`).
- **Overlay:** stats-gl (https://github.com/RenaudRohlinger/stats-gl) shows CPU and GPU ms per frame using `EXT_disjoint_timer_query_webgl2` where available (about 81% of Chrome, near 0 in Safari and Firefox: https://web3dsurvey.com/webgl2/extensions/EXT_disjoint_timer_query_webgl2). Load it only behind `?perf=1`. Do not add a dependency for the default build; a dynamic import is fine. Alternative: three's `GPUStatsPanel` in `examples/jsm/utils/GPUStatsPanel.js` (forum thread: https://discourse.threejs.org/t/how-to-test-shader-performance/24887).
- **GPU timer queries per pass** (desktop Chrome on a real GPU only): `ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')`, `gl.beginQuery(ext.TIME_ELAPSED_EXT, q)` around each composer pass, read 2–3 frames later and discard when `GPU_DISJOINT_EXT` is set.
- **Spector.js** (https://spector.babylonjs.com/) for a frame capture: lists every draw call, its program, state and render target. Ideal for confirming §0.1 (5 passes) and §0.3 (car triangles).
- **Headless Chromium (this machine):** SwiftShader rendering is CPU-bound and very slow, and the machine is saturated by other agents. **Never measure frame time headless.** Measure **counts**, which are deterministic: draw calls and triangles per pass, programs, geometry and texture counts, visible chunk count, from a fixed seed and fixed camera poses. A `scripts/perf.mjs` (based on `scripts/shot.mjs`) would:
  1. open `/?quality=ultra&cam=...&look=...` at 640×360, `--eval` a wait for chunks to be built (`__world.level.chunks.size === 49`),
  2. render one frame and dump `__world.perf()` as JSON,
  3. repeat for ~5 poses: mid-block sidewalk, avenue intersection, looking down a long avenue, a stoop or roof, inside an interior, a museum gallery,
  4. compare against a committed baseline (`docs/research/perf-baseline.json`) and print the diffs.
  Each work package records the before/after JSON in its commit message.
- Real-GPU spot checks: when a human runs it, `?perf=1` with stats-gl on a desktop GPU with Chrome's `--enable-gpu-benchmarking`, or just the DevTools Performance panel with "GPU" enabled.

---

## 11. WebGPURenderer in r170: migrate?

- r170 ships `WebGPURenderer` (with a WebGL2 fallback backend), TSL node materials, compute shaders, `PostProcessing` with node passes (GTAO, bloom available as nodes), occlusion queries, and `BatchedMesh` support. Indirect drawing and GPU-driven culling (`IndirectStorageBufferAttribute` / geometry indirect) landed around r170–r172 and were still moving. Discussion: https://github.com/mrdoob/three.js/issues/28389. A GPU-driven culling demo outside three: https://github.com/toji/webgpu-bundle-culling. Indirect draw best practices: https://toji.dev/webgpu-best-practices/indirect-draws
- **Cost for this repo:** every `onBeforeCompile` shader has to be rewritten in TSL: window anchors and the procedural room shader (`buildings-win.ts`), triplanar, bombing and wear (`materials.ts`), tree wind (`streettrees.ts`), clothing painting (`people.ts`), CSM material hooks (`lighting.ts setupCsmMaterials`, replaced by `CSMShadowNode`), signs and neon (`buildings-shop.ts`). EffectComposer passes and the grade go to `PostProcessing`. That is 15+ engineer-days with high regression risk, and in r170 the WebGPU path was often *slower* on CPU-bound scenes than WebGL2.
- **Verdict:** **do not migrate now.** Everything in work packages 1–6 (HLOD, horizon occlusion, BatchedMesh, VAT, shadow throttling) carries over unchanged to WebGPU later. Re-evaluate once the scene is under budget, when GPU compute culling or HZB would be the next step and three's WebGPU path has stabilised (r180+).

---

## 12. Implementation plan: parallel work packages

Packages are independent, and file ownership does not overlap except for the noted one-line touches. Each package starts by running the WP1 count script (or, until it lands, by setting `renderer.info.autoReset = false` locally) and commits small steps with before/after counts.

### WP1: Measurement and frame pipeline
**Owns:** `src/main.ts`, new `src/perf.ts`, new `scripts/perf.mjs`, `docs/research/perf-baseline.json`.
1. `info.autoReset = false`, per-pass counters, `window.__world.perf()`, `?perf=1` stats-gl overlay (dynamic import).
2. `scripts/perf.mjs` fixed-pose count dump plus baseline.
3. GTAO: `setGBuffer(depthTexture)` from the composer target (removes the normal scene pass and the hide hack), half-res, 8 + 8 samples.
4. Bloom at half size. Merge grade and OutputPass if simple.
5. DPR cap (ultra 1.5) plus dynamic resolution. MSAA 2 at DPR > 1.
6. `renderer.compileAsync(scene, camera)` during `enter()/goBack()` fades.
Win: −1 scene pass, −30–50% fragment cost. Risk: low.

### WP2: City chunk pipeline, visibility and occlusion
**Owns:** `src/nyc.ts`, new `src/nyc/occlusion.ts`, new `src/nyc/hlod.ts`.
1. **P0:** parked cars go to `group` (not `stat`) so their `THREE.LOD` survives and they are not double-baked. Verify with counts. (One-line call-site change. Later instancing belongs to WP4.)
2. Hide ring-3 hysteresis chunks (`visible = false`, keep them resident). Store `cx, cz` on `Chunk` (no `split` per frame).
3. Analytic per-chunk PVS (§3.2), then the 2.5D occlusion horizon (§3.1) on chunk side-slabs, HLODs and per-chunk dynamic objects.
4. HLOD proxies per chunk from `ctx.hulls` (provided by WP3). One BatchedMesh for all HLODs. Ring 2: shells plus HLOD windows; ring 3: HLOD only. HLODs as shadow casters for hidden or far chunks.
5. Time-sliced `block()` generator with a 4 ms budget, travel-direction ring order, time-sliced unload.
Win: −50–80% city draws and tris; no chunk hitches. Risk: medium (popping; make the culler conservative).

### WP3: Static city geometry and baking
**Owns:** `src/nyc/common.ts` (`bake()` and helpers), `src/nyc/buildings.ts`, `src/nyc/buildings-win.ts`, `src/nyc/buildings-shop.ts`, `src/nyc/streetprops.ts`.
1. Indexed `bake()` (drop `toNonIndexed`; non-indexed inputs get a generated index; `mergeGeometries` needs all-indexed). Same in `rooms/kit.ts` only if WP6 agrees (WP6 owns that file).
2. Export `ctx.hulls: {rect, h, top, side}[]` from `building()` (the contract WP2 consumes; land this first, it is tiny).
3. Optional `side` bake key (N/S/E/W/core) and per-side window InstancedMeshes, used by WP2's occlusion.
4. Caster hygiene: `fine` group, street props and signs `castShadow = false` (or only in cascade 0 via distance). Analytic vertex AO for facades and sidewalks (§7).
5. Later: BatchedMesh variant `bakeBatched()` for per-building culling (§4), and an array-texture facade material to merge facade buckets.
Win: −40–60% vertex work, fewer shadow draws. Risk: low.

### WP4: Moving and repeated actors: pedestrians, cars, trees
**Owns:** `src/nyc/people.ts`, `src/nyc/vehicles.ts`, `src/nyc/vehicleFleet.ts`, `src/nyc/vehicleBus.ts`, `src/nyc/streettrees.ts`.
1. Pedestrians: `matrixWorldAutoUpdate` LOD, skip the mixer when off-screen, merge per-pedestrian meshes, `COUNT` per quality, fixed bounding spheres.
2. VAT far crowd: one InstancedMesh per gender beyond 25 m.
3. Cars: shadows off beyond 40 m, LOD2 = stand-in box beyond ~90 m, simplified near LOD (gltf-transform simplify, target ≤ 25k tris). Optionally, parked cars as a per-model InstancedMesh or BatchedMesh API (`parkedCars(group)`), which WP2 then calls.
4. Trees: octahedral impostors beyond ~120 m, `lo` model shadows off in cascades 2–3.
Win: −300–600 draws across passes, −CPU ms. Risk: medium (visual parity of VAT).

### WP5: Lighting, shadows and materials
**Owns:** `src/lighting.ts`, `src/materials.ts`, `src/pbr.ts`, `src/textures.ts`, `src/remote.ts`.
1. CSM: throttle the far cascade (`autoUpdate = false`, refresh every 3rd frame or on movement), texel snapping if needed, `maxFar` per quality.
2. Triplanar LOD: dominant-axis fast path, single-tap bombing beyond ~8 m, no triplanar with `TRI_UV`. Transmission only on hero glass (`glassFrom()` gets a `cheap` mode used by `remote.ts` for small or far glass).
3. Optional static far-shadow light for HLOD casters (coordinate with WP2).
4. KTX2 pipeline for the PBR sets (script plus `pbr.ts` loader path, CDN fallback).
Win: −shadow draws, −GPU ms, −VRAM. Risk: medium (shadow artefacts).

### WP6: Interiors, shops and museum
**Owns:** `src/interior.ts`, `src/rooms/*`, `src/shop.ts`, `src/shopkit/*`, `src/museum/*`.
1. Interior shadow point light: static shadow (`shadow.autoUpdate = false`, `needsUpdate` on room change).
2. Fixed light pools per place type (interior 12 points, gallery N spots) so programs are shared and there is no compile hitch between rooms. Lights outside the portal-reachable rooms at intensity 0 or moved, never removed.
3. Per-room Kit bins plus cell/portal culling through `Split.door` openings (§3.5). Atrium wings in `museum/atrium.ts`.
4. Generate LODs for heavy GLB exhibits and products (gltf-transform simplify offline) and make sure `TRI_BAKE` vertex AO is everywhere, so GTAO can be lower indoors.
Win: −6 shadow passes per frame indoors, no room-change hitches. Risk: low.

**Suggested order:** WP1 steps 1–2 and WP2 step 1 (parked cars) first, since they are hours each and fix the measurement plus the probable biggest triangle sink. Then all six packages run in parallel. The only data contract is WP3 step 2 (`ctx.hulls`) → WP2 step 4. The rest is independent.

---

## Sources

- three.js BatchedMesh docs: https://threejs.org/docs/#api/en/objects/BatchedMesh, culling PR https://github.com/mrdoob/three.js/pull/27219, CPU-cost report https://discourse.threejs.org/t/significant-performance-drop-and-high-cpu-usage-with-batchedmesh/67324, Codrops https://tympanus.net/codrops/2024/10/30/interactive-3d-with-three-js-batchedmesh-and-webgpurenderer/
- WebGPU occlusion queries in three.js: https://github.com/mrdoob/three.js/pull/26335, forum https://discourse.threejs.org/t/renderer-isoccluded-returns-null-is-my-setup-correct/88356
- GPU-driven culling and indirect draws: https://github.com/mrdoob/three.js/issues/28389, https://github.com/toji/webgpu-bundle-culling, https://toji.dev/webgpu-best-practices/indirect-draws
- Haar & Aaltonen, GPU-Driven Rendering Pipelines (SIGGRAPH 2015): https://advances.realtimerendering.com/s2015/aaltonenhaar_siggraph2015_combined_final_footer_220dpi.pdf
- Rákos, Hierarchical-Z occlusion culling: https://rastergrid.com/blog/2010/10/hierarchical-z-map-based-occlusion-culling/
- Urban occlusion: Downs, Möller, Séquin, Occlusion Horizons for Driving through Urban Scenery (I3D 2001); Wonka & Schmalstieg, Occluder Shadows for Fast Walkthroughs of Urban Environments (EG 1999); Wonka, Wimmer, Schmalstieg, Visibility Preprocessing with Occluder Fusion for Urban Walkthroughs (EGWR 2000). Citations from memory; verify before quoting.
- Luebke & Georges, Portals and Mirrors (I3D 1995). CHC++ (Mattausch, Bittner, Wimmer 2008).
- Octahedral impostors: https://shaderbits.com/blog/octahedral-impostors, https://github.com/agargaro/octahedral-impostor, https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735, https://discourse.threejs.org/t/octahedral-impostors-for-three-js/80318
- InstancedMesh2: https://github.com/agargaro/instanced-mesh
- three-mesh-bvh: https://github.com/gkjohnson/three-mesh-bvh
- VAT: https://doc.babylonjs.com/features/featuresDeepDive/animation/baked_texture_animations, https://github.com/playcanvas/engine/pull/9123, https://discourse.threejs.org/t/animated-instanced-skinned-meshes-gltf/41958
- Measurement: stats-gl https://github.com/RenaudRohlinger/stats-gl, Spector.js https://spector.babylonjs.com/, timer query support https://web3dsurvey.com/webgl2/extensions/EXT_disjoint_timer_query_webgl2, MDN https://developer.mozilla.org/en-US/docs/Web/API/EXT_disjoint_timer_query, three forum https://discourse.threejs.org/t/how-to-test-shader-performance/24887
- `WebGLRenderer.compileAsync`: https://threejs.org/docs/#api/en/renderers/WebGLRenderer.compileAsync
- N8AO: https://github.com/N8python/n8ao
- Compression: https://github.com/zeux/meshoptimizer, https://gltf-transform.dev/cli, https://github.com/KhronosGroup/KTX-Software
- WebGL2 occlusion-query helper (unmaintained): https://npmjs.com/package/threejs-occlusion-query
