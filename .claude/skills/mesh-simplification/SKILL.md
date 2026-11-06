---
name: mesh-simplification
description: Detail-preserving polygon reduction and LOD chains for this three.js world (meshoptimizer 1.3 attribute-aware simplification, shared-error budgets, crease-normal rebuild, twin-triangle cleanup, normal-map baking in Blender, screen-space-error LOD switching, cheap Node verification). Use before simplifying any GLB, building vehicle/prop/scan LODs, adding runtime LODs to heavy streamed models, or judging whether a LOD lost visible detail.
---

# Mesh simplification that keeps the detail

DRAFT — being filled in as the work lands; numbers below are measured in this repo.

## Tools in the repo

| What | Where |
|---|---|
| meshoptimizer 1.3 simplifier (vendored, MIT; npm `meshoptimizer` here is 0.18 and lacks `simplifyWithAttributes`, `Permissive`, `ErrorClamped`, `simplifyPrune`) | `src/vendor/meshopt_simplifier.js` |
| Array-level API: `simplifyMesh`, `lodChain`, `switchDistance`, `uvSeamLock`, `autoUvWeight`, `surfaceDistance`, `viewError` | `src/meshlod-core.ts` (works in browser and in plain `node`, which strips TS types) |
| Whole-document simplify to a triangle budget at one shared world error | `scripts/lib/simplify-doc.mjs` (`simplifyDocument`, `dropTwinTriangles`, `fixInvertedNormals`, `creaseNormals`) |
| Before/after numbers | `node scripts/mesh_stats.mjs a.glb ...`, `node scripts/lod_compare.mjs source.glb lod.glb ...` |
| Normal-map bake high→low | `scripts/bake_normals.py` (Blender venv, see AGENTS.md) |
| Look side by side | `?lab=lod-compare&files=a.glb,b.glb&wire=1` |

## Technique by asset type (what worked here)

- **Hard-surface exports (cars, props from Sketchfab/Objaverse):** `simplifyDocument(doc, { targetTris, normals: 'rebuild' })`.
  Drop normals (+ uvs of untextured parts), weld, drop back-to-back twin triangles, simplify every primitive at ONE
  bisected world-space error, rebuild 35° crease normals. Accord 96k → 14.9k: visible depth error 7.9 mm mean
  (legacy 57k LOD: 6.3 mm), Hausdorff max 21 mm (legacy 35 mm).
- **Organic / scanned connected surfaces:** simplify + bake a tangent-space normal map (204k → 3k blob keeps its ridges).
- See the sections below for pitfalls (they cost the most time).

## Pitfalls found

1. Per-primitive ratio simplify (gltf-transform `simplify`) gets stuck on normal/UV seams: near LODs stayed at 25–61k.
2. `Permissive` + original normals: collapsed vertices keep normals of other facets → dark, wrong shading (rims).
3. Twin triangles (same 3 positions, opposite winding = "double-sided by duplication"): welding makes 4-face edges and the
   simplifier deletes windscreens. Accord had 10,727 of them. `dropTwinTriangles` keeps the outward one, sets doubleSided.
4. `surfaceDistance` counts hidden inner shells; trust `viewError` (z-buffered from 14 views) for "does it look the same".
5. Normal-map baking on fragmented hard-surface cars (27 materials, many small parts, inside-out source shells) gave
   per-triangle islands and inverted texels: not adopted for cars.
