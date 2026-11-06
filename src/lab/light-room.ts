import * as THREE from 'three';
import type { LabScene } from '../lab';

/**
 * ?lab=light-room — a white-walled gallery room with material probes (rough/glossy, metal/dielectric)
 * for tuning indoor image-based light. &env=museum (default) or &env=studio.
 */
const scene: LabScene = {
  name: 'light-room',
  description: 'indoor IBL test room with material probes',
  cam: [0, 1.7, 5.5],
  look: [0, 1.3, -1.5],
  env: 'museum',
  ground: false,
  build({ group }) {
    const W = 12, D = 14, H = 4.2;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: '#8a6a4a', roughness: 0.45 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    group.add(floor);
    const wallM = new THREE.MeshStandardMaterial({ color: '#efece6', roughness: 0.9, side: THREE.BackSide });
    const room = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), wallM);
    room.position.y = H / 2 - 0.01;
    room.receiveShadow = true;
    group.add(room);
    // ceiling track lights washing the back wall
    for (let i = -1; i <= 1; i++) {
      const s = new THREE.SpotLight('#fff1dc', 40, 12, 0.5, 0.6, 1.5);
      s.position.set(i * 3, H - 0.1, 1);
      s.target.position.set(i * 3, 0.8, -1.5);
      // no shadows: the museum rig's spots don't cast them either (lighting.ts LIGHT_BUDGET)
      group.add(s, s.target);
    }
    // material probes on plinths: chrome, brushed, gold, glossy red, satin red, matte white
    const probes: [string, number, number][] = [
      ['#d8d8d8', 0.05, 1], ['#d8d8d8', 0.35, 1], ['#c8a060', 0.25, 1],
      ['#b02020', 0.1, 0], ['#b02020', 0.6, 0], ['#f2f2f2', 0.9, 0],
    ];
    probes.forEach(([c, r, m], i) => {
      const x = (i - 2.5) * 1.6;
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1, 0.8), new THREE.MeshStandardMaterial({ color: '#f4f2ee', roughness: 0.8 }));
      plinth.position.set(x, 0.5, -1.5);
      plinth.castShadow = plinth.receiveShadow = true;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.32, 48, 24), new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m }));
      ball.position.set(x, 1.32, -1.5);
      ball.castShadow = ball.receiveShadow = true;
      group.add(plinth, ball);
    });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.6, 0.06), new THREE.MeshStandardMaterial({ color: '#3a2a18', roughness: 0.4 }));
    frame.position.set(0, 2.2, -D / 2 + 0.05);
    const canvas = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.4), new THREE.MeshStandardMaterial({ color: '#4a6a8a', roughness: 0.8 }));
    canvas.position.set(0, 2.2, -D / 2 + 0.085);
    group.add(frame, canvas);
  },
};
export default scene;
