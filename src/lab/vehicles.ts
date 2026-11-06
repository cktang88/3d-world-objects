import type { LabScene } from '../lab';
import { carMesh } from '../nyc/vehicles';
import { Rng } from '../rng';

/** ?lab=vehicles — the procedural cab, sedan and bus side by side. */
const scene: LabScene = {
  name: 'vehicles',
  description: 'NYC cab, sedan and bus',
  cam: [7, 3, 9],
  look: [0, 1, 0],
  env: 'nyc',
  build({ group }) {
    const r = new Rng(1);
    const kinds = ['cab', 'sedan', 'bus'] as const;
    kinds.forEach((k, i) => {
      const m = carMesh(k, r);
      m.position.set((i - 1) * 4, 0, 0);
      group.add(m);
    });
  },
};
export default scene;
