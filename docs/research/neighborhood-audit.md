# Neighbourhood audit: street level vs the real city

[nbhd] One eye-height street shot per district (`?mode=world&r=1`, textures on, 768×432, HUD hidden, people off,
streamed 30 s with drawing off, then drawn: `scratchpad/nb/shot2.sh` + `batch.sh`), compared side by side with
street photos of the real neighbourhood (Wikimedia Commons; page links below). Per district: the two most
visible gaps, what was fixed, what is left. "Before" shots were taken from a frozen copy of `main` (after the
brownstone and waterfront commits, before the High Line / Meatpacking / park-edge ones); the brownstone and
waterfront befores are the earlier lab / world shots named in each section.

Shots live in the session scratchpad (`…/scratchpad/nb/b-<district>.png` before, `a-<district>.png` after).
Two lessons for whoever repeats this: wait for streaming by polling `__world.level` (`pending` empty and 9
chunks built), not a fixed time; and shoot from a frozen copy of the source on its own vite port, because the
live dev server reloads the page whenever a file changes mid-shot.

QA: `npm run qa -- nbhd` (tests/neighborhoods.test.ts) measures what can be measured: brownstone storeys and the
shared cornice line, ashlar present, pier detail counts (rail panels, piles, bollards, riprap, foam), no doubled
water planes, the far-shore budget and that it stays inside the camera's far plane, no HLOD inside 150 m, the
High Line strip free of buildings and dressed, Meatpacking canopies over the sidewalks.

## Waterfront (Hudson River Park, Chelsea Piers, East River esplanade, the Battery)

References:
- Hudson River Park railing and bulkhead: https://commons.wikimedia.org/wiki/File:Hudson_River_Park_td_(2018-04-03)_08.jpg
- Chelsea Piers sheds: https://commons.wikimedia.org/wiki/File:New_York_City_Chelsea_Piers-20120519-RM-170114.jpg
- East River esplanade (benches against a picket rail, trees, river at the bulkhead): https://commons.wikimedia.org/wiki/File:East_River_Esplanade,_Manhattan,_New_York,_US.jpg
- East River from the esplanade: https://commons.wikimedia.org/wiki/File:View_from_the_East_River_Esplanade_029.jpg
- Battery Park City esplanade: https://commons.wikimedia.org/wiki/File:Battery_Park_City_Esplanade_001.jpg
- The New Jersey shore (Jersey City skyline): https://commons.wikimedia.org/wiki/File:Lower_Manhattan_from_Jersey_City_September_2020_panorama.jpg

