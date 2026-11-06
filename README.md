# sand3d World & Museum

A first-person three.js world built from [**sand3d**](https://github.com/Sandflow-ai/sand3d), [Sandflow](https://sandflow.ai/sand3d/)'s open-source library of 100,000+ 3D objects, each one written as a short program. Two modes:

## World: New York

- Manhattan-style grid that streams in as you walk: long crosstown blocks, wide avenues.
- Brownstones with stoops, brick tenements with fire escapes and water towers, pre-war apartment blocks, cast-iron lofts and glass towers.
- Storefronts with awnings and signs, yellow cabs and MTA buses that stop at red lights, pedestrians, street trees, hydrants, newspaper boxes, steam stacks, subway entrances, and green street-name signs at every corner.
- **Walk into any shop.** Delis, hardware stores, electronics, toys, music, kitchen supply, pharmacy, antiques, machine parts and more are stocked from the full sand3d catalogue. Every product is a real sand3d object streamed from Hugging Face; press <kbd>E</kbd> on it to read its program.
- **Fractal mode:** apartment and office doors lead to generated interiors. Look at any sand3d object, vehicle or painting and press <kbd>E</kbd> to shrink into it: there's a whole world inside, with buildings that have their own interiors, and so on. <kbd>Q</kbd> climbs back out.

## Museum: infinite rooms of similar things

- Starts in an **atrium with six wings** of very different objects: Vehicles, Musical Instruments, Food & Drink, Moving Mechanisms, Machine Parts and Aircraft & Spacecraft.
- Every room is a **theme**: a hero piece in the middle and eight glass cases of three related objects each.
- Each room has three doorways: more of the same theme, the most similar themes in the same collection, and sometimes a similar theme from a different collection. **Walk through a doorway** and the next room is generated. The graph has 3,999 rooms over ~80,000 objects, so you never run out.
- Articulated objects (from Articraft and AutoMate) **move**: their real joints swing and slide.
- Look at any object and press <kbd>E</kbd>: its source, author, size, joints, a link to the dataset row, Sandflow's render, and **the actual sand3d program** that builds it.

## Detail

- **Original models:** every Objaverse-derived sand3d object knows where its original textured model lives in [allenai/objaverse](https://huggingface.co/datasets/allenai/objaverse). When you get close (museum exhibits, shop products, street props), the original streams in and replaces the sand3d version, scaled to sand3d's real-world size. Draco, Meshopt and KTX2 are supported, and huge textures are downscaled. Press <kbd>O</kbd> to switch back to the pure sand3d programs.
- **Materials from sand3d kinds:** sand3d names each material after its kind (`oak__…`, `brushed_steel__…`, `fabric__…`). `src/materials.ts` turns those into triplanar procedural surfaces (wood grain, brushed metal, weave, leather, marble veins, concrete pores, rubber) with colour, roughness and bump detail, without needing UVs. Glass becomes transmissive glass. Untextured CAD parts render as machined aluminium.
- **Rendering:** MSAA, ground-truth ambient occlusion (GTAO), bloom, a physical sky that also lights the reflections, and 4K shadow maps. Press <kbd>G</kbd> to cycle ultra / high / low, or open `?quality=high`.
- **NYC architecture:** instanced 3D windows (frames, mullions, sills, lintels, reflective glass), normal-mapped brick and stone, reflective curtain-wall towers, extruded car bodies, and detailed shop windows.

## Realism

- **Rebuilt from the programs, with UV maps.** `scripts/rebuild.py` runs each object's sand3d program in Blender (`pip install sand3d`), smart-UV-unwraps every part, and rescales the UVs so one unit is one metre. Then it exports a GLB that keeps sand3d's material kinds. All world objects, the museum wings' opening rooms and the shop stock are rebuilt this way and Meshopt-compressed (`public/models/`, `public/rebuilt/`). Everything else streams as USD and gets the same textures through triplanar projection.
- **Photo-scanned textures at physical size.** `scripts/fetch_pbr.py` builds `public/pbr.json` from CC0 [Poly Haven](https://polyhaven.com) sets, including each texture's real-world dimensions:
  - **Material kinds:** oak, walnut, pine, birch, metals, linen, velvet, leather, marble, concrete.
  - **NYC architecture:** brick, brownstone, limestone, sidewalk pavers, asphalt, roofing, bark.
  - **Interior floors:** parquet, marble, tile, carpet.

  Colour, height and roughness/AO maps stream from Poly Haven's CDN. Object textures keep the object's own sand3d colour.
- **Realistic scale.** `src/realscale.ts` knows the typical size of ~400 kinds of things (a mug is 12 cm, a cello 1.25 m, a bus 12 m) plus plausible ranges per family. Objaverse-derived objects that are far off get rescaled; CAD, Articraft, SimReady and AutoMate are modelled at real size already. The museum shows objects at actual size when they fit a case and labels the display scale otherwise. Shops stock products at their real size.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

Open `?mode=world` or `?mode=museum` to skip the menu. Controls: <kbd>WASD</kbd> move · mouse look · <kbd>Shift</kbd> run · <kbd>Space</kbd> jump · <kbd>E</kbd> enter / inspect · <kbd>Q</kbd> back · <kbd>C</kbd> credits. On touch devices, drag the left half of the screen to move and the right half to look.

## How the objects get into the browser

The museum and the shops stream any object on demand. `src/usda/parse.ts` is a TypeScript USDA parser that runs in a pool of Web Workers (`src/usda/worker.ts`). It fetches the `.usda` file straight from the dataset on Hugging Face and keeps rigid bodies and their `PhysicsRevoluteJoint` / `PhysicsPrismaticJoint`s, so `src/remote.ts` can rebuild the joint hierarchy and animate it.

The museum's similarity graph is built offline:

1. `scripts/fetch_index.py` reads the metadata of all ~104K rows across the five datasets (Objaverse, CAD, Articraft, SimReady, AutoMate). For each row it keeps a bag of words from the title, family and **the program's own identifiers**: function names, part names and constants like `seat`, `backrest`, `hinge`, `flange`.
2. `scripts/build_museum.py` turns those into TF-IDF vectors and clusters each collection with spherical k-means into rooms of about 20 objects. It orders each room so cases hold mutually similar triples, names rooms from their most distinctive title words, and links every room to its nearest rooms by centroid cosine. Output: `public/museum/themes.json` (the graph), `public/museum/t/*.json` (room contents) and `public/museum/pools.json` (shop stock).

## Where the bundled objects come from

All the 3D objects come from [**sand3d**](https://github.com/Sandflow-ai/sand3d) by [Sandflow](https://sandflow.ai/sand3d/), a library of 100K+ objects written as short Python programs. This project uses the [`sand3d-objaverse`](https://huggingface.co/datasets/Sandflow/sand3d-objaverse) dataset (CC BY 4.0). Each row has a program plus the OpenUSD (`.usda`) file that program exports.

The pipeline lives in `scripts/` and uses only the Python standard library:

1. `fetch_catalog.py` samples the dataset's metadata (id, family, size, attribution) through the Hugging Face dataset-viewer API.
2. `build_assets.py` picks objects for each role in the world (building, street lamp, vehicle, chair, table, storage, appliance, toy, food…) by family and title keywords. It downloads their `.usda` files, converts them to GLB, and writes `public/models/manifest.json` and `CREDITS.md`.
3. `usda_to_glb.py` is a small USDA → GLB converter for sand3d's output. It handles transforms, meshes, normals and UsdPreviewSurface materials, converts Z-up to Y-up, and puts each object's base at the origin. Sizes stay in real metres, so a chair is chair-sized.

Regenerate the objects with `npm run assets` (needs Python 3 and network access to huggingface.co).

## Code map

| file | what it does |
|---|---|
| `src/main.ts` | renderer, modes, level stack, portal aiming, walk-through doorways, transitions, HUD, info panel |
| `src/nyc.ts` | the New York world: blocks, building types, storefronts, signals, traffic, pedestrians, geometry baking |
| `src/shop.ts` | shop interiors stocked with streamed products (instanced facings) |
| `src/museum.ts` | atrium and gallery rooms, vitrines, labels, exhibit loading |
| `src/museumData.ts` | loads the similarity graph and room contents |
| `src/remote.ts`, `src/usda/*` | streaming USDA loader, worker pool, joints |
| `src/city.ts` | streamed city chunks: roads, buildings with doors, parks, landmarks, street props, parked vehicles |
| `src/interior.ts` | BSP floorplans, doors, windows, room types, furniture placement, items on surfaces, paintings, stairs |
| `src/assets.ts` | manifest, per-role size normalisation, lazy GLB loading |
| `src/biomes.ts` | the eight world styles, and which objects lead to which |
| `src/textures.ts` | canvas-generated facades, floors, wallpapers, roads, paintings, sky |
| `src/player.ts` | first-person controller with collisions |

## Credits

The object list with attributions is in [CREDITS.md](CREDITS.md), and in game under <kbd>C</kbd>. The sand3d programs, renders and USD files are CC BY 4.0 by Sandflow. Each derives from an Objaverse/Sketchfab model whose author and licence are listed with it. Here they are converted from OpenUSD to glTF.
