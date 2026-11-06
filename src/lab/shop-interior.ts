import * as THREE from 'three';
import type { LabScene } from '../lab';
import { ShopLevel, SHOP_BUDGET } from '../shop';
import { SHOPS } from '../nyc';

/**
 * ?lab=shop-interior&type=deli&seed=3       one ShopLevel, seen from just inside the door
 * &view=back|front|counter|side              preset camera (or &cam=&look= as usual)
 * &budget=<tris>                               product triangle budget (lower renders faster in software)
 * The shop's own lighting replaces the lab's: hemisphere, ambient and exposure come from ShopLevel.env.
 */
const scene: LabScene = {
  name: 'shop-interior',
  description: 'one shop interior: &type=' + SHOPS.map((s) => s.type).join('|') + ' &seed=',
  cam: [0, 1.6, 6],
  look: [0, 1.3, 0],
  env: 'museum',
  ground: false,
  async build({ group, params, camera, renderer }) {
    const type = params.get('type') ?? 'deli';
    const seed = Number(params.get('seed') ?? 7);
    const info = SHOPS.find((s) => s.type === type) ?? SHOPS[0];
    if (params.get('budget')) SHOP_BUDGET.tris = Number(params.get('budget'));
    const lv = new ShopLevel({ kind: 'interior', seed, name: `${info.names[0]}`, style: 'shop', floor: 0, floors: 1, biome: 'temperate', shop: type });
    group.add(lv.group);
    (window as unknown as { __shop: ShopLevel }).__shop = lv;
    // use the shop's own light set-up, not the lab's
    const sc = group.parent as THREE.Scene;
    sc?.traverse((o) => {
      if ((o as THREE.HemisphereLight).isHemisphereLight) {
        const h = o as THREE.HemisphereLight;
        h.color.set(lv.env.hemi.sky);
        h.groundColor.set(lv.env.hemi.ground);
        h.intensity = lv.env.hemi.intensity;
      } else if ((o as THREE.AmbientLight).isAmbientLight) (o as THREE.AmbientLight).intensity = lv.env.ambient;
    });
    if (sc) sc.environmentIntensity = lv.env.envIntensity;
    renderer.toneMappingExposure = lv.env.exposure;
    if (!params.get('cam')) {
      const p = lv.spawn.pos;
      const views: Record<string, [number, number, number]> = { front: [p.x, 1.6, p.z], back: [p.x, 1.6, p.z], counter: [p.x - 1, 1.6, p.z], side: [p.x + 1.5, 1.6, p.z] };
      const v = views[params.get('view') ?? 'front'] ?? views.front;
      camera.position.set(...v);
    }
    await lv.stocked;
    // containers fill when you walk up to them; &containers=closed leaves them empty
    if (params.get('containers') !== 'closed') lv.generateAll();
    await new Promise((r) => setTimeout(r, Number(params.get('stockWait') ?? 4000)));
  },
};
export default scene;
