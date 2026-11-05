import * as THREE from 'three';
import type { Rect } from './level';

const EYE = 1.65;
const RADIUS = 0.32;

export class Player {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  onGround = true;
  keys = new Set<string>();
  locked = false;
  /** touch input: move vector in [-1, 1] */
  touchMove = new THREE.Vector2();
  private bob = 0;

  constructor(public camera: THREE.PerspectiveCamera, private dom: HTMLElement) {
    addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Space' && this.onGround && this.locked) {
        this.vel.y = 5.2;
        this.onGround = false;
      }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.look(e.movementX, e.movementY);
    });
  }

  look(dx: number, dy: number) {
    this.yaw -= dx * 0.0022;
    this.pitch -= dy * 0.0022;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
  }

  place(pos: THREE.Vector3, yaw: number) {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
  }

  update(dt: number, colliders: Rect[], frozen: boolean) {
    const k = this.keys;
    let fx = 0, fz = 0;
    if (!frozen) {
      if (k.has('KeyW') || k.has('ArrowUp')) fz -= 1;
      if (k.has('KeyS') || k.has('ArrowDown')) fz += 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) fx -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) fx += 1;
      fx += this.touchMove.x;
      fz += this.touchMove.y;
    }
    const len = Math.hypot(fx, fz);
    if (len > 1) { fx /= len; fz /= len; }
    const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? 11 : 5;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wx = fx * cos + fz * sin;
    const wz = -fx * sin + fz * cos;
    const accel = this.onGround ? 14 : 3;
    this.vel.x += (wx * speed - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (wz * speed - this.vel.z) * Math.min(1, accel * dt);
    this.vel.y -= 14 * dt;

    // move each axis then resolve against the boxes
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    for (let iter = 0; iter < 2; iter++) {
      for (const c of colliders) {
        const nx = Math.max(c.minX, Math.min(this.pos.x, c.maxX));
        const nz = Math.max(c.minZ, Math.min(this.pos.z, c.maxZ));
        const dx = this.pos.x - nx, dz = this.pos.z - nz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= RADIUS * RADIUS) continue;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          this.pos.x = nx + (dx / d) * RADIUS;
          this.pos.z = nz + (dz / d) * RADIUS;
        } else {
          // centre inside the box: push out along the shortest axis
          const l = this.pos.x - c.minX, r = c.maxX - this.pos.x, b = this.pos.z - c.minZ, t = c.maxZ - this.pos.z;
          const m = Math.min(l, r, b, t);
          if (m === l) this.pos.x = c.minX - RADIUS;
          else if (m === r) this.pos.x = c.maxX + RADIUS;
          else if (m === b) this.pos.z = c.minZ - RADIUS;
          else this.pos.z = c.maxZ + RADIUS;
        }
      }
    }
    this.pos.y += this.vel.y * dt;
    if (this.pos.y <= 0) {
      this.pos.y = 0;
      this.vel.y = 0;
      this.onGround = true;
    }

    const moving = Math.hypot(this.vel.x, this.vel.z);
    this.bob += moving * dt * 1.6;
    const bobY = this.onGround ? Math.sin(this.bob * 2) * 0.035 * Math.min(1, moving / 5) : 0;
    this.camera.position.set(this.pos.x, this.pos.y + EYE + bobY, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
