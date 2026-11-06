# Weather — research notes and design

Owner: weather agent (`src/weather.ts`, `src/lab/weather.ts`). Hooks into `src/lighting.ts` only
through its `setWeather()` API (owned by the lighting agent).

## References (Wikimedia Commons, looked at side by side with lab shots)

| look | image | what to copy |
|---|---|---|
| overcast, Flatiron | https://commons.wikimedia.org/wiki/File:Flatiron_Building,_New_York_City,_November_2011.jpg | Sky is a **bright white-grey, brighter than every facade**, with darker grey cloud masses showing some structure (not a flat fill). No cast shadows at all; facades lit evenly from above, colours desaturated. Distant buildings only slightly hazier than by day. |
| low cloud on a tower | https://commons.wikimedia.org/wiki/File:Skyscraper_in_Clouds_(Unsplash).jpg | Inside low cloud the tower **fades to white with height**: the lower floors are crisp, a few floors higher only the outline is left, then nothing. The fade is vertical (height fog / cloud base), not just with distance. |
| rain at night, 65th St | https://commons.wikimedia.org/wiki/File:Rainy_Night_65th_Street_(15265985954).jpg | Paving is a dark mirror: every light source is a **long vertical streak** in it; sharper in the puddles. Wet stone walls darken. The sky is a dark brown-grey, the tops of the towers dissolve in mist. Umbrellas everywhere (black, some coloured). Falling rain itself is barely visible except against lights. |
| rain at night (lighting.md) | https://commons.wikimedia.org/wiki/File:34th_Street_Night_(51985985844).jpg, https://commons.wikimedia.org/wiki/File:Cyclist_riding_passengers_on_a_street_in_the_rain_at_night_in_New_York_City,_U.S.A.jpg | Bloom/glow around lights in the wet air; streaks of rain visible in headlight and lamp cones. |
| snowstorm, 14th St / 3rd Av (Jan 2016) | https://commons.wikimedia.org/wiki/File:Snow_in_january_2016_in_New_York_City.jpg | Sky is uniform pale grey-white; **falling snow is a dense haze**: buildings one block away are already grey-blue, two blocks away nearly gone. Snow lies on **car roofs, hoods, sills, ledges and the kerbside**, the roadway is grey slush with tyre tracks, vertical walls stay dark. Flakes near the camera read as small white dots / short soft streaks. |
| after a snowstorm, Fifth Av (1905) | https://commons.wikimedia.org/wiki/File:Fifth_Avenue_after_a_snow_storm.jpg | Snow piled along the kerbs, every horizontal ledge and cornice outlined in white, facades darker by contrast. |

Typical numbers used:
- Rain drops fall at ~9 m/s (2 mm drop terminal velocity 6.5 m/s, 4-5 mm 9 m/s); a 1/40 s
  "exposure" gives streaks of ~20 cm, as seen in photos. Snow falls at ~1 m/s and wanders.
- Visibility: light rain 5-10 km, heavy rain 1-2 km (with haze), snowfall 0.5-1 km, fog < 1 km
  and ~200 m in thick fog. Low cloud bases over Manhattan in rain are 150-300 m — the tops of
  One Vanderbilt (427 m), the Empire State (381 m) and the Midtown slab towers (200-300 m) vanish.
- Overcast illuminance is ~10-20 % of a sunny day; a camera (and the eye) exposes up for it, so we
  lift the sky light a little instead of making the scene dark.

## Design

### Sky: cloud dome over the HDRI
Options considered: (a) blending clear / partly / overcast Poly Haven HDRIs — cheap but discrete
images, the sun position and city skyline jump between them, and only 3 states;
(b) full raymarched volumetric clouds — beautiful, 1-3 ms on a desktop GPU; (c) one cloud deck
at 1.5 km shaded as a thick 2D layer. Chosen: **(c)**, drawn over lighting.ts's HDRI by a
sphere around the camera at the far plane (only background pixels pay for it):
- density = 5-octave fbm from a 128² tileable value-noise texture, thresholded by cover; at
  cover > 0.8 an overcast floor fills the gaps (stratus);
- shading: one extra fbm sample towards the sun gives a lit side and a shaded side, thickness
  darkens the underside, forward scattering gives silver linings near the sun; rain clouds
  (`dark`) are darker and the sun no longer gets through; at night NYC lights the cloud base
  orange-brown;
- the horizon thins into the fog colour; at full overcast / fog the dome also fills below the
  horizon so the HDRI's own skyline melts into grey.
- The CPU evaluates **the same noise** along the sun ray (same texture data), so in partly
  cloudy weather the sun really goes in and out behind the clouds you see (sunMul low-passed).

### Reflections / ambient: PMREM from a composite
`scene.environment` is rebuilt from an equirect composite (the HDRI + the same clouds) through a
separate PMREMGenerator, **only when cover / darkness / fog changed noticeably (≥ 1.2 s apart) or
every 12 s for drift**. The composite has the HDRI's own width, so the PMREM has the same size as
lighting.ts's and no material recompiles (the CUBEUV defines depend on that size).

