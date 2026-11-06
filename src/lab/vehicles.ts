import type { LabScene } from '../lab';
import { carMesh } from '../nyc/vehicles';
import { preloadFleet } from '../nyc/vehicleFleet';
import { Rng } from '../rng';

/**
 * ?lab=vehicles — a street line-up as nyc.ts makes it: cabs, street cars and an MTA bus, noses toward -z.
 * &seed= picks other models/colours; &n= cars per row.
 */
const scene: LabScene = {
  name: 'vehicles',
  description: 'NYC cabs, street cars and an MTA bus (carMesh)',
  cam: [-9, 3.2, -11],
  look: [0, 1, 0],
  env: 'nyc',
  async build({ group, params }) {
    await preloadFleet();
    const r = new Rng(Number(params.get('seed') ?? 1));
    const n = Number(params.get('n') ?? 4);
    for (let i = 0; i < n; i++) {
      const cab = carMesh('cab', r);
      cab.position.set(-3.2, 0, (i - n / 2) * 6.5);
      group.add(cab);
      const car = carMesh('sedan', r);
      car.position.set(0, 0, (i - n / 2) * 6.5);
      group.add(car);
    }
    const bus = carMesh('bus', r);
    bus.position.set(4, 0, 0);
    group.add(bus);
  },
};
export default scene;
