# NYC districts: research and plan

Goal: the city is a set of very different, NYC-plausible neighbourhoods, each a showcase for some
of our ~100K sand3d object families. Districts are a few blocks each and packed close together
(5 to 10 minutes of walking covers all of them), not at their real distances.

Code: `src/nyc/districts.ts` (map + profiles, pure data), `src/nyc/district-build.ts` (hooks nyc.ts
calls), `district-open.ts` (open chunks: park, airport, river), `district-park.ts`,
`district-water.ts`, `district-airport.ts`, `district-custom.ts` (auto row), `district-yards.ts`
(construction, rail/container yard, greenmarket, museum), `district-displays.ts` (sidewalk
displays), `district-showcase.ts` (streaming real-scale sand3d objects into slots).
Pools: `scripts/build_districts.py` -> `public/districts/pools.json`.
Labs: `?lab=district-map`, `district-park`, `district-autorow`, `district-pier`, `district-airport`,
`district-yards` (`&cx=&cz=` picks other blocks).

## Reference photos

Wikimedia Commons:

| Area | Photo | What I took from it |
|---|---|---|
| Central Park Mall / Literary Walk | https://commons.wikimedia.org/wiki/File:Central_Park_Mall_and_Literary_Walk_1.jpg | ~10–13 m wide asphalt promenade, double rows of tall elms meeting overhead, black iron hoop fences (~0.6 m) behind continuous rows of green-slatted benches, Kent-Bloomer/crook lamp posts every ~20 m, statues on plinths at the edge |
| Conservatory Water (boat pond) | https://commons.wikimedia.org/wiki/File:After_a_morning_sail_at_Conservatory_Pond,_Central_Park_(3935433762).jpg | model sailboats; oval pond with stone coping; the park meets 5th Ave with a stone wall |
| Central Park lake rowboats | https://commons.wikimedia.org/wiki/File:Boating_Lake_Central_Park_(4688266839).jpg | rowboats on the lake, boathouse |
| LaGuardia apron | https://commons.wikimedia.org/wiki/File:United_Airlines_aircraft_at_LaGuardia_Airport_with_Rikers_Island_under_construction_in_the_background.jpg | grey concrete apron, parked airliners nose-in, trains of 3–4 blue/white baggage carts behind a small white tug, flat horizon over the water |
| Airliner at gate (LGA) | https://commons.wikimedia.org/wiki/File:USAirN744P-A319-SnowAtGateLGA_(35145761711).jpg | jet bridge, lead-in lines, stop bar |
| Intrepid flight deck | https://commons.wikimedia.org/wiki/File:2_uss_intrepid_aircraft_carrier_flight_deck_2010.JPG | dark grey deck with white/yellow markings, jets parked along the deck edges, island superstructure on the starboard side, Midtown skyline right behind |
| Chelsea Piers | https://commons.wikimedia.org/wiki/File:New_York_City_Chelsea_Piers-20120519-RM-170114.jpg | long blue steel sheds with red stair towers and red bands, roll-up doors, white railings along the pier edge, timber pilings, bollards |
| Canal Street vendors | https://commons.wikimedia.org/wiki/File:Street_Vendors_on_Canal_Street,_Chinatown,_New_York_(7237369622).jpg | stalls and tables pushed against the shopfronts, fruit crates on the sidewalk, tenements with fire escapes |
| Sunnyside / West Side rail yard | https://commons.wikimedia.org/wiki/File:Amtrak_trains_waiting_at_Sunnyside_Yard_(cut).jpg | parallel tracks on ballast, trains parked side by side, catenary poles, low brick industrial buildings behind |
| Diamond District (47th St) | https://commons.wikimedia.org/wiki/File:47th_St_6th_Av_td_29_-_Diamond_District_IND.jpg | dense small shopfronts on a narrow side street |

From memory of the places (no usable Commons hit through the rate limit): Eleventh Avenue auto row
(W 40th–60th St: glass-and-metal showrooms of 1–2 storeys with brand fascias, cars on polished
floors, dealer lots with pennant strings, used-car lots behind chain-link), Union Square Greenmarket
(rows of white/green canvas tents, folding tables with produce, crates beneath), Hudson Yards
(blue plywood fences, sidewalk sheds, tower cranes ~60 m, trailers stacked two high), Museum Mile
(the Met: limestone, wide steps, fountains either side, banners between the columns), the Bowery
(restaurant supply and lighting shops with stock stacked on the sidewalk), 48th St music row.

## Map (cx west is +x, cz south is +z; spawn = M at 0,0 = 5 Av & W 34 St)

