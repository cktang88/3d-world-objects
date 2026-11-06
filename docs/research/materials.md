# Materials research: how sand3d kinds should look, and how to render them in real time

Owner: materials agent (`src/materials.ts`, `src/pbr.ts`, `scripts/fetch_pbr.py`, `scripts/rebuild.py`, `src/lab/mat-*.ts`).

sand3d names every material by kind (`oak__6e4a32`, `brushed_steel #9aa0a6 roughness=0.35`). Over
600 rebuilt GLBs the kinds and sand3d's own parameters are (count, median roughness, metalness):

| kind | n | rough | metal | note |
|---|---|---|---|---|
| plastic | 333 | 0.50 | 0 | most common; colours from near-black to white |
| painted_metal | 269 | 0.40 | 0 | paint colour is the sand3d colour |
| steel | 194 | 0.30 | 1 | colour often dark grey (0.04–0.3 linear): blackened / oxidised parts |
| oak | 62 | 0.55 | 0 | | 
| walnut | 48 | 0.45 | 0 | |
| aluminium | 47 | 0.40 | 1 | also used by remote.ts for CAD parts with no material |
| rubber | 34 | 0.90 | 0 | |
| concrete, fabric | 23, 20 | 0.85 | 0 | |
| brass, brushed_steel, ceramic, leather, birch, chrome, glass, pine, glossy_plastic, copper | ≤19 | | | ceramic 0.15 (glazed) or 0.6–0.7 (bisque) |

So sand3d's roughness is essentially a per-kind default; the kind name carries most of the information.
Plastic, painted metal and steel cover ~75% of all parts and matter most.

## Reference photos (looked at, downloaded to the scratchpad)

- Wood species board, 16 samples — https://commons.wikimedia.org/wiki/File:16_wood_samples.jpg
- Oak — https://commons.wikimedia.org/wiki/File:Oak_Texture_-_5106733699_c1d5b0df29_b.jpg
- Walnut — https://commons.wikimedia.org/wiki/File:Texture_de_noyer.jpg
- Brushed stainless (render, but a good anisotropy reference) — https://commons.wikimedia.org/wiki/File:Brushed_316_Stainless_Steel_Lettering.png
- Unpainted stainless body panels, DeLorean — https://commons.wikimedia.org/wiki/File:De_Lorean_DMC-12_at_Wollaton_Park,_Nottingham,_England.jpg
- Brass door handle (worn, polished where touched) — https://commons.wikimedia.org/wiki/File:A_detailed_view_highlights_a_brass_door_handle_attached_to_a_white_wooden_door.jpg
- Old copper saucepan (oxidised red-brown, darker in recesses) — https://commons.wikimedia.org/wiki/File:Copper_saucepan.JPG
- Ceramic glaze test tiles (glossy vs matte glaze over terracotta bisque) — https://commons.wikimedia.org/wiki/File:Vzorkovn%C3%ADk_glazur.JPG
- Carrara marble, with 10 mm scale bar — https://commons.wikimedia.org/wiki/File:Carrara_marble_CD.jpg

What they show, per kind (close up → at a distance):

