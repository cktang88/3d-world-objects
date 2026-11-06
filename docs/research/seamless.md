# Seamless doors and lazy insides

Code: `src/seamless.ts` (levels behind doors), `src/lazy.ts` (rooms and containers inside a level),
lab: `/?lab=seamless` (a facade with a door and window, and the real ShopLevel built in slices and
placed behind it). Turn the game behaviour off with `?seamless=0` to compare.

## What happens at a door

1. **Predictive prebuild.** Every 6th frame `Seamless.update` looks at the active level's portals.
   Door portals into `interior`, `gallery` or `atrium` levels within 14 m that you face
   (view direction · direction to the door > 0.5), or any within 3 m, are wanted (nearest two).
   Wanted levels not yet cached start building: `build(desc, staged = true)`.
2. **Time slices.** A staged level leaves its construction in `Level.staging` (an iterator); each
   frame runs `next()` until a 4 ms budget is spent. A level that does not support staging is
   built at once. Half-built levels you turn away from are dropped.
3. **LRU cache.** Built levels stay in `Seamless.slots`, keyed by `descKey(desc)`. Leaving a level
   no longer disposes it: the active level and its two parents on the stack are pinned, three more
   are kept, older ones are disposed (`Level.dispose`, with `remote.ts` `clearQueue()` held off so
   an evicted room cannot cancel the active room's model loads).
4. **Preview.** For a portal whose `door.see` is set (storefronts), a ready level is placed in
   world space so its entry doorway lands on the street door:
   `M = T(door.pos) · Ry(door.yaw − entry.yaw) · T(−entry.pos)`. Its lights are taken out while
   it is a preview (adding lights to the street would recompile every shader), its shaders are
   compiled with `renderer.compileAsync` before it is shown, `doorway.hide` objects (the shop's
   own front wall) are hidden, and the storefront's fake-interior glass is cut away inside
   `door.hole` (clipped to the interior's width) by `cutHoles()`. The nearest two previews within
   11 m are drawn; others are removed from the scene.
5. **Walking through.** While a preview is up and you are within 8 m, the street's colliders are
   carved by the interior's footprint and a corridor through the door, and the interior's own
   colliders are added, so you can walk in. Once you are 0.35 m past its threshold (and inside its
   footprint), the active level switches in the same frame: the player is moved into the
   interior's frame with `M⁻¹` (position and yaw; pitch kept), so the picture does not jump.
   Pressing E from the pavement does the same but steps you just inside. Walking back out past
   the threshold (or Q / the 'back' portal) switches back the same way; the street was never
   disposed, so you are where you went in.
6. **Lighting.** No black fade: `lighting.apply` runs at once and `Seamless.blendFrom` eases the
   tone-mapping exposure from the old value to the new one over 0.45 s.
7. **Fallback.** If the level is not ready (you pressed E on a door you never faced) the old fade
   is used and the build is finished during the black frame (`stats.fades`).
8. **Museum.** Gallery doorways are auto portals with `returnYaw`; `doorOf()` derives the doorway
   from the portal box and the next room's entry from its own 'back' portal, so galleries are
   prebuilt as you face a doorway and entered without a fade, the player carried from one corridor
   into the next. (No preview through the doorway: each gallery's corridor ends in a wall.)
   Auto portals you are standing in after a switch are disarmed until you step out of them.

`window.__world.seam.stats` has the counters: `builds` (constructions), `hits` (cache reuse),
`prebuilds`, `seamless` (no-fade switches), `fades`, `evicted`, `maxSliceMs`, and a `log`.

## How a level author exposes an entry

- `Level.doorway = { pos, yaw, hide? }` — the threshold of the door you come in by (floor level,
  in level coordinates) and the player yaw of someone walking in (yaw 0 faces −z). `hide` lists
  objects to hide while the level is seen from outside (ShopLevel: its baked front wall).
  Without it the level's `'back'` portal is used (box centre, `returnYaw`).
- `Portal.door = { pos, yaw, see?, hole? }` on the door you enter from (world/level coordinates of
  the parent level, same conventions). `see`: the door is glass, show the prebuilt level behind
  it. `hole`: the box of fake-interior glass to cut while it shows. Make that glass material
  cuttable with `cutHoles(material)`.
- Staged construction: take `opts.staged`, put the work in a generator with a `yield` after each
  room / fixture run, assign it to `this.staging` and, when not staged, drain it at once with
  `finishBuilding(this)` (src/level.ts). ShopLevel and InteriorLevel do this.

## Rooms (cells) — `src/lazy.ts` `CellGraph`

A level that has `cells: { group, bounds: Rect, doors: { x, z, width, height, axis, to }[], room?,
generate? }[]` (InteriorLevel does) gets a cell graph automatically. Each frame: find the cell the
camera is in, project each doorway rectangle to the screen, intersect it with the current clip
rectangle, and recurse (up to 3 doorways deep) into the cells seen; everything else gets
`group.visible = false`. `door.axis` 'x' means the doorway lies in the plane x = const. A cell
with `generate()` is filled once its doorway comes into view or you are within 4 m of it
(generators run in a 2 ms per-frame budget), so far rooms need not exist yet.

## Containers — `registerContainer(obj, spec)`

```ts
registerContainer(obj, {
  label: 'freezer',
  size,                       // outer w/h/d; obj at the front-centre base, +z out of the front
  generate: () => contents,   // Object3D, Promise<Object3D>, or a generator returning it (sliced)
  door?, drawer?, open?(t),   // what moves: a leaf swung about its origin, a drawer slid out, or your own pose (t 0..1)
  closedOpaque: true,         // false for glass coolers / display cases: generated when near (7 m) and facing
});
```

E on a closed container opens it (0.4 s ease) and generates the contents in time slices; E again
closes it and the contents are hidden. Sixteen closed contents are kept, older ones are disposed.
`jointOpener(animator)` turns a sand3d object's revolute/prismatic joints (remote.ts) into an
`open(t)` pose. Levels may instead list `containers: { kind, obj, size, generate, door?, drawer?,
closedOpaque? }[]` (InteriorLevel does): main.ts adopts them on first update. Without a `door`,
`drawer` or `open`, the contents slide out of the front so they can be seen — give the moving part
to get the real motion.

## Museum galleries (src/museum/)

How a `GalleryLevel` (src/museum/gallery.ts) is built, for prebuilding the room behind a doorway:

- **Entrance convention.** Every gallery's entrance is a doorway in its south wall centred on
  x = 0, z = 0, facing +z (the corridor and the "back" portal lie at z > 0). The room extends
  towards −z: x ∈ [−W/2, W/2], z ∈ [−D, 0]. The player spawns at (0, 0, −1.6) with yaw 0
  (looking towards −z). The atrium is the exception (its own fixed 30 × 30 m hall).
- **Async build.** The constructor is cheap. `level.ready` (a Promise) resolves when the room is
  built and every exhibit has streamed in. `level.plan` is `null` until the layout exists; once set
  it carries `W, D, H, Hw` and `doors: {wall: 'N'|'S'|'E'|'W', at, w, h}[]` (`doors[0]` is the
  entrance; the rest are the exits, in the order of the exit portals). Exit doorways along N have
  `at` = x; along E/W `at` = z (negative).
- **Time-sliced.** The plan is computed at once from known sizes (offline size shards); the shell
  is built and merged, then each display is built in turn, yielding (setTimeout 0) whenever a slice
  has run for more than ~6 ms. Exhibit models stream afterwards.
- **First visits without offline sizes** fall back to measuring: a small waiting room (6 × 6 m,
  same entrance convention) is shown and replaced when the room is built.
- **Lights.** Every museum room carries the same rig (10 SpotLights + 3 PointLights, no shadows,
  unused ones at intensity 0), so two galleries in the scene at once have 26 museum lights.
- **`level.built`** resolves as soon as the room itself (shell, displays, labels, lights) is built,
  with exhibit models possibly still streaming; **`level.ready`** resolves only when the gallery is
  fully built and every exhibit has arrived. Wait on `built` to show a room, `ready` for a finished one.

## Shops (src/shop.ts, src/shopkit/)

- **Geometry.** The room spans x ∈ [−W/2, W/2], z ∈ [−D/2, D/2], floor at y = 0; the shop front
  is the plane z = +D/2. `shop.room = { W, D, H }` and `shop.door = { pos, yaw: 0, width: 1.6,
  height: 2.6 }` (threshold centre on the front plane, level coordinates) are set in the
  constructor, before anything is built; `doorway` is the same point, with `hide: [front]` (the
  baked shop front wall, filled in during the build). Spawn is 1.1 m inside the door, yaw 0.
- **Staged build.** `new ShopLevel(desc, { staged: true })` builds nothing; `staging.next()` does
  one slice: the shell in five parts (floor, walls, ceiling texture, ceiling, front, signs), then
  one fixture per slice (layouts are generators), then the static merge in batches of ~120 meshes
  and one bucket per slice (`shopkit/bake.ts`). Typical slices are 1–10 ms; a deli is ~120 ms in
  total (software GL, lab). `shop.step(ms)` drains it within a budget and returns true when done;
  `shop.ready` resolves then; `shop.progress` is 0..1; `shop.stats` has `buildMs`,
  `buildSlices`, `longestStepMs`, `longestStep`. Canvas textures are cached per kind and CPU-backed
  (`willReadFrequently`), which made the first shell ~30× cheaper.
- **Stock streams in after.** When the build ends, the products load (sand3d, libraries) and are
  instanced asynchronously (`shop.stocked`), so there is no product work inside the slices.
- **Containers.** Glass cases (coolers, showcases, curios, deli cases) register with
  `registerContainer(..., { closedOpaque: false })` and are stocked when near and looked at.
  Drawers (hardware parts cabinet, antique dresser), the armoire and the stockroom (a door in a
  side wall of bodegas, pharmacies, hardware and toy shops; the whole back room is the contents,
  built in slices) are opaque and generate only when opened with E. `shop.cases` lists them.
- **Lights.** Every shop has exactly 4 PointLights (unused ones at intensity 0), no shadow-casting
  lights, so walking from one shop to another doesn't recompile shaders.
