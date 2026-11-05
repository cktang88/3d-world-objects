# Fractal World

An endless first-person world where everything has an inside.

- Walk around a procedurally generated city that streams in around you.
- Walk up to any **door** and press <kbd>E</kbd>: the building generates its interior, with rooms, furniture and props laid out by room type. Stairs lead to more floors.
- Look at any **object** (a toaster, a toy, a parked truck, a lamp post, a museum exhibit) or a **painting** and press <kbd>E</kbd>: you shrink into it. Inside is a whole new world, with that object towering over the central plaza. Its buildings have interiors, the interiors have objects, and so on with no bottom.
- <kbd>Q</kbd> climbs back out one level. The breadcrumb trail (top left) and the scale counter (top right) show how deep you are.

The worlds are deterministic: the same door always leads to the same rooms. Try `?seed=hello` or `?biome=neon` (`town`, `metropolis`, `neon`, `snow`, `desert`, `toyland`, `candy`, `circuit`).

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

Controls: <kbd>WASD</kbd> move · mouse look · <kbd>Shift</kbd> run · <kbd>Space</kbd> jump · <kbd>E</kbd> enter · <kbd>Q</kbd> back out · <kbd>C</kbd> credits. On touch devices, drag the left half of the screen to move and the right half to look.

## Where the objects come from

All the 3D objects come from [**sand3d**](https://github.com/Sandflow-ai/sand3d) by [Sandflow](https://sandflow.ai/sand3d/), a library of 100K+ objects written as short Python programs. This project uses the [`sand3d-objaverse`](https://huggingface.co/datasets/Sandflow/sand3d-objaverse) dataset (CC BY 4.0). Each row has a program plus the OpenUSD (`.usda`) file that program exports.

The pipeline lives in `scripts/` and uses only the Python standard library:

1. `fetch_catalog.py` samples the dataset's metadata (id, family, size, attribution) through the Hugging Face dataset-viewer API.
2. `build_assets.py` picks objects for each role in the world (building, street lamp, vehicle, chair, table, storage, appliance, toy, food…) by family and title keywords. It downloads their `.usda` files, converts them to GLB, and writes `public/models/manifest.json` and `CREDITS.md`.
3. `usda_to_glb.py` is a small USDA → GLB converter for sand3d's output. It handles transforms, meshes, normals and UsdPreviewSurface materials, converts Z-up to Y-up, and puts each object's base at the origin. Sizes stay in real metres, so a chair is chair-sized.

Regenerate the objects with `npm run assets` (needs Python 3 and network access to huggingface.co).

## Code map

| file | what it does |
|---|---|
| `src/main.ts` | renderer, level stack, portal aiming, zoom/fade transitions, HUD |
| `src/city.ts` | streamed city chunks: roads, buildings with doors, parks, landmarks, street props, parked vehicles |
| `src/interior.ts` | BSP floorplans, doors, windows, room types, furniture placement, items on surfaces, paintings, stairs |
| `src/assets.ts` | manifest, per-role size normalisation, lazy GLB loading |
| `src/biomes.ts` | the eight world styles, and which objects lead to which |
| `src/textures.ts` | canvas-generated facades, floors, wallpapers, roads, paintings, sky |
| `src/player.ts` | first-person controller with collisions |

## Credits

The object list with attributions is in [CREDITS.md](CREDITS.md), and in game under <kbd>C</kbd>. The sand3d programs, renders and USD files are CC BY 4.0 by Sandflow. Each derives from an Objaverse/Sketchfab model whose author and licence are listed with it. Here they are converted from OpenUSD to glTF.
