import * as THREE from 'three';
import type { LabScene } from '../lab';
import { Traffic } from '../nyc/vehicles';
import { fleetInstances, preloadFleet } from '../nyc/vehicleFleet';
import { SPAWN } from '../nyc/districts';

/**
 * ?lab=vehicles-traffic — the real Traffic simulation seen from the world spawn (5 Av looking north), without the
 * city: for density, queues at reds and counts. window.__vehStats() returns draw calls / triangles and the
 * cars by LOD level. &t=<s> sets the simulated clock (signal phase).
 */
let traffic: Traffic | null = null;
let cam: THREE.Camera | null = null;
let clock = 0;
const eye = new THREE.Vector3(SPAWN.x, 1.7, SPAWN.z);
const scene: LabScene = {
  name: 'vehicles-traffic',
  description: 'Traffic from the world spawn on 5 Av (density, queues; __vehStats())',
  cam: [SPAWN.x, 1.7, SPAWN.z],
  look: [SPAWN.x + 7, 1.4, SPAWN.z - 60],
  env: 'nyc',
  ground: false,
  async build({ group, renderer, params, camera }) {
    cam = camera;
    await preloadFleet();
    clock = Number(params.get('t') ?? 0);
    // plain asphalt for the avenues and streets around the spawn (the lab has no city)
    const road = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: '#3a3b3d', roughness: 0.9 }));
    road.rotation.x = -Math.PI / 2;
    road.receiveShadow = true;
    group.add(road);
    traffic = new Traffic(group, Number(params.get('seed') ?? 20261105));
    traffic.update(0.05, eye, clock);
    (window as any).__traffic = traffic;
    (window as any).__vehStats = () => {
      let tris = 0, meshes = 0;
      group.traverseVisible((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        meshes++;
        const n = (m.geometry.index?.count ?? m.geometry.getAttribute('position').count) / 3;
        tris += (m as THREE.InstancedMesh).isInstancedMesh ? n * (m as THREE.InstancedMesh).count : n;
      });
      return { ...renderer.info.render, moving: traffic!.cars.length, cars: fleetInstances.census, sceneTris: Math.round(tris), meshes };
    };
  },
  update(dt) {
    clock += dt;
    traffic?.update(dt, eye, clock);
    if (cam) fleetInstances.update(cam.position);
  },
};
export default scene;
