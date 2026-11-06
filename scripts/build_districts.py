#!/usr/bin/env python3
"""
Showcase pools for the NYC districts (src/nyc/districts.ts): the outdoor objects of each kind of
place (cars for the auto row lots, aircraft for the airport apron, boats for the piers, benches,
playground pieces and statues for the park, crates and machines for the rail yard...).

Each pool is a family plus a title/entry keyword filter over the full sand3d index
(scripts/.cache/index.jsonl), ranked: Blender rebuilds (UV-mapped GLBs) first, then objects with an
Objaverse original, then fidelity score. Output: public/districts/pools.json
{kind: [compact rows as in public/museum/pools.json]}.

    python3 scripts/build_districts.py
"""
import gzip
import json
import os
import random
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
IDX = os.path.join(HERE, ".cache", "index.jsonl")
OUT = os.path.join(ROOT, "public", "districts", "pools.json")

# kind: (families, include regex, exclude regex, max entries)
EX_PART = r"part|piece|wheel|tyre|tire|rim|seat|door|interior|engine|spoiler|bumper|key|track|rail|lightbar|light bar|steering|mirror|hood|chassis|frame|axle|logo|icon|sign|badge|toy|lego|rc |model kit|keychain|button|panel|gear|kit\b"
KINDS = {
    # auto row: whole road vehicles
    "car": (["vehicle"], r"\b(car|sedan|coupe|suv|hatchback|jeep|pickup|taxi|cab|mustang|porsche|ferrari|bmw|audi|mercedes|toyota|ford|chevrolet|chevy|nissan|honda|lamborghini|tesla|volkswagen|vw|beetle|cadillac|roadster|convertible|limousine|minivan|van|camaro|corvette|subaru|mazda|hyundai|kia|volvo|lexus|dodge|fiat|mini cooper|land rover|range rover|bugatti|mclaren|datsun|buick|lincoln|jaguar|maserati|bentley|rolls)\b", EX_PART + r"|bike|motor ?cycle|bus\b|truck|tractor|train|tram|cart\b|wagon wheel|carriage|kart", 160),
    "truck": (["vehicle"], r"\b(truck|lorry|bus|forklift|tractor|excavator|bulldozer|loader|dumper|dump truck|crane|tanker|semi|fire ?truck|ambulance|garbage|cement mixer|backhoe|digger|tow truck|van)\b", EX_PART, 120),
    "bike": (["vehicle", "sports equipment"], r"\b(bike|bicycle|motorcycle|motorbike|scooter|vespa|moped|chopper|harley|ducati|bmx|tricycle|segway)\b", r"part|wheel|seat|helmet|lock|pump|rack|chain|pedal|handlebar|frame|light|toy|lego|tire|tyre", 90),
    "train": (["vehicle"], r"\b(train|locomotive|wagon|tram|streetcar|railcar|boxcar|tank car|carriage|subway|metro|freight car|caboose|hopper)\b", r"part|wheel|seat|toy|lego|track piece|sign|bogie|coupler|axle", 60),
    # airport and the carrier
    "plane": (["aircraft or spacecraft"], r"\b(plane|airplane|aeroplane|jet|airliner|boeing|airbus|cessna|fighter|bomber|biplane|aircraft|piper|douglas|lockheed|concorde|737|747|777|a320|a380|mig|spitfire|mustang|corsair|hornet|tomcat|harrier|warthog|f-?\d\d|su-?\d\d|dc-?\d|seaplane|glider|trainer|propeller plane|cargo plane|private jet|learjet|mitsubishi zero|zero|stuka|messerschmitt|hurricane|p-?\d\d|b-?\d\d|blackbird|raptor)\b", r"part|engine|wing\b|propeller\b|seat|cockpit|wheel|landing gear|toy|paper|drone|lego|turbine|missile|bomb|rocket|interior|blade", 160),
    "heli": (["aircraft or spacecraft"], r"\b(helicopter|chopper|heli|apache|black hawk|blackhawk|chinook|huey|osprey|gyrocopter)\b", r"part|toy|rotor blade|drone", 50),
    "space": (["aircraft or spacecraft"], r"\b(rocket|shuttle|capsule|lander|space ?ship|spaceship|spacecraft|satellite|probe|rover|apollo|soyuz|saturn|falcon|module|space station|lunar)\b", r"part|toy|engine|nozzle|interior|ufo|drone|seat|panel", 80),
    # waterfront
    "boat": (["watercraft"], r"\b(boat|yacht|ship|sailboat|canoe|kayak|ferry|tug|tugboat|barge|dinghy|trawler|speedboat|vessel|catamaran|gondola|raft|schooner|cruiser|fishing|galleon|frigate|destroyer|battleship|steamboat|riverboat|lifeboat|rowboat|pontoon|houseboat|sloop|junk|cutter|launch|motorboat|jet ?ski|submarine|ark|carrier)\b", r"part|oar|paddle|propeller|anchor|rudder|engine|wheel|seat|toy|lego|interior|bottle|helm|steering|sail\b|mast", 160),
    "pierprop": (["watercraft", "garden or outdoor", "container", "machine or industrial"], r"\b(anchor|buoy|bollard|cleat|life ?ring|lifebuoy|lifebelt|oar|paddle|propeller|net|lobster trap|crab pot|rope|winch|capstan|lighthouse|dock|pier|mooring)\b", r"toy|lego|icon", 80),
    # the park
    "bench": (["garden or outdoor", "furniture"], r"\b(bench|picnic table|park bench|garden bench)\b", r"press|work ?bench|weight|lab|piano|toy", 70),
    "playground": (["garden or outdoor", "toy or game", "sports equipment"], r"\b(swing|slide|seesaw|see-saw|playground|sandbox|sand box|climbing|carousel|merry|jungle gym|monkey bars|spring rider|rocking horse|play ?house|trampoline|teeter)\b", r"door|toy car|lego|miniature|card|pin", 70),
    "parkdecor": (["garden or outdoor", "architectural element", "building"], r"\b(fountain|statue|sculpture|gazebo|pergola|bird ?bath|sundial|planter|urn|obelisk|monument|bust|pavilion|bandstand|arbor|trellis|totem|well|bridge|lantern|bollard|garden lamp|post lamp)\b", r"toy|miniature|lego|drinking|interior|chess", 110),
    "statue": (["architectural element", "garden or outdoor", "building", "weapon or armour"], r"\b(statue|sculpture|bust|monument|memorial|angel|lion|horse|equestrian|knight|soldier|venus|david|goddess|god|figure|cherub|obelisk|fountain|gargoyle|griffin|eagle)\b", r"toy|lego|icon|logo|miniature|keychain|chess|pin\b", 120),
    "garden": (["garden or outdoor"], r".", r"toy|lego|miniature|icon|logo", 200),
    "sport": (["sports equipment"], r"\b(hoop|basketball|goal|net|soccer|football|baseball|tennis|ball|bike|bicycle|skateboard|scooter|ski|surfboard|kayak|golf|bat|racket|racquet|dumbbell|kettlebell|weights|bench|treadmill|punching|boxing|hockey|helmet|glove|cone|hurdle|trophy|frisbee|kite|volleyball|ping ?pong|table tennis|pool table|bowling|rowing|exercise|gym|pull-?up|barbell|stationary)\b", r"icon|logo|card|pin\b", 160),
    "toy": (["toy or game"], r"\b(kite|ball|hoop|wagon|scooter|teddy|bear|doll|rocking|horse|robot|car|truck|train|plane|boat|dinosaur|blocks|puzzle|game|chess|board|dice|top|yoyo|yo-yo|drum|duck|bucket|spade|castle|figure|action|plush|puppet|toy)\b", r"icon|logo|lego piece|token|card\b", 160),
    "animal": (["animal gear"], r".", r"icon|logo", 88),
    # rail yard / industrial / construction / salvage
    "machine": (["machine or industrial"], r"\b(generator|compressor|pump|engine|lathe|press|transformer|boiler|tank|turbine|motor|machine|welder|mill|drill|crane|conveyor|robot|excavator|forklift|silo|furnace|reactor|valve|pipe|hvac|air conditioner|cooling|chiller|ventilat|fan|winch|hoist|cement|mixer|loader|power box|electrical box|substation|dynamo|piston)\b", r"icon|logo|toy|lego|screw\b|bolt\b", 200),
    "freight": (["container", "packaging"], r"\b(container|crate|barrel|drum|pallet|tank|dumpster|skip|bin|cask|keg|chest|box|carton|sack|bag|bale|tote|canister|jerrycan|cylinder|tub|bucket|basket|trunk|cage|spool|reel)\b", r"icon|logo|toy|jewel|lunch|music|pencil|matchbox|cigar|ring box|shoe", 200),
    "tool": (["hand tool", "power tool"], r"\b(shovel|spade|pickaxe|pick|sledge|hammer|wheelbarrow|ladder|toolbox|tool box|saw|drill|axe|crowbar|rake|hoe|trowel|level|jackhammer|grinder|wrench|vise|vice|anvil|workbench|sawhorse|clamp|chainsaw|mower|cart|trolley|hand truck|dolly|generator|compressor|tool chest|bucket)\b", r"icon|logo|toy|lego|key\b", 200),
    "hardware": (["fastener or hardware"], r".", r"icon|logo", 160),
    "arch": (["architectural element"], r"\b(column|pillar|capital|arch|door|doorway|gate|window|balustrade|baluster|railing|fence|statue|fountain|cornice|corbel|pediment|portal|bench|lamp|lantern|bollard|stairs|staircase|fireplace|mantel|urn|vase|bust|relief|gargoyle|frieze|pilaster|newel|obelisk|well|planter|chimney|shutter|dome|spire|tower|bell)\b", r"icon|logo|toy|lego|joint|detail|section|plan|cill|rebar", 200),
    "smallbuilding": (["building"], r"\b(kiosk|booth|shed|gazebo|pavilion|hut|cabin|tent|garage|stall|stand|shack|outhouse|bus stop|shelter|phone booth|telephone box|news ?stand|food truck|cart|container house|guard ?house|toll|ticket)\b", r"icon|logo|toy|lego|miniature", 90),
    "armour": (["weapon or armour"], r"\b(armor|armour|helmet|shield|sword|cannon|catapult|trebuchet|ballista|knight|suit of|gauntlet|breastplate|spear|halberd|axe|mace|bow|crossbow|lance|mortar|howitzer|tank|artillery)\b", r"icon|logo|toy|lego|bullet|ammo|magazine|scope|grenade|knife", 160),
    "science": (["measuring instrument"], r".", r"icon|logo", 160),
    # markets and sidewalk displays outside shops
    "produce": (["food and drink"], r"\b(apple|banana|orange|lemon|lime|pear|peach|plum|grape|grapes|melon|watermelon|pumpkin|squash|tomato|potato|onion|carrot|cabbage|lettuce|broccoli|corn|pepper|eggplant|cucumber|avocado|pineapple|coconut|mango|cherry|strawberry|berries|fruit|vegetable|bread|loaf|baguette|croissant|cheese|egg|eggs|fish|salmon|mushroom|garlic|radish|beet|kiwi|papaya|bun|cake|pie|donut|doughnut|honey|jar|jam|sausage|ham|meat|nuts|walnut|peanut|basket)\b", r"icon|logo|toy|lego|plush|fake", 200),
    "packaged": (["packaging", "food and drink"], r"\b(can|bottle|box|carton|bag|jar|pack|packet|tin|crate|case|soda|juice|milk|cereal|chips|snack|candy|chocolate|cookie|coffee|tea|water|beer|wine|sauce|ketchup|mustard|soup|noodle|rice|flour|sugar|oil)\b", r"icon|logo|toy|lego", 200),
    "lighting": (["lighting"], r"\b(lamp|lantern|chandelier|pendant|sconce|floor lamp|desk lamp|table lamp|light|bulb|spotlight|floodlight|torch|candelabra|neon|led)\b", r"icon|logo|toy|lego|switch|socket|plug", 200),
    "kitchen": (["cookware", "kitchen appliance", "tableware"], r"\b(pot|pan|wok|skillet|kettle|stock ?pot|pressure cooker|steamer|colander|mixer|blender|toaster|microwave|oven|stove|range|fryer|grill|griddle|fridge|refrigerator|freezer|espresso|coffee|dish|plate|bowl|cup|mug|glass|tray|platter|teapot|pitcher|jug|cutting board|knife block|rack|shelf|cart|chopper|slicer|scale)\b", r"icon|logo|toy|lego", 200),
    "furniture": (["furniture"], r"\b(chair|armchair|sofa|couch|table|desk|dresser|cabinet|bookcase|bookshelf|shelf|stool|bench|lamp|wardrobe|chest|drawer|nightstand|sideboard|bed|ottoman|rocking chair|recliner|mirror|trunk|bar cart|vanity|hutch|credenza|console)\b", r"icon|logo|toy|lego|leg\b|knob|handle|doll", 200),
    "appliance": (["home appliance", "kitchen appliance"], r"\b(fridge|refrigerator|freezer|washer|washing machine|dryer|dishwasher|stove|oven|range|microwave|air conditioner|ac unit|heater|radiator|fan|vacuum|water heater|boiler|dehumidifier|humidifier|television|tv|iron|sewing machine|mixer|blender|toaster|coffee)\b", r"icon|logo|toy|lego|remote|knob", 160),
    "electronics": (["electronics"], r"\b(tv|television|monitor|computer|laptop|phone|radio|speaker|camera|console|arcade|jukebox|stereo|boombox|amplifier|turntable|record player|keyboard|printer|projector|tablet|headphones|walkman|vcr|vhs|cassette|tape|game ?boy|nintendo|playstation|xbox|atari|server|router|clock radio|crt)\b", r"icon|logo|toy|lego|cable|plug|chip|resistor|capacitor|board\b", 200),
    "music": (["musical instrument"], r".", r"icon|logo|toy|lego|pick\b|string\b|note", 200),
    "stationery": (["stationery"], r"\b(book|books|globe|typewriter|desk|lamp|notebook|pen|pencil|ink|quill|paper|letter|envelope|map|scroll|stamp|calculator|clipboard|binder|folder|crayon|marker|easel|chalkboard|blackboard|whiteboard|bookend|magazine|newspaper)\b", r"icon|logo|toy|lego", 160),
    "bath": (["bathroom fixture", "medical or personal care"], r"\b(bathtub|bath|tub|toilet|sink|basin|shower|faucet|tap|mirror|cabinet|wheelchair|walker|crutch|stretcher|hospital bed|scale|first aid|medicine|pill|bottle|soap|towel|razor|perfume|hair dryer|toothbrush|comb|brush)\b", r"icon|logo|toy|lego", 160),
}


