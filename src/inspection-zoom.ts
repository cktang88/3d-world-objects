import type { PerspectiveCamera } from 'three';

/** Hold-to-inspect changes the lens, leaving the player's position and object scale alone. */
export class InspectionZoom {
  private readonly normal: number;
  constructor(private camera: PerspectiveCamera) { this.normal = camera.fov; }

  update(dt: number, inspecting: boolean) {
    const target = inspecting ? 28 : this.normal;
    const next = this.camera.fov + (target - this.camera.fov) * (1 - Math.exp(-14 * dt));
    this.set(Math.abs(next - target) < 0.02 ? target : next);
  }
  reset() { this.set(this.normal); }
  private set(fov: number) {
    if (this.camera.fov === fov) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }
}