Why it looked "crazy low poly" (before: `nb/before-water.png`, 141 calls / 548k tris at r=1):
1. The river was per-chunk slabs that stop at the streamed ring and at the HLOD distance (HLOD proxies of open
   chunks have no water): beyond ~150–250 m the water simply ended and the sky showed below the horizon. No far
   shore at all (and the camera's far plane is 900 m, the Hudson is 1.25 km wide).
2. The water was one tiled ellipse normal map (a blue-and-white checkerboard at grazing angles).
3. Piers were a 1.4 m solid block with a beige slab on top and a few posts; the bulkhead a flat grey box; the
   railing two bars and a post every 2 m; lamps were highway cobra heads.

Fixed (`src/nyc/waterfront.ts`, `[nbhd]` hooks in `district-water.ts`, `nyc.ts`):
- one open river surface out to the far plane, two scrolling wave normal scales, mirror-like roughness, lighter
  open-water haze; chunk water only where the open river does not reach;
- the far shores as a backdrop: Fort Lee/Edgewater towers, the palisade cliff behind Weehawken, Hoboken row
  houses, Jersey City towers; Long Island City over the East River. One draw per shore (~45k tris together),
  drawn first without depth writes, scaled about the eye into the far plane (same angles), haze for the true
  distance, windows lit at night;
- granite ashlar bulkhead with a projecting coping, the esplanade picket railing (instanced panels), riprap toe,
  foam lace at the bulkhead and around the piers, crook park lamps along the rail, a marked bikeway (double
  yellow centre line, edge lines, bike symbols);
- pier decks in timber planks (concrete on the shed pier) on a 0.45 m slab, a timber pile grid under them
  (3.2 × 3.1 m), fender piles and whalers along the sides, bollards, cleats on the marina fingers.

After (`nb/after-water.png`, same pose): 117 calls / 661k tris at r=1 (the pile grid, rail and riprap are
instanced: ~7 extra draws per pier chunk). Left: the Hudson River Park rail is really a grey wavy pipe rail
(ref. 1), ours is the Battery-style picket; no tide/vertical waves; pier sheds other than Chelsea Piers.

## Brownstone Row

References:
- Harlem brownstones (stoops, newels, door hoods, continuous cornice): https://commons.wikimedia.org/wiki/File:Harlem,_New_York_brownstones.jpg
- Prospect Place, Brooklyn (sunburst stoop rails, iron areaway fences, trees): https://commons.wikimedia.org/wiki/File:161-_169_Prospect_Place.jpg
- Park Slope row: https://commons.wikimedia.org/wiki/File:Park_Slope_Brownstone.jpg
- Upper West Side brownstone: https://commons.wikimedia.org/wiki/File:A_Nero_Wolfe_Mystery_brownstone_on_Upper_West_Side.jpg

Before (coordinator's `scratchpad/brownstone-lab.png`, mine `nb/bs-before.png`): fronts read as red brick (the
painted-plaster photo tinted red), rooflines jumped (each house its own 3–5 floors + parlour height; one ~7
storeys with the garden level), no newels/ironwork, no garden doors, plain door hoods.

Fixed (`src/nyc/brownstone.ts`): smooth ashlar canvas (0.5 m courses, hairline joints, weathering, rain streaks)
tinted to chocolate/pink brownstone; rows built in developer runs (3–7 identical houses: width, 3–4 storeys over
the garden level, parlour height, colour, cornice); iron newels with urns and sunburst panels; gated garden-level
door under the stoop; tall scrolled door consoles with a triangular or segmental pediment; shrubs in the front
areaways; Park Slope bow fronts (three-sided bays with windows on every facet) on a third of the runs.
After: `nb/bs-2.png`, `nb/bs-3.png` (close-up), `nb/bs-bow.png`, world `nb/a-brownstone.png` (a newel with its
urn and the sunburst rail beside a stoop).
Left: carved window lintels are still the generic Italianate hood; no stoop-sale clutter or bins in the areaways.

## Midtown (5 Av & 34 St, the spawn)

Reference: https://commons.wikimedia.org/wiki/File:View_of_Empire_State_Building_from_Rockefeller_Center_New_York_City_dllu.jpg
Shot: `nb/b-midtown.png` (1118 calls, 3.8M tris).
1. Glass-tower lobbies read as blank white panels at street level (the real ones are dark, reflective, deep-set
   lobbies with revolving doors and lit interiors). Owner: lobbies agent.
2. The sidewalk is bare between lamps: real Fifth Avenue has planters, litter baskets, newsstands, Citi Bike
   docks and subway stairs every block. Left.

## Times Square

Reference: https://commons.wikimedia.org/wiki/File:Street-level_view_of_Times_Square.jpg
Shot: `nb/b-timesq.png` (480×270: the 768×432 world shot crashed the headless page twice, "Target page closed").
1. Too few screens: the stack started 5.5–8 m up and stopped after ~5, leaving bare walk-up facades between
   them; the real square is wall-to-wall LED from the storefront heads (~4.5 m) to 30–50 m. **Fixed**
   (district-displays.ts, `[nbhd]`: screens start at 4.7–5.4 m, up to 7 per column, to ~50 m; lab `nb/ts-1.png`,
   world after `nb/a-timesq.png`: screens on both sides now come down to the shop heads and fill the facades).
2. Sidewalk sheds and plain walk-ups at street level; no pedestrian plaza, red TKTS steps, planters. Left.

## Music Row (W 48 St)

Reference: https://commons.wikimedia.org/wiki/File:Gun_Free_48th_Street_HDR_2022_jeh.jpg
Shot: `nb/b-music.png` (2075 calls, 4.6M tris — over the ~1500 call budget, mostly the auto row showrooms
across the avenue) → lab `nb/music-2.png` (a blade sign down the street), world `nb/a-music.png` (same avenue pose: the
shed is gone after other agents' changes; the blades hang on the side streets, not visible from it).
1. Nothing reads as music down the street: **fixed** in part — vertical blade signs (GUITARS, DRUMS, PIANOS,
   AMPS…) with lit letters hang off the facades (nbhd.ts musicBlades).
2. Sidewalk sheds on most fronts hide the walk-ups (red brick, fire escapes, ornamented entrance bays). Left.

## Garment District

Reference: https://commons.wikimedia.org/wiki/File:Garment-district-39th-and-ninth.JPG and
https://commons.wikimedia.org/wiki/File:Garment_District_button_and_needle.jpg
Shot: `nb/b-garment.png` → after `nb/a-garment.png` (same pose; that frontage is now a glass tower, so no racks)
and lab `nb/garment-lab.png` (racks along the 38th St fronts). 1. Sidewalks empty — the district's rolling garment racks
were missing: **fixed** (nbhd.ts garmentRacks: chrome Z-racks of coats and dresses along fronts, clear of doors).
2. The real loft buildings are 12–20 storey brick/terracotta lofts with water towers, ours are a mix with glass
offices across the avenue; the button-and-needle sculpture is missing. Left.

## Hudson Yards

Reference: https://commons.wikimedia.org/wiki/File:23rd_St_10th_Av_td_(2018-11-27)_14_-_10_Hudson_Yards,_30_Hudson_Yards.jpg
Shot: `nb/b-hudsonyards.png` (2549 calls — over budget). 1. No glass supertalls (30 / 10 Hudson Yards, the Edge's
cantilevered deck): the blocks are walk-ups with a crane. 2. No High Line along the yards: **fixed** in part (the
High Line now runs through the industrial column next door, cz -1..3). Left: the supertall cluster.

## Meatpacking

Reference: https://commons.wikimedia.org/wiki/File:14th_St_9th_Av_Hudson_St_td_(2022-02-07)_18.jpg,
https://commons.wikimedia.org/wiki/File:Cobblestone_(14629258476).jpg, High Line:
https://commons.wikimedia.org/wiki/File:High_Line_td_19_-_Chelsea_Park.jpg,
https://commons.wikimedia.org/wiki/File:Chelsea_Manhattan_as_seen_from_High_Line_Park.jpg
Shots: `nb/b-meatpacking.png` → `nb/a-meatpacking.png` (12 Av pose: the salvage-yard frontage, unchanged),
`nb/a-highline.png` (under the High Line on a Belgian-block street, 1002 calls / 2.4M tris), lab `nb/hl-1.png`
(canopies, cobbles, the viaduct).
1. Asphalt where the real streets are Belgian block: **fixed** (all industrial blocks south of 34th cobbled).
2. No High Line and no steel loading-dock canopies: **fixed** (nbhd.ts: plate girders on bents 8.6 m up, planted
deck, picket rails, trees, benches; canopies with tie rods over the low market buildings). Left: High Line stairs
/ elevator access (it is visual only), the Gansevoort end and the Whitney.

## The Bowery

Reference: https://commons.wikimedia.org/wiki/File:Bowery,_looking_north_from_Houston_Street.jpg
Shot: `nb/b-bowery.png`. 1. Midtown glass towers across the avenue (the compressed map puts Midtown next door),
the real Bowery is 4–6 storey tenements and lofts on a wide street. 2. The restaurant-supply clutter (ranges,
steel tables, racks) is only on one side street; the avenue fronts are plain. Left (map / districts agent).

## Canal Street

Reference: https://commons.wikimedia.org/wiki/File:Canal_Street,_Chinatown,_Manhattan,_New_York_(7237368412).jpg
Shot: `nb/b-canal.png`. Reads well: tenements with fire escapes, electronics shops, graffiti on shutters, AC units.
1. Midtown towers loom up the avenue (map compression). 2. Signage density: real Canal St has stacked
bilingual boards, vertical blade signs and sidewalk vendor tables in front of every shop. Left.

## Greenmarket (Union Square)

Reference: https://commons.wikimedia.org/wiki/File:Union_Square_Farmers_Market.jpg,
https://commons.wikimedia.org/wiki/File:Union_square_August_2009.jpg
Shot: `nb/b-greenmarket.png` (906 calls). Walk-ups, a diner and a deli read right. 1. From the avenue nothing says
market: the stalls stand on the plaza inside the block; the real Greenmarket spills white tents, produce crates
and delivery trucks onto the sidewalk edge. 2. A Midtown tower behind (map compression). Left.

## Museum Mile (Fifth Avenue)

Reference: https://commons.wikimedia.org/wiki/File:Metropolitan_Museum_of_Art_entrance_NYC.JPG
Shot: `nb/b-museum.png` (472 calls). 1. **Bug**: a large object with a smeared rainbow-gradient surface (an
untextured / wrongly-mapped showcase or parked-vehicle model) fills the sidewalk view at (-189, -375) — reported
for the districts / vehicles owners. 2. A sidewalk shed on the museum frontage hides it; the park side (right)
reads well (trees, crook lamps, wall). The real Met front: wide granite steps, fountains, banners. Left.

## Central Park edge (Central Park South / Fifth Avenue)

Reference: the park side of Fifth Avenue in https://commons.wikimedia.org/wiki/File:Metropolitan_Museum_of_Art_entrance_NYC.JPG
(hex-paver sidewalk, low stone wall, benches against it, plane trees, lamps).
Shot: `nb/b-cpedge.png` → lab `nb/cp-1.png` (the world after-shot crashed the headless page once; not retried).
1. The park-side sidewalk was bare city flags: **fixed** — the park's hexagonal asphalt pavers and a long row of
   Central Park settees against the wall, facing the street (district-park.ts, `[nbhd]`).
2. The wall reads dark brown and continuous; the real perimeter wall is grey Manhattan schist / granite with a
   coping and gate piers, with London planes in pits outside it. Left.

## Auto Row (Eleventh Avenue)

Reference: https://commons.wikimedia.org/wiki/File:11th_Avenue_from_High_Line,_New_York_City,_20231001_1716_1455.jpg,
https://commons.wikimedia.org/wiki/File:100_Eleventh_Avenue_(24234).jpg
Shot: `nb/b-autorow.png`. Car lot with a pennant sign and a glass showroom read right. 1. The showroom glass
reads flat grey; the real showrooms are bright, double-height and full of lit cars. 2. Lots lack the bunting
strings / balloon arches and windshield price signs. Left (districts agent's auto row).

## LaGuardia

Reference: https://commons.wikimedia.org/wiki/File:Delta_Connection_fleet_at_LaGuardia_Airport_Terminal_C.jpg,
https://commons.wikimedia.org/wiki/File:Marine_Air_Terminal,_LaGuardia,_facade.jpg
No shot: the world page crashed ("Target page closed" / "Target crashed") at (-291, -119) twice, at 768×432 and
at 480×270, while every other pose rendered — the aircraft showcase models there are the likely memory spike
(reported, not investigated further). Not compared.

## Perf at the waterfront and in the districts (r=1, people off, from the shots' eval)

| pose | calls | tris |
|---|---|---|
| esplanade, before (`before-water`) | 141 | 548k |
| esplanade, after (`after-water`) | 117 | 661k |
| Midtown spawn | 1118 | 3.8M |
| Music Row (auto row across) | 2075 | 4.6M |
| Garment | 1715 | 3.6M |
| Hudson Yards | 2549 | 3.4M |
| Meatpacking (12 Av) | 1076 | 2.1M |
| Canal | 1463 | 3.3M |

Hudson Yards and Music Row are over the ~1500 draw-call budget (auto row showroom cars and construction slots);
not from this work, reported.

## Second pass (render only the changed block: `?lab=block&pose=…`)

All shots below are `?lab=block` (the one changed chunk by the real generator at its world position, camera at
the world pose, `&ring=1` neighbours as HLOD), 30–60 s each, no world lock, no crashes.
- **Midtown sidewalks** (`nb/blk-midtown.png`): granite planters with clipped shrubs and flowers, litter baskets,
  bike staples, newsstands, Citi Bike docks, diamond-plate vault doors, all collider- and door-checked on top of
  streetExtras' hydrants, standpipes, meters and bollards. qa: 25 → 41 sidewalk pieces on the spawn block.
- **Times Square** (`nb/blk-tkts.png`, `nb/tkts-1.png`): Duffy Square on the avenue end of (2,-3): plaza pavers,
  27 red glass TKTS steps (≈5 m) over the booth, glass cheeks, planters, red café tables; no billboards hang on
  that (now open) side.
- **Hudson Yards** (`nb/blk-hy.png`, `nb/blk-hy2.png`): 30 HY (~300 m, sloped glass crown, the Edge's cantilevered
  triangular deck) and 10 HY (~245 m) built as real towers on the construction blocks' avenue ends, so their
  HLOD hulls carry them across the city. Left: they are 20 m deep (the avenue frontage) and read slender; the
  Vessel.
- **Central Park wall** (`nb/blk-cpwall.png`): grey schist/granite ashlar with a lighter coping.
- **Greenmarket** (`nb/blk-market.png`): white market tents with produce crates along the avenue sidewalks.
- **Hudson River Park railing** (`nb/blk-hrp.png`): brushed-steel square posts, a round top rail and four wavy
  pipe rails (as in the reference) on the bulkhead and piers; the East River seawalls keep the picket rail.
- **Detail pass** (`nb/blk-planter.png`, `nb/blk-tkts2.png` with `&ring=2`, `nb/blk-tkts3.png`, `nb/blk-hy3.png`):
  boxwood/annual leaf-card shrubs (~0.65 m) instead of faceted blobs; TKTS as 27 lit red glass treads with risers,
  a steel substructure, glass cheeks, four sloped handrails and the booth; red bistro chairs and café tables;
  Duffy Square framed by the billboards on the walls behind it; the Hudson Yards supertall on a 40 × 25 m
  footprint (taking 20 m of the row) with a glass podium. Left: the tower facade comes out as panel, not full
  curtain-wall glass, at this seed (tower() picks it); the Vessel.
- **Times Square screens** (`nb/ts-ads-nyc.png`, `nb/ts-ads-night.png`, `nb/ts-led-close.png`): a procedural ad
  atlas (nyc/billboards.ts) with 28 ads in 8 layouts — Broadway posters, product hero shots, portraits, big-type
  brand walls, key art, sports, food, tech — plus news and stock tickers; LED pixel grid up close, emissive
  boosted at night, scrolling tickers and crossfading screens in the shader; one mesh per block as before.
  Products are hand-drawn shaded silhouettes, not library renders. 30 Hudson Yards is now full curtain wall
  (`nb/blk-hy5.png`). Left: the Vessel.