# entry labels (the sand3d classifier's noun) that define a kind; kinds not listed match by title
ENTRIES = {
    "car": "pickup suv sedan coupe van jeep roadster hatchback police_sedan supercar patrol_car offroader racer caravan formula_car scout_car ambulance limousine taxi minivan convertible muscle_car hot_rod station_wagon",
    "truck": "truck bus forklift excavator loader tractor coach cargo_truck armored_truck fire_engine trailer dump_truck crane tanker garbage_truck tow_truck bulldozer",
    "bike": "scooter bicycle motorcycle sportbike tricycle moped chopper",
    "train": "locomotive railcar tram train wagon coach trolley",
    "plane": "biplane fighter airliner jet aircraft airplane bomber floatplane triplane turboprop trainer monoplane flying_boat seaplane trijet transport_aircraft transport_plane delta_jet stealth_aircraft stealth_jet glider sailplane spaceplane interceptor",
    "heli": "helicopter gunship tiltrotor",
    "space": "rocket satellite spacecraft shuttle capsule lander probe orbital_station shuttle_stack",
    "boat": "rowboat sailboat boat canoe workboat skiff motorboat tugboat launch riverboat kayak raft longboat schooner yacht speedboat fishing_boat dinghy inflatable_boat runabout patrol_boat ship steamship freighter liner cargo_ship gondola canopy_boat jetski warship battleship destroyer frigate submarine cruiser carrier sailing_ship galleon",
    "bench": "bench stone_bench picnic_table",
    "playground": "playground swing swingset swings seesaw slide roundabout ferris_wheel",
    "parkdecor": "fountain well planter pergola pedestal urn gazebo pavilion flowerpot stone_basin shrine monument roofed_well parasol umbrella",
    "smallbuilding": "kiosk police_box booth shed hut cabin pavilion shelter tent",
    "machine": "generator turbine transformer motor engine pump compressor petrol_pump press conveyor crane hopper industrial_machine mixer blower tank gearbox reactor robot_arm waterwheel",
    "arch": "column pillar capital archway doorway gateway stone_arch arch corbel cornice relief_panel carved_panel monument portal fireplace pedestal medallion rosette arcade",
}


