
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