- **Oak**: open, coarse grain; cathedral arches on flat-sawn boards, straight lines on quarter-sawn; ray flecks; golden-tan (sRGB ~#b88a55). At a distance: mid-tan with faint parallel streaks. Furniture is usually lacquered: a sharp clear reflection over a rougher grain.
- **Walnut**: finer, closed grain, chocolate brown with grey-purple cast (#5a3a26), much less contrast than oak; satin oil finish.
- **Pine / birch**: pale, low-contrast; pine has strong orange latewood lines and knots; birch is almost featureless cream.
- **Brushed steel**: parallel micro-grooves; highlights smear into a streak *perpendicular* to the brushing direction; colour is neutral-to-warm grey, never pure white (stainless F0 ≈ 0.67/0.64/0.60 linear). Body panels at a distance read as a soft, slightly warm grey with broad blurry reflections.
- **Chrome**: a near-perfect mirror, slightly blue-cool (F0 ≈ 0.65/0.69/0.70); what you see is the environment; fingerprints/smudges show as hazy patches. Darker than silver.
- **Brass**: yellow metal (F0 0.91/0.78/0.42); polished where hands touch, duller and brown where it has tarnished, darkest in recesses.
- **Copper**: salmon-pink when fresh (F0 0.93/0.62/0.52), oxidises to red-brown then dark; very visible patina in recesses.
- **Painted metal / car paint**: a coloured diffuse base under a glossy clear layer: two highlights, a sharp one from the clearcoat, broad one from the base; orange-peel ripple; wear exposes grey metal on edges.
- **Plastic**: injection moulded parts are uniformly coloured, satin, slightly soft highlight, tiny surface mottling / sink marks; glossy plastic has a crisp highlight but no depth (not a clearcoat, but the look is close).
- **Ceramic glaze**: glass layer over a body: very sharp reflection + coloured base; glaze pools darker in recesses. Unglazed bisque/terracotta is matte.
- **Velvet**: dark where you look straight at it, a bright rim at grazing angles (the pile catches light) — the opposite of most materials. Fabric (linen/cotton) has a soft, low sheen and visible weave only very close.
- **Leather**: pebbled grain, satin waxy finish, lighter and shinier where worn (edges, seat fronts).
- **Marble**: white-grey with soft dark veins, polished = sharp reflection with slight subsurface glow.
- **Rubber**: dark, matte (rough 0.7–0.95), slightly dusty; low specular.
- **Glass**: transmission with Fresnel reflection, IOR 1.52; thick or tinted glass absorbs colour (Beer–Lambert), edges look darker/greener.

## Physical values used

From https://physicallybased.info (API: https://api.physicallybased.info/materials), linear RGB base colour of metals (F0):

| metal | F0 (linear) |
|---|---|
| aluminium | 0.916, 0.923, 0.924 |
| stainless steel | 0.669, 0.639, 0.598 |
| chromium | 0.654, 0.685, 0.701 |
| brass | 0.910, 0.778, 0.423 |
| copper | 0.932, 0.623, 0.522 |
| iron | 0.530, 0.513, 0.494 |

Dielectrics: plastics IOR 1.49–1.6 (PP 1.49, PVC 1.54, PC 1.58), glass 1.52, porcelain albedo ~0.75,
rubber tyre albedo ~0.02 and roughness ~0.7, marble albedo ~0.8.
Filament's material guide (https://google.github.io/filament/Materials.html) — dielectric albedo
50–240 sRGB, clear coat IOR 1.5, cloth model (sheen) for fabric/velvet.

## Real-time techniques

- **three.js MeshPhysicalMaterial** (https://threejs.org/docs/#api/en/materials/MeshPhysicalMaterial):
  `clearcoat`/`clearcoatRoughness` (second specular lobe on the geometric normal: lacquer, glaze,
  car paint), `sheen`/`sheenColor`/`sheenRoughness` (Charlie sheen, Estevez & Kulla 2017, the
  velvet/fabric grazing-angle glow), `anisotropy`/`anisotropyRotation` (KHR_materials_anisotropy:
  roughness stretched along the tangent; highlight stretches perpendicular to brushing),
  `iridescence` (thin film: soap, oil, heat-tinted steel — not needed by any sand3d kind),
  `transmission`/`thickness`/`attenuationColor` (glass; costs an extra opaque render pass),
  `specularIntensity`/`ior` (dielectric F0 — lower for cloth and rubber). Each feature is a shader
  define, so it only costs where enabled. Anisotropy needs a tangent frame: three builds it from
  `uv` derivatives, so for triplanar objects without UVs we supply our own `tbn`.
- **Triplanar normal mapping**: Ben Golus, "Normal Mapping for a Triplanar Shader"
  (https://bgolus.medium.com/normal-mapping-for-a-triplanar-shader-10bf39dca05a) — sample a
  tangent-space normal per projection, mirror u on negative faces, combine with the surface normal
  by *whiteout* blend (`vec3(tn.xy + n.zy, abs(tn.z) * n.x)`; UDN drops the z multiply), then swizzle
  into object space and blend by the triplanar weights. Used for all non-UV objects.
- **Bump from height without tangents**: Mikkelsen, "Bump Mapping Unparametrized Surfaces on the GPU"
  (https://mmikk.github.io/papers3d/mm_sfgrad_bump.pdf) — screen-space derivatives; used for the
  procedural micro-detail (a "detail normal") on top of the photo normal, faded by `fwidth`.
- **Hiding tiling**: Inigo Quilez, "Texture repetition" (https://iquilezles.org/articles/texturerepetition/)
  technique 3 — a low-frequency noise picks two random offsets, blend the two lookups (use
  `textureGrad` with the original derivatives to avoid mip seams). Heavier alternatives: Heitz &
  Neyret 2018 histogram-preserving hex tiling (https://eheitzresearch.wordpress.com/722-2/), Mikkelsen's
  hex-tiling (https://github.com/mmikk/hextile-demo). Plus a cheap macro-variation noise multiplier.
- **AO / curvature / edge wear baking**: Cycles can bake straight to colour attributes
  (`bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')`, https://docs.blender.org/manual/en/latest/render/cycles/baking.html);
  curvature from the mesh (vertex normal vs. neighbour directions, like Blender's *Dirty Vertex
  Colors*, https://docs.blender.org/manual/en/latest/sculpt_paint/vertex_paint/editing.html). Baked AO
  should only darken *indirect* light (as glTF `occlusionTexture` / three `aoMap` do), and should
  also occlude indirect specular (Lagarde & de Rousiers, "Moving Frostbite to PBR", 2014,
  https://seblagarde.files.wordpress.com/2015/07/course_notes_moving_frostbite_to_pbr_v32.pdf).
  Edge wear = convexity mask, broken up by a texture, revealing the underlying material (Substance
  "smart materials" approach, https://helpx.adobe.com/substance-3d-bake/bakers/curvature.html).
  Limitation: vertex colours interpolate across a face, so on low-poly parts the mask spreads over
  whole faces; a true edge mask needs a per-object lightmap UV + texture.
- **Dust**: deposit on upward-facing normals (`dot(n, up)`), lighter/greyer albedo, roughness → 1,
  modulated by AO/noise.

## Texture sources (CC0)

- Poly Haven (streamed from the CDN): oak_veneer_01, american_walnut_veneer, coated_pine, ash_veneer,
  rough_linen, velour_velvet, brown_leather, marble_01, concrete_floor_02 (+ architecture sets).
- ambientCG (repacked to WebP in `public/assets/materials/`): Metal011 (steel), Metal009 (brushed),
  Metal012 (aluminium), Metal049B (chrome smudges), Metal048B (brass, fingerprints), Metal058A (copper
  smudge), Metal029 (powder-coat paint), Plastic010, Plastic013B (glossy, scratched), Rubber004,
  Porcelain002. Pages: https://ambientcg.com/view?id=<id>.
