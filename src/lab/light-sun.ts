import * as THREE from 'three';
import type { LabScene } from '../lab';
import { streetLightMarker, wetSurface } from '../lighting';

/**
 * ?lab=light-sun — a cheap outdoor scene (ground, a few "buildings", probes, two street lamps) for
 * checking sun direction vs HDRI, cascaded shadows, exposure and night lights quickly.
 * &tod=day|golden|dusk|night
 */
const scene: LabScene = {
  name: 'light-sun',
  description: 'outdoor lighting probe: shadows, HDRI sun alignment, night lamps',
  cam: [14, 2, 22],
  look: [0, 4, 0],
  env: 'nyc',
  ground: false,
  build({ group }) {
    const road = new THREE.MeshStandardMaterial({ color: '#4a4a4c', roughness: 0.9 });
    wetSurface(road);
    const g = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), road);
    g.rotation.x = -Math.PI / 2;
    g.receiveShadow = true;
    group.add(g);
    const brick = new THREE.MeshStandardMaterial({ color: '#8a5a44', roughness: 0.85 });
    const stone = new THREE.MeshStandardMaterial({ color: '#c8bca8', roughness: 0.8 });
    const glass = new THREE.MeshStandardMaterial({ color: '#7a8a9a', roughness: 0.05, metalness: 0.9 });
    const blocks: [number, number, number, number, number, THREE.Material][] = [
      [-12, -6, 10, 30, 10, brick], [2, -14, 12, 60, 12, glass], [16, -4, 8, 18, 10, stone], [-40, -60, 20, 120, 20, glass], [40, -80, 20, 80, 20, stone],
    ];
    for (const [x, z, w, h, d, m] of blocks) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      b.position.set(x, h / 2, z);
      b.castShadow = b.receiveShadow = true;
      group.add(b);
    }
    const probes: [string, number, number][] = [['#d8d8d8', 0.05, 1], ['#b02020', 0.3, 0], ['#f2f2f2', 0.9, 0]];
    probes.forEach(([c, r, m], i) => {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.8, 48, 24), new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m }));
      s.position.set(4 + i * 2.2, 0.8, 8);
      s.castShadow = s.receiveShadow = true;
      group.add(s);
    });
    // a person-sized post for contact shadows, and two lamps
    for (const x of [0, 12]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 8, 12), new THREE.MeshStandardMaterial({ color: '#3f4a42', metalness: 0.5, roughness: 0.5 }));
      p.position.set(x, 4, 12);
      p.castShadow = true;
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.3), new THREE.MeshStandardMaterial({ color: '#fff3d8', emissive: '#ffe2b0' }));
      head.position.set(x, 8, 12);
      group.add(p, head, streetLightMarker(x, 7.9, 12));
    }
  },
};
export default scene;