```
cx:      -4 -3 -2 -1  0  1  2  3  4  5  6  7
cz -7:    W  H  U  P  P  P  P  S  A  A  R  W
cz -6:    W  H  U  P  P  P  P  S  A  A  R  W
cz -5:    W  H  U  P  P  P  P  S  A  A  R  W
cz -4:    F  H  U  P  P  P  P  S  A  A  R  W
cz -3:    F  H  H  M  M  M  T  T  A  A  R  W
cz -2:    F  F  H  M  M  M  T  T  X  A  R  W
cz -1:    F  F  H  M  M  M  M  D  X  I  R  W   <- carrier offshore at (7,-1)
cz  0:    F  F  H  M [M] M  M  D  X  I  R  W
cz  1:    W  F  K  B  M  M  D  D  I  I  R  W
cz  2:    W  W  K  K  C  C  B  B  I  I  R  W
cz  3:    W  W  K  K  C  C  B  B  I  I  R  W
```
M midtown, T Times Square, S music row, D garment/sporting goods, B Bowery kitchen & lighting,
C Canal St, K greenmarket/Chinatown, H brownstones, I industrial/rail yards, X Hudson Yards
construction, U Museum Mile, A auto row, P park, F airport, R Hudson River Park piers, W river.
Beyond the map: the Hudson (west) and the East River (east) continue; north and south, 3x3-block
neighbourhoods are drawn from a weighted mix (with single-block parks).

From the spawn the player looks north up 5th Avenue: Midtown towers both sides and the park's
trees closing the vista 3.5 blocks away, where the avenue meets the park wall and becomes the Mall.

## Object family coverage (catalog counts; where they show)

| Family (count) | District showcase |
|---|---|
| furniture 1440 | brownstone stoop sales, Bowery sidewalk, park kiosk tables, furniture shops |
| tableware 1393 / cookware 242 / kitchen appliance 144 | Bowery displays, greenmarket stalls, kitchen-supply shops |
| hand tool 1368 / power tool 69 / fastener 713 | construction site, Canal St tables, hardware shops |
| electronics 1356 | Canal St and Times Square tables, electronics shops |
| machine/industrial 1355 | construction site, rail/container yard, industrial sidewalk |
| vehicle 1354 | auto row showroom + lots, construction trucks, airport tugs, rail yard trains, park kiosk carts |
| container 1344 / packaging 752 | container yard, greenmarket crates, construction materials |
| lighting 1334 | Bowery sidewalk lamps, lighting shops |
| architectural element 1315 | park fountain terrace, Museum Mile plinths |
| building 973 | park boathouse, kiosk, garden pavilion (small buildings at real size) |
| aircraft/spacecraft 958 | airport stands, hangar, GA ramp, helipad, aircraft pier, carrier deck |
| weapon/armour 944 | Museum Mile plinths, park terrace statues |
| food & drink 788 | greenmarket stalls, market sidewalk tables |
| garden/outdoor 575 | park benches, gardens, meadow, playground |
| toy/game 551 | playground sandbox, meadow, Times Square and Canal tables |
| watercraft 532 | marina slips, shed pier, park pond rowboats |
| medical/personal care 525 / bathroom 215 | brownstone curbside, pharmacies |
| stationery 444 | stoop sales, garment district tables |
| sports 424 | ballfield and courts, garment district (sporting goods) |
| musical instruments 418 | music row sidewalk and shops |
| home appliance 341 | brownstone curbside, Bowery |
| measuring instruments 257 | Museum Mile plinths |
| animal gear 76 | park dog run and bird houses |

## Rules

- Real scale always (`realScale`); a candidate that doesn't fit its slot at real size is skipped.
- Slots load only within their radius (40–260 m by object size), unload 40 m further, at most 4 loads
  at once, 3 M showcase triangles in total, per-object caps; meshes merged by material.
- Every shown object is an inspect portal (E: details and program); originals swap in close up.
- Open chunks remove the roads between them: traffic stops at the dead end (and is recycled out
  of sight), pedestrians re-place / turn back where `walkable()` says no (river, airport).

## Coverage (scripts/district_coverage.py)

Distinct objects of each family a player can meet in the city (district showcase pools, shop stock,
bundled street props / interiors) against the 22K catalogue. Before → after the flea market (garment
district, W 39th St style) and the architectural salvage yard (industrial blocks):

| family | catalogue | before | after |
|---|---:|---:|---:|
| furniture | 1440 | 506 (35%) | 752 (52%) |
| tableware | 1393 | 338 (24%) | 612 (44%) |
| electronics | 1356 | 427 (31%) | 599 (44%) |
| container | 1344 | 357 (27%) | 648 (48%) |
| lighting | 1334 | 426 (32%) | 652 (49%) |
| architectural element | 1315 | 249 (19%) | 733 (56%) |
| building | 973 | 159 (16%) | 159 (16%) |
| hand tool | 1368 | 449 (33%) | 442 (32%) |
| machine or industrial | 1355 | 430 (32%) | 430 (32%) |

Still under-shown: building (small structures at real size need open ground), hand tools and machines
(construction site / yards only show a few dozen at a time), home appliances, weapons & armour.
