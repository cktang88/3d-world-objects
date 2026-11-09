import * as THREE from 'three';
import { test, expect, near } from './qa';
import { InspectionZoom } from '../src/inspection-zoom';

test('inspection zoom narrows the lens smoothly, restores it on release, and never moves the camera', () => {
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 900), zoom = new InspectionZoom(camera);
  camera.position.set(4, 1.65, 8);
  const projection = camera.projectionMatrix.elements[0];
  zoom.update(1 / 60, true);
  expect(camera.fov < 70 && camera.fov > 28, 'zoom eases in');
  for (let i = 0; i < 60; i++) zoom.update(1 / 60, true);
  near(camera.fov, 28, 0.03, 'close inspection FOV');
  expect(camera.projectionMatrix.elements[0] > projection, 'projection magnifies the view');
  expect(camera.position.equals(new THREE.Vector3(4, 1.65, 8)), 'position is unchanged');
  for (let i = 0; i < 60; i++) zoom.update(1 / 60, false);
  near(camera.fov, 70, 0.03, 'released FOV');
  zoom.update(0.3, true);
  zoom.reset();
  near(camera.fov, 70, 0.001, 'transitions restore normal lens immediately');
});