### Lighting hook
`setWeather({ cloud, sunMul, skyMul, fogMul, fogColor, fogMix, wet })` in lighting.ts (lighting
agent's API). Weather sends it only when values change. Cast shadows soften under thin cloud via
`light.shadow.intensity` on the CSM lights.

### Surfaces: wet, ripples, snow (global, uniforms only)
three's `lights_physical_fragment` chunk is prefixed with weather code, and the shared uniforms
are added to `ShaderLib.standard/physical`. Uniform values are **plain objects** (`{x,y,z,w}`,
`{elements}`, and the depth texture inside an array): `cloneUniforms` copies those by reference,
so one write reaches every standard material; no `onBeforeCompile`, no per-material work, no
recompiles when the weather changes. Code is behind `if (wxState.w > 0.5)` (off when dry).
- **wet**: diffuse darkens (porous rough materials most, metal/glass least), roughness drops to
  ~0.28x; vertical faces get about half. Road and pavement (lighting.wetSurface) already darken,
  so they get the `WX_NOWET` define (gloss and puddles stay theirs).
- **ripples**: expanding rings on up-facing wet surfaces within 30 m while it rains.
- **snow**: up-facing mask (`normal.y`, threshold relaxes as it builds up) × 3-octave noise
  for patchy accumulation → white, rough, non-metal, normal flattened; emissive under snow off.
  Works on ground, roofs, sills, AC units, fire-escape platforms, car roofs and hoods, trees.
- **sky exposure map**: an orthographic depth render of the scene from 520 m above the camera
  (160 m square, 1024² on ultra/high, 128 m / 512² on low), re-rendered only when the player
  moves 1/8 of it or every 3 s, and only while something is wet/snowy/falling. A surface below
  the top-most surface at its x/z is sheltered: rooms, arcades, the pavement under awnings and
  scaffolding stay dry and snow-free. Walls sample a little out along their normal, so street
  facades get wet but room walls do not. Rain drops and splashes use the same map.
- `noWeather(material)` opts a material out (`WX_OFF`). Skinned meshes are skipped.

### Fog: height fog + low cloud (global fog chunk)
`fog_fragment` keeps the time-of-day exp2 fog and adds two analytic terms:
ground fog `a·e^(-b·y)` integrated exactly along the ray, and a cloud layer whose density ramps
up over 80 m above the cloud **base** (integral of the ramp along the ray). So towers fade into
the cloud with height exactly like the reference. Works for every material with fog (basic,
standard, sprites, …). In thick fog the camera far plane comes in to where the fog is opaque
(min 320 m, CSM's own 260 m range untouched) — the perf win of haze.

### Rain, snow, splashes
- One indexed quad mesh (20k / 11k / 4.5k quads by quality), all motion in the vertex shader:
  positions wrap in a 26 x 18 x 26 m box around the camera (`mod`), velocity = fall + wind,
  streak = segment from p to p − v·(1/40 s) expanded sideways in view space (≥ ~1 px wide).
  Snow: same mesh, round soft sprites, 1 m/s with wobble. Count scales with intensity via
  `drawRange`; no CPU per drop.
- Splashes: horizontal quads; each slot respawns at a hashed position (√r for density near the
  viewer) every ~0.4 s **at the top-most surface height read from the exposure map**, so they
  land on the road, the pavement, awnings and car roofs, never under cover.

### States and transitions
clear, partly, overcast, lightrain, rain (heavy), fog, snow — each a set of parameters (cloud,
darkness, rain, snow, ground fog, haze, cloud base, in-cloud density, fog-over-sky, wind).
Transitions lerp them with smoothstep over 1-3 min (random walk) or 6 s (Y key); rain/snow start
in the second half of a transition and stop in the first half. Wetness on the ground lags the
rain (wets in ~15-30 s, dries over minutes), snow cover builds over ~2-3 min and melts slowly.
- Random walk by default (Markov table `NEXT`, dwell times `DWELL`), starting clear.
- `Y` / `Shift+Y`: next / previous state. `?weather=clear|partly|overcast|lightrain|rain|fog|snow`
  sets one at once (with matching ground wetness / snow cover) and stops the walk;
  `?weather=random` starts in a random state.

### Interiors
Outdoors-only effects switch off when `lighting.place !== 'outdoor'`. In interior levels the
"view across the street" backdrop materials (tagged `userData.windowView` in interior.ts) get a
small emissive overlay: grey sky and desaturation under cloud, a fog veil, rain streaks and
falling flakes. NYC shop interiors that are part of the street level are sheltered by the
exposure map and see the real weather through their windows.

### People (for the people agent — weather does not edit people.ts)
`import { getWeather, onWeatherChange } from './weather'`:
`getWeather()` returns the live object `{ state, rain, snow, wetness, snowCover, cloud, fog, wind,
umbrellas, hoods }`; `umbrellas` (0..1) is the suggested share of pedestrians with an open
umbrella (≈ rain·1.6), `hoods` the share with hoods up. `onWeatherChange(fn)` fires when a
transition starts (the target state). Suggested: hash each person to decide, so the share grows
smoothly as rain sets in; umbrellas mostly black (see the 65th St reference).

### Performance
- Per frame: dome (background pixels only, ~11 texture taps), particle VS work
  (≤ 20k quads, one VTF each), splash quads, + one depth tap and ~40 ALU in standard materials
  while wet/snowy. Throttled: exposure depth pass (≤ every 3 s), env composite + PMREM
  (≤ every 1.2 s while changing, else 12 s).
- No shader is compiled on a weather change; only uniforms change. Particle counts and the
  exposure map size follow the G quality levels.
