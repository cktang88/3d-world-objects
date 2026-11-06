# Interiors: NYC apartments, brownstones, offices

References looked at (downloaded and viewed while building `src/interior.ts`):

| # | What | URL |
|---|------|-----|
| 1 | Pre-war "classic 7", Hudson River Park (Studiolab): living room, beamed ceiling, wall panel moulding, built-in shelves, herringbone floor, tufted sofa + 2 lounge chairs around a round coffee table on a big rug | https://design-milk.com/images/2017/08/Hudson-River-Park-Studiolab-1.jpg |
| 2 | Same apartment, bedroom: bed centred on wall, nightstands both sides, two double-hung windows with roman shades and brick across the street, flush ceiling drum light, built-in low cabinets under window | https://design-milk.com/images/2017/08/Hudson-River-Park-Studiolab-11-800x539.jpg |
| 3-6 | Park Slope brownstone parlour (Rebuild Workshop / Brownstoner): white marble mantel with black slate surround, gilt mirror above, brass sconces either side; herringbone/parquet with border; kitchen with shaker cabinets, marble backsplash to the uppers, island with stools; bay window with three tall sashes, plaster ceiling medallion, deep crown | https://www.brownstoner.com/interiors-renovation/park-slope-brownstone-rebuild-workshop-parlor-renovation-marble (images `interior-design-ideas-brooklyn-rebuild-workshop-park-slope-01/02/05/08`) |
| 7-10 | Pre-war Manhattan apartment (Emily Butler, Luxe): window wall with radiators under sashes, crown + picture rail, sofa against wall flanked by end tables with table lamps, coffee table in front piled with books, chairs facing; built-in bookcase with glass upper doors; bathroom with white marble subway tile, console sink on nickel legs, hex mosaic floor, mirror + sconces | https://luxesource.com/home-tours/prewar-manhattan-apartment-emily-butler/ (`LX_NewYork65_HOM_Butler_01..07.jpg`) |
| 11-14 | LivePerson NYC office (Mapos): open plan, white benching desks with task chairs and monitors, carpet tile in charcoal with coloured zones, exposed white ducts, pendant ring lights, lounge sofa groups, meeting table with stools | https://officesnapshots.com/2013/09/30/livepersons-collaborative-flexible-nyc-office-expansion/ |
| 15 | Caudalie NYC HQ (Mapos): meeting room, long table with 8 white chairs, TV on wall over credenza/shelves, loft windows with black cast-iron radiators under them, grey carpet, linear lights | https://media.officesnapshots.com/wp-content/uploads/2014/09/2013-12.06-Caudalie_0001-113-web.jpg |

Text sources: Elliman "pre-war features" (https://www.elliman.com/de-de/insider/features-pre-war-apartment), Brownstoner listings (marble mantels, pocket doors, parlour floors with ~3.6-4 m ceilings and near floor-to-ceiling windows, e.g. https://www.brownstoner.com/real-estate-market/fort-greene-historic-district-brooklyn-brownstone-for-sale-259-clermont-avenue-marble-mantels).

## What to copy

**Architecture (pre-war apartment, 1910-1940)**
- Ceiling 2.9-3.3 m. Plaster walls painted warm white / pale greige (`#efe9df`, `#e8e1d4`) or a muted colour; trim brighter white, semi-gloss.
- Baseboard 18-25 cm tall with a cap; crown moulding 12-18 cm tall stepping ~10 cm out from the wall.
- Door casing 9-10 cm wide all round, 2-3 cm proud; doors 0.8-0.9 m x 2.1 m, panelled, painted, brass knobs. Interior doors usually stand open into a room.
- Windows: double-hung sash ~0.95 x 1.7 m, sill at ~0.75 m, stool (inner sill) proud of the wall, apron below, casing like doors. Pairs are common. Outside: brick facade across the street / sky.
- Cast-iron column radiators under windows: ~0.9-1.1 m long, 0.6-0.65 m tall, 0.2 m deep, many vertical sections, painted silver/white (black in lofts).
- Floors: oak herringbone or strip in living/bedrooms; 1" white hex mosaic in bathrooms; checker/hex tile in kitchens.
- Lights: flush drum or schoolhouse glass at the ceiling centre; table lamps and floor lamps give warm pools of light (2700 K).

**Brownstone parlour** (house style): marble mantel ~1.4 m wide x 1.2 m tall with a black firebox opening ~0.75 x 0.75 m, overmantel mirror, sconces either side; tall windows.

**Rooms and groupings**
- Living: sofa against a wall facing a TV on a low console (or the fireplace); coffee table ~0.45 m in front of the sofa, ~1.1 x 0.6 m, 0.45 m high; 1-2 armchairs angled at the side; rug 2.4 x 3 m under the front legs; end tables with lamps at the sofa arms; bookcase along a wall; plant in the corner.
- Bedroom: headboard against a wall, 0.5-0.6 m nightstands both sides each with a lamp; dresser on another wall; rug under the bottom of the bed.
- Kitchen (galley/L): base cabinets 0.9 m high x 0.6 m deep, stone/butcher-block counter, subway tile backsplash up to wall cabinets at ~1.45 m (uppers 0.35 m deep, 0.75 m tall), fridge ~0.75 x 1.8 m at the end of the run, range with hood above; small table with 2-4 chairs if room.
- Bathroom: white subway tile wainscot to ~1.2 m with a cap, hex floor; clawfoot tub 1.7 x 0.75 m along an end wall; pedestal sink with mirror above; toilet beside it; towel bar.
- Study / office room: desk ~1.4 x 0.7 m x 0.75 m against a wall, task chair, monitor + lamp; shelves.
- Open-plan office: benching desks 1.5 x 0.75 m in pairs facing each other, monitor each, task chairs; drop ceiling of 0.6 m acoustic tiles with 0.6 x 1.2 m light troffers; grey carpet tile; glass-walled meeting rooms with table + 6-8 chairs + wall TV.

**Clutter that sells it**: books stacked on coffee tables and in shelves (rows of spines in mixed colours), a bowl/vase, mugs, a plant on the sill, framed pictures above sofa/bed, towels in bathrooms, pots on the stove.

**Lighting**: warm key light (2700-3000 K) from ceiling fixtures plus cooler daylight glow from windows; table lamps visible as glowing shades.

## Built (src/interior.ts, src/rooms/)

Lab: `/?lab=interior-room&style=apartment|house|office&seed=N&room=<type|index>&end=0|1` (or `&corner=0-3`, `&view=plan`).
`&settle=10000` gives library models time to stream before a screenshot.

| Room | Screenshot | Matches reference |
|---|---|---|
| Pre-war living room | `img/interiors-living.jpg` | #1, #7: sofa facing TV, coffee table, rug, end tables + lamps, bookcase, radiators under double-hung windows, crown + baseboard |
| Brownstone parlour (house) | `img/interiors-brownstone.jpg` | #3-6: marble mantel + gilt mirror at the end, picture rail, stair, dining half |
| Galley / one-wall kitchen | `img/interiors-kitchen.jpg` | #5: shaker cabinets, uppers, subway backsplash, range + hood, fridge, schoolhouse pendant |
| Bathroom | `img/interiors-bathroom.jpg` | #9: subway wainscot with cap, hex mosaic floor, clawfoot tub, pedestal sink + mirror, towel bar |
| Bedroom | `img/interiors-bedroom.jpg` | #2: bed centred on a wall, nightstands + lamps, painting over the headboard, door leaf open against the wall |
| Office | `img/interiors-office.jpg` | #11-15: drop ceiling with troffers, benching desks with monitors, glass meeting-room partitions, carpet tile |
