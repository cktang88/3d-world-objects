# Lighting, sky, time of day — research notes

Owner: lighting agent (`src/lighting.ts`, renderer/post parts of `src/main.ts`, `src/lab/light-*.ts`).

## Reference photos (Wikimedia Commons, looked at side by side with lab shots)

| look | image | what to copy |
|---|---|---|
| golden hour, Union Sq | https://commons.wikimedia.org/wiki/File:Golden_Hour,_Union_Square_(51399162049).jpg | Sun ~8-12° up: **street level is already in shadow** (cool, blue-grey), only the upper floors and tower tops are lit a saturated orange (#e08040-ish on brick). Sky still blue overhead, warm salmon clouds near the sun. Strong contrast between lit tops and shaded canyon. |
| golden hour, Madison Sq / Met Life | https://commons.wikimedia.org/wiki/File:Golden_Hour_Madison_Square_(51150483970).jpg, https://commons.wikimedia.org/wiki/File:Met_Life_Golden_Hour_(51952638107).jpg | Lit stone goes peach/orange; shadowed facades take the blue sky colour. Glass towers mirror the sky. |
| sunset down a street (dusk) | https://commons.wikimedia.org/wiki/File:Sunset_on_First_Avenue_(51246145204).jpg, https://commons.wikimedia.org/wiki/File:Second_Avenue_Sunset_(51644263897).jpg | The grid frames the sky; pink/orange clouds; buildings near-silhouette, storefront signs and traffic signals start to read as light sources. |
| wet night, 8th Av / 34th St | https://commons.wikimedia.org/wiki/File:34th_Street_Night_(51985985844).jpg | **Modern NYC street lights are LED, white ~4000 K**, not sodium orange (the city replaced ~250k cobra heads with LED 2013-2019). Wet asphalt is near black with long vertical streaks of every light source (neon blue/red/green store bands, signals). Fog/steam glows. Upper office windows lit cool white in grids; apartments warm. Sky is a dark brown-grey (light pollution), never black, no stars. |
| rain at night | https://commons.wikimedia.org/wiki/File:Barclays_Center_Rain_Night.jpg, https://commons.wikimedia.org/wiki/File:Cyclist_riding_passengers_on_a_street_in_the_rain_at_night_in_New_York_City,_U.S.A.jpg | Reflections are blurred vertically (rough wet surface), puddles are sharper mirrors; bloom around every light. |
| Midtown night | https://commons.wikimedia.org/wiki/File:Manhattan_at_night_north_of_Rockefeller_Center_(11226).jpg | ~30-50 % of windows lit at 9pm; mix of warm (2700 K) and cool (4000-5000 K) rooms; towers have lit crowns. |
| blue hour skyline | https://commons.wikimedia.org/wiki/File:Lower_Manhattan_from_Brooklyn_May_2015_panorama.jpg | Deep blue sky (#2a3c78 → #6a7ab0 at horizon) with warm window grids: the classic complementary blue/orange. |
| overcast | https://commons.wikimedia.org/wiki/File:Flatiron_Building,_New_York_City,_November_2011.jpg | Soft, shadowless, desaturated; sky white-grey and brighter than the facades. |

Museum / shop lighting (from the Poly Haven indoor HDRIs below, which are photographs of real rooms):
`sculpture_exhibition` — white walls, skylights + track spots, floor brighter near walls;
`museum_of_ethnography` — warm halogen display cases; `phone_shop` — even cool fluorescent
retail light (~4000 K), bright ceiling troffers, glossy floor reflecting them;
`decor_shop`/`comfy_cafe` — warm 2700 K pendants. Galleries: 150-300 lux ambient (low for
works on paper), accent spots 3-5x brighter on the work; retail: 500-1000 lux general.

## HDRIs chosen (Poly Haven, CC0, streamed from dl.polyhaven.org with CORS)

| use | id | why |
|---|---|---|
| day | `docklands_02` | clear sky with a visible sun, modern glass/office buildings at the horizon, urban paving |
| golden hour | `venice_sunset` | low warm sun near the horizon, blue zenith |
| dusk / blue hour | `sunset_jhbcentral` | rooftop view over a city at twilight: pink clouds, city skyline at the horizon |
| night | `shanghai_bund` | skyline of lit towers + light-polluted sky, neon colours for reflections |
| museum | `sculpture_exhibition` | white-walled gallery with skylights |
| shop | `phone_shop` | fluorescent retail interior |
| apartment interiors | `lebombo` | daylight through big windows in a plain room |

Other candidates looked at: canary_wharf, potsdamer_platz (overcast), hamburg_canal,
rooftop_night, hansaplatz, neuer_zollhof, modern_buildings_night, st_fagans_interior,
hall_of_mammals, decor_shop, comfy_cafe, gear_store.

## Techniques (three.js r170) and decisions

