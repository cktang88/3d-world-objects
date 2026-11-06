/** The museum: an atrium with six wings and endless galleries of similar things (src/museum/). */
export { AtriumLevel } from './museum/atrium';
export { GalleryLevel } from './museum/gallery';
export { titleCase } from './museum/text';

// the museum's floor plan on the minimap: rooms built so far, '?' for doorways not yet explored
import { registerMinimapSource } from './minimap';
import { MuseumBase } from './museum/base';
import { entryPortal, markVisited, museumSource } from './museum/map';
registerMinimapSource((l) => {
  if (!(l instanceof MuseumBase) || !l.mapKey) return null;
  markVisited(l.mapKey); // the minimap resolves a level when it becomes the one you are in
  return museumSource(l.mapKey, (desc) => (globalThis as unknown as { __world?: { enter?: (p: unknown) => void } }).__world?.enter?.(entryPortal(desc)));
});
