import type { LabScene } from '../lab';
import { FLEET, preloadFleet } from '../nyc/vehicleFleet';
import { standin } from '../nyc/vehicles';

/** ?lab=standins — the car silhouettes shown until each model has loaded (src/nyc/vehicles.ts standin); &load=1 loads the fleet */
const scene: LabScene = {
  name: 'standins',
  description: 'car stand-ins (shown for the first seconds before the models load)',
  cam: [9, 3.2, 9],
  look: [0, 0.8, 0],
  env: 'nyc',
  build({ group, params }) {
    // &load=1: also load the fleet (timings in window.__fleetTimings) to compare with the city
    if (params.get('load')) void preloadFleet();
    const cols = ['#f2c300', '#0a0b0d', '#8a1a1a', '#c8ccd0', '#2a4a7a', '#e8e8e8', '#3a3a3a', '#5a6a4a', '#f2c300'];
    Object.entries(FLEET).forEach(([id, f], i) => {
      const s = standin(cols[i % cols.length], f.len, f.wid, /tahoe|suburban|explorer|escalade|sprinter/.test(id));
      s.position.set((i % 3) * 3 - 3, 0, Math.floor(i / 3) * 6 - 6);
      s.rotation.y = 0.4;
      group.add(s);
    });
  },
};
export default scene;