- **HDRI image-based light**: `RGBELoader` (HalfFloat) → `PMREMGenerator.fromEquirectangular`
  for `scene.environment`, raw equirect as `scene.background`. On load we analyse the pixels:
  median sky radiance, the sun as the weighted centroid of the brightest pixels, the mean
  horizon colour. The sun is **clamped out** of the image (cap = k x median) so the
  directional light provides it once (no double sun). Intensity is **normalised** so the upper
  sky has a chosen radiance per time of day (HDRIs have arbitrary absolute scale).
  `scene.environmentRotation`/`backgroundRotation` (r162+) rotate the HDRI so its sun sits at
  the azimuth we want for the street grid (235° — diagonal shadows across both streets and
  avenues), keeping the visible sun, reflections and shadows consistent.
- **Tone mapping**: ACES Filmic skews bright saturated colours (orange sun → yellow, blue neon →
  cyan) and crushes. **AgX** (Blender 4 default) handles high dynamic range and saturated
  lights gracefully; Khronos **Neutral** keeps albedo accurate but clips harder. Chosen: AgX
  with a small grading pass to restore contrast/saturation (`?tm=aces|agx|neutral` to compare).
- **Colour grading**: instead of LUT files (LUTPass + .cube), a tiny ShaderPass after
  OutputPass: gain (white balance), lift (shadow tint), saturation, contrast, vignette and
  1/255 dither. Per time-of-day values.
- **Cascaded shadow maps**: `three/examples/jsm/csm/CSM.js`, 3 cascades x 2048 (2 x 1024 on
  low), practical split, fade between cascades, max distance 260 m: crisp contact shadows
  near the player, tower shadows across the street far away. CSM needs every lit material
  flagged (`USE_CSM` define + uniforms) or each cascade light lights it fully, so lighting.ts
  scans the scene each frame and wraps new materials (chaining any existing onBeforeCompile,
  sharing one set of uniform objects). Per-cascade normalBias grows with texel size.
- **Atmospheric perspective**: `FogExp2` whose colour is the HDRI's own horizon colour x the
  same intensity normalisation, so distant blocks melt into the sky behind them.
- **Bloom**: UnrealBloom threshold is in scene-linear units before tone mapping; high
  threshold by day (only the sun glints), low at night (signals, signs, lamps, windows).
- **Night**: global night factor (`getNight()`); instanced window glass gets a hashed share of
  lit panes (warm gradient, a few cool TV-lit rooms) via onBeforeCompile; emissive-mapped
  signs/shop windows and lamp heads are boosted; 8 pooled SpotLights follow the nearest
  street lamps and an additive light-pool decal sits under every lamp further away; the road
  gets a wet shader (darker albedo, glossy puddles from world-space noise) so env and lamp
  speculars streak across it.
- **Screen-space reflections** (SSRPass) were considered for wet streets: expensive, noisy with
  MSAA + GTAO, and the three r170 pass only reflects what is on screen. Not used; glossy
  wet roughness + env reflections + real lamp speculars gets most of the look.
- **Light probes / lightmaps**: interiors are procedural and change per visit, so baking is not
  practical; indoor HDRIs give believable ambient + reflections, GTAO adds contact darkening.

## What was built (src/lighting.ts) and how it compares

- Presets live in `PRESETS` (day / golden / dusk / night): HDRI, sun azimuth (235° day, so shadows
  cut diagonally across streets and avenues), sun colour/intensity, sky radiance after
  normalisation, HDRI saturation (`envSat`), exposure, a warm **bounce** hemisphere fill (stands in
  for light reflected off sunlit facades; without it shaded sidewalks read sky-blue instead of the
  grey of the photos), fog density/tint, night factor, lit-window share, wetness, bloom, grade.
- `T` cycles time of day (Shift+T backwards), `?tod=day|golden|dusk|night` sets it, `?tm=` picks
  the tone mapper, `?notex=1`/`?nohdri=1` skip HDRI downloads.
- Hooks other modules use: `getNight()`, `getTimeOfDay()`, `onTimeChange()`,
  `litWindows(material)` (nyc.ts window glass), `wetSurface(material, k)` (nyc.ts road;
  sidewalks are wrapped by lighting.ts itself), `streetLightMarker()` (streetprops.ts lamp posts),
  `setWeather({ sunMul, skyMul, fogMul, fogColor, fogMix, wet, cloud })` for src/weather.ts.
- Cascades re-render staggered (near every frame, middle every 2nd, far every 3rd).
- Compared with the references: golden hour matches the low-sun / long-shadow / warm-sky look
  (street level in shade, sun glow down the grid); dusk gives the blue-hour sky with pink cloud and
  warm window grids; night gives dark blue-grey sky, ~35 % lit warm windows, glowing shop fronts,
  lamp pools and streaked wet asphalt. Still missing vs the wet-night photos: true mirror
  reflections of storefront colours in puddles (needs SSR or a planar reflector).