# reviewed: ids removed from the curated show pools by hand (wrong thing, broken, toy-like)
DENY = {
    "carShow": ["43819752da2e4346a8696f4e8802a1f7", "4c598f2e082641859302cb8c3dcc574a", "ba5f5b3cacfe42c08c124dd9eaaf04ec", "cbbc3f816f1d4b69add0fefe42841e21", "cf9674e0683f4ce8967a79e427c92696", "9290aaf3fd674d83be3fd39ec45e1147"],
    "planeStand": ["c6de9fbf908a4dbdbde01cfe8dce46f3", "2956c1941f8a46b49b2b63f9737a7f99", "61c20b71d03f4257b776adcc2a199a92", "761a094f337945e48182b3f28a3e5183", "8a0db178ad7b4abc85fdc591343b99a6"],
    "deckPlane": ["549d866df6234132b10d0b793b582a3a", "cbdd1de6ced9461e950eafaa302cc82b", "98100f320d5643959ea31a884e1c9949", "0e90c091e56142048fc914ef1c81f93d", "1cc09357eb9a42c484d37f0e2c196ac4", "812c970a305a4a43a4e94d02b81d4db4", "2956c1941f8a46b49b2b63f9737a7f99", "25ce995ec8364b4c90a68eb15f58f283", "7ebf054f2e8e40deaf45e35132680bf6", "ce33a0986ffe4ae9a3af5f30d819a4da", "054e06c1342540d99cd6752e6d65634e", "f51a9bbecbf74c3294b88abd55a1de34", "0061ff00a6654020bcbf3b2be53affca", "d67ba5b3c80044679192e855169cf6cd", "303d3e5b8d544653bfde45189ca10c73", "38b20212d77844b6af9303e55002c66c", "7464d109c8c345c9b6da2973795bd58a", "99d97b0a2b314bd1a8b9d741e77e1e92", "b90013de71ac4dee9e275c225f5ef1a6"],
    "statueShow": ["c884ddc890fb493991bfa1edda0cff35", "1d2963b70e0c4d88ab038fe74be9e898", "ee565d645c764dac868a49ac7425781b", "10b6c79dbafc4627a0610ca3bcf426b8", "51798d1dd7db4eb49e979e66474a053c"],
}

