# People on NYC sidewalks — research

## Reference photos (looked at, not redistributed)

All free stock photos by Yuta / PAKUTASO, Manhattan, late winter / early spring:

| | URL | What it shows |
|---|---|---|
| P1 | https://www.pakutaso.com/shared/img/thumb/YATNY4M3A7531_TP_V.jpg (page: https://www.pakutaso.com/en/20230522130post-45993.html) | Busy Midtown sidewalk at dusk (W 36th St, Hilton Garden Inn). Puffer coats with fur-trimmed hoods, backpacks, shopping bags, two people looking at phones while walking. |
| P2 | https://www.pakutaso.com/shared/img/thumb/YATNY4M3A7525_TP_V.jpg (page: https://www.pakutaso.com/en/20230548128post-45987.html) | Crowd on 5th Ave at W 40th St. Almost all dark coats (black, navy, charcoal), beanies, crossbody bags, one camel coat; people about 0.5–1 m apart. |
| P3 | https://www.pakutaso.com/shared/img/thumb/YATNY4M3A7565_TP_V.jpg (page: https://www.pakutaso.com/en/20230354086post-46004.html) | Upper East Side residential avenue: few pedestrians, red long coat, green bomber + jeans + white sneakers, dog walker, tote bag. |
| P4 | https://www.pakutaso.com/shared/img/thumb/newyork4M3A7538_TP_V.jpg (page: https://www.pakutaso.com/en/20200326078post-26335.html) | Times Sq. side street: blue puffer, dark jackets, jeans, green sneakers, a person crossing mid-block. |
| P5 | https://www.pakutaso.com/shared/img/thumb/YATNY4M3A7560_TP_V.jpg (page: https://www.pakutaso.com/en/20230302082post-46003.html) | Single person in a black long coat waiting at a corner near the curb, facing the crossing. |
| P6 | https://www.pakutaso.com/shared/img/thumb/YATNY4M3A6926_TP_V.jpg (page: https://www.pakutaso.com/en/20230444102post-45981.html) | 5th Ave crosswalk: woman in a navy puffer with a hood, crossbody bag, red tote, ankle boots. |

## Takeaways we build to

**Proportions.** Real adults, not heroic ones: men ~1.76 m, women ~1.62 m (US averages), ±6 %. Heads ~1/7.5 of height. Shoulders of ordinary people are narrower than the Quaternius "Superhero" base meshes, so the clothing layer (puffers, coats) hides most of the muscle, and the rig is scaled to these heights.

**Clothing palette (cold season, which is what all the photos show).** Overwhelmingly dark: black, charcoal, navy, dark olive, brown, with a few camel/tan and burgundy coats and the odd red or light-grey puffer. Garment mix seen in P1/P2:

- puffer jackets with horizontal quilted baffles, often hooded, satin-ish sheen (≈30 %)
- wool/tailored coats, open or closed, shirt or sweater visible at the neck (≈30 %)
- hoodies and bombers (≈15 %), sweaters (rest); t-shirts only in warm weather
- legs: blue jeans in several washes (most common), black jeans, dark trousers, khaki, black leggings (women)
- shoes: white sneakers with white soles (very common), black sneakers, black/brown boots
- hats: beanies (≈20 % in P2), a few caps

**Accessories.** Backpacks (≈20 %), crossbody bags across the front (≈15 %), totes / shopping bags carried in the hand, phones (several people at once are looking down at phones while walking or waiting), the odd dog.

**Poses and behaviour.**
- Walk speed ~1.3–1.5 m/s in Midtown (New Yorkers walk fast), arm swing relaxed, slight forward lean.
- Waiting at corners: stand 0.5–1.5 m back from the curb, facing the crossing, weight on one leg, many looking at phones (head tilted down, phone held at chest height in one or both hands).
- Groups of 2 talk facing each other, standing near building lines rather than the curb.
- Pedestrians pass each other with ~0.5–1 m clearance, drifting sideways rather than stopping.

## Asset choice

- Bodies + hair: **Quaternius — Universal Base Characters [Standard]**, CC0 (https://quaternius.com/packs/universalbasecharacters.html). Realistically proportioned (if muscular) male and female, 65-bone UE-style skeleton, PBR skin textures, 5 hairstyles + beard.
- Animation: **Quaternius — Universal Animation Library [Standard]**, CC0 (https://quaternius.com/packs/universalanimationlibrary.html). Same skeleton; we use Walk_Loop, Walk_Formal_Loop, Idle_Loop, Idle_Talking_Loop, Jog_Fwd_Loop, Sitting_Idle_Loop. Native walk speed 1.3 m per 1.333 s cycle (0.98 m/s), measured from the root-motion version.
- Rejected: Mixamo-derived files (three.js Xbot / Michelle / Soldier) — Mixamo licence does not allow redistribution as raw assets. Kenney / older Quaternius modular men — too stylised.
- No CC0 modern-clothing meshes for this skeleton exist, so clothes are painted on in the shader from the bind pose and inflated along the normal (see `src/nyc/people.ts`).

## What was built (src/nyc/people.ts)

- 84 pedestrians (`Pedestrians`), each a `SkeletonUtils.clone` of the male or female base with its own `AnimationMixer` (Walk_Loop or Walk_Formal_Loop, Idle_Loop, Idle_Talking_Loop). Walk cadence = speed / (0.98 m/s × body scale). Heights 1.76 m / 1.63 m ± 6 %.
- Clothes painted in the body shader from the bind-pose position: tee, sweater, quilted puffer, open coat with shirt V, hoodie; jeans (twill + thigh fading), trousers, shorts, leggings; belt / cuffs / hem bands. Cloth regions drop the skin normal map and are pushed out along the normal. The superhero build is slimmed in the vertex shader (arms, legs, shoulders, chest depth, neck, trapezius).
- Separate meshes: knee-length coat skirts skinned to pelvis + thighs, sneakers / boots on the foot bones (feet shrunk inside), hoods, beanies, backpacks with straps, crossbody bags, phones; Quaternius hair and beards on the head bone.
- Behaviour: walkers on sidewalk lines, keep right when meeting oncoming people, sidestep and slow for the player; people waiting at corners facing the crossing (idle, on the phone with head down, talking), then crossing; companions walking shoulder to shoulder or standing face to face.
- Perf: shared geometry, one body material per person (one shared program), 2.5k-triangle body LOD beyond 22 m, animation every 2nd / 4th frame beyond 25 / 50 m, shadows within 30 m. Whole crowd ≈ 0.66 M triangles, ≈ 520 meshes, ≈ 0.27 M shadow triangles.