# titles that are not a plausible real object for an outdoor showcase: sci-fi, game/fantasy art,
# abstract or placeholder names, parts and kits, toy/miniature versions of big things
JUNK = re.compile(r"sci-?fi|scifi|space ?ship|starship|star ?wars|tie[ -]fighter|x-?wing|gundam|\bmech\b|alien|ufo|fantasy|cartoon|\btoon\b|stylized|stylised|voxel|minecraft|fortnite|roblox|pixel|low[ -]?poly test|\btest\b|untitled|\bwip\b|\bobject ?\d|\bmodel ?\d|\bproject\b|asset|\bpart\b|\bkit\b|\bpiece\b|\btoy\b|lego|miniature|\bmini\b|keychain|paper|origami|\bnerf\b|\bfan ?art|\bconcept\b|\bsketch|\bscan ?\d|^\W*\d+\W*$|^.{0,3}$|^[a-z]{1,4}\d+", re.I)
# showcase pools for the most visible slots: only titles that name the real thing
SHOW = {
    # (base pool, title regex, allowed entry labels or None)
    "carShow": ("car", r"\b(toyota|bmw|audi|mercedes|benz|ford|mustang|chevrolet|chevy|camaro|corvette|porsche|ferrari|lamborghini|tesla|volkswagen|vw|beetle|golf|nissan|honda|mazda|subaru|hyundai|kia|volvo|lexus|dodge|jeep|cadillac|lincoln|buick|fiat|mini cooper|land rover|range rover|jaguar|maserati|bentley|rolls|datsun|peugeot|renault|citroen|opel|skoda|alfa|aston|mclaren|bugatti|saab|sedan|coupe|hatchback|suv|pickup|convertible|roadster|taxi|police car|muscle car|sports car|car)\b", None),
    "planeStand": ("plane", r".", "airliner jet trijet transport_aircraft transport_plane turboprop airplane"),
    "deckPlane": ("plane", r".", "fighter interceptor stealth_jet stealth_aircraft jet bomber monoplane"),
    "fountainShow": ("statue", r"\bfountain\b", "fountain tiered_fountain basin pedestal pedestal_bowl pedestal_dish stone_basin"),
    "statueShow": ("statue", r"\b(statue|sculpture|bust|monument|memorial|angel|lion|equestrian|obelisk|cenotaph)\b", None),
}


def original_folder(oid, OG):
    if not oid.startswith("objaverse-"):
        return 0
    path = OG.get(oid[len("objaverse-"):])
    return int(path.split("/")[1].split("-")[1]) if path else 0


def main():
    rebuilt = set(json.load(open(os.path.join(ROOT, "public", "rebuilt", "index.json"))))
    ogp = os.path.join(HERE, ".cache", "objaverse-paths.json.gz")
    OG = json.load(gzip.open(ogp)) if os.path.exists(ogp) else {}
    rx = {k: (set(f), re.compile(inc, re.I), re.compile(exc, re.I), n) for k, (f, inc, exc, n) in KINDS.items()}
    ents = {k: set(v.split()) for k, v in ENTRIES.items()}
    cand = {k: [] for k in KINDS}
    with open(IDX) as fh:
        for line in fh:
            r = json.loads(line)
            ds, split, row, oid, fam, entry, title, author, url, lic, path, nbytes, f, joints = r[:14]
            if ds != "objaverse" or f < 0.8 or nbytes > 8e6 or nbytes < 4000:
                continue
            text = f"{title} {entry.replace('_', ' ')}"
            junk = bool(JUNK.search(title.strip()))
            for k, (fams, inc, exc, n) in rx.items():
                if fam not in fams or exc.search(title) or junk:
                    continue
                if (entry in ents[k]) if k in ents else inc.search(text):
                    cand[k].append(r[:14])
    out = {}
    ranked = {}
    rnd = random.Random(2026)
    for k, rows in cand.items():
        rnd.shuffle(rows)
        rows.sort(key=lambda r: (r[3] not in rebuilt, original_folder(r[3], OG) == 0, -round(r[12], 2)))
        ranked[k] = rows
        keep = rows[: KINDS[k][3]]
        out[k] = [r + [original_folder(r[3], OG)] for r in keep]
        print(f"{k:14s} {len(rows):5d} candidates, kept {len(keep):4d}, rebuilt {sum(r[3] in rebuilt for r in keep):3d}  e.g. {[r[6][:22] for r in keep[:6]]}")
    for k, (base, inc, ents_ok) in SHOW.items():
        r = re.compile(inc, re.I)
        eok = set(ents_ok.split()) if ents_ok else None
        deny = set(DENY.get(k, []))
        keep = [row + [original_folder(row[3], OG)] for row in ranked[base] if r.search(row[6]) and row[3][len("objaverse-"):] not in deny and (eok is None or row[5] in eok)][:80]
        keep = [row for row in keep if row[14]]
        out[k] = keep
        print(f"{k:14s} {len(keep):4d} curated from {base}")
    if os.environ.get("REVIEW"):
        for k in os.environ["REVIEW"].split(","):
            for row in out[k]:
                print(f"  {k}: {row[3]}  {row[6]!r}  [{row[5]}]")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w"), separators=(",", ":"), ensure_ascii=False)
    print("wrote", OUT, os.path.getsize(OUT) // 1024, "KB")


if __name__ == "__main__":
    main()
