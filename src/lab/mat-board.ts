import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { LabScene } from '../lab';
import { enhanceTree, materialsReady, setDust, setMaterialDebug } from '../materials';

/**
 * ?lab=mat-board — every sand3d material kind on a sphere, a rounded box and a cylinder,
 * with sand3d's typical colour and roughness for that kind (measured over public/rebuilt).
 *   &kinds=oak,walnut   only these      &cols=6   grid width
 *   &s=1                sample size (metres; 1 = ~30 cm objects)   &dust=0.5
 *   &uv=1               keep the primitives' UVs (otherwise triplanar, like streamed objects)
 */
export const SAMPLES: [string, string, number, number][] = [
  // kind, sRGB colour, roughness, metalness  (sand3d's usual values)
  ['oak', '#9a6a3c', 0.55, 0], ['walnut', '#5a3a26', 0.45, 0], ['pine', '#c89a5e', 0.6, 0], ['birch', '#d9b88a', 0.55, 0],
  ['steel', '#9a9a9a', 0.3, 1], ['brushed_steel', '#a0a4a8', 0.35, 1], ['aluminium', '#c4c4c4', 0.4, 1], ['chrome', '#a8a8a8', 0.05, 1],
  ['brass', '#d0bc78', 0.25, 1], ['copper', '#bc5a1e', 0.25, 1], ['painted_metal', '#2f6b9a', 0.4, 0], ['painted_metal', '#9a1c1c', 0.2, 0],
  ['plastic', '#e8e8e8', 0.5, 0], ['plastic', '#2a64c8', 0.5, 0], ['glossy_plastic', '#c8281e', 0.15, 0], ['rubber', '#1c1c1c', 0.9, 0],
  ['ceramic', '#f0ece2', 0.15, 0], ['ceramic', '#b0563a', 0.7, 0], ['fabric', '#5a7a9a', 0.85, 0], ['velvet', '#7a1a3a', 0.85, 0],
  ['leather', '#6b3a1e', 0.5, 0], ['marble', '#e8e6e1', 0.3, 0], ['concrete', '#8a8a86', 0.85, 0], ['glass', '#e8eef0', 0.05, 0],
];

function label(text: string, sub: string) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = '#111';
  g.fillRect(0, 0, 512, 96);
  g.fillStyle = '#fff';
  g.font = 'bold 44px system-ui, sans-serif';
  g.fillText(text, 16, 50);
  g.fillStyle = '#aaa';
  g.font = '28px system-ui, sans-serif';
  g.fillText(sub, 16, 86);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.1125), new THREE.MeshBasicMaterial({ map: t, toneMapped: false }));
  return m;
}

const scene: LabScene = {
  name: 'mat-board',
  description: 'every material kind on a sphere, rounded box and cylinder (&kinds=, &uv=1, &dust=)',
  cam: [0, 1.05, 2.7],
  look: [0, 0.88, 0],
  build({ group, params }) {
    const only = params.get('kinds')?.split(',');
    const list = SAMPLES.filter((s) => !only || only.includes(s[0]));
    const cols = Number(params.get('cols') ?? (list.length > 12 ? 6 : Math.min(list.length, 4)));
    const s = Number(params.get('s') ?? 1);
    const keepUv = params.get('uv') === '1';
    setDust(Number(params.get('dust') ?? 0));
    setMaterialDebug(Number(params.get('dbg') ?? 0));
    const sphere = new THREE.SphereGeometry(0.1 * s, 64, 32);
    const box = new RoundedBoxGeometry(0.14 * s, 0.14 * s, 0.14 * s, 4, 0.015 * s);
    const cyl = new THREE.CylinderGeometry(0.05 * s, 0.05 * s, 0.2 * s, 48, 1);
    const geos = [sphere, box, cyl];
    if (!keepUv) for (const g of geos) g.deleteAttribute('uv');
    const rows = Math.ceil(list.length / cols);
    const dx = 0.66 * s, dy = 0.42 * s;
    list.forEach(([kind, hex, rough, metal], i) => {
      const cx = (i % cols - (cols - 1) / 2) * dx;
      const cy = (rows - 1 - Math.floor(i / cols)) * dy + 0.25 * s;
      const cell = new THREE.Group();
      cell.position.set(cx, cy, 0);
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: rough, metalness: metal });
      mat.name = `${kind}__${hex.slice(1)}`;
      const meshes = geos.map((g) => new THREE.Mesh(g, mat));
      meshes[0].position.set(-0.18 * s, 0.1 * s, 0);
      meshes[1].position.set(0, 0.07 * s, 0);
      meshes[1].rotation.y = 0.6;
      meshes[2].position.set(0.17 * s, 0.1 * s, 0);
      for (const m of meshes) {
        m.castShadow = m.receiveShadow = true;
        cell.add(m);
      }
      // a shelf for each row so samples sit on something
      const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.6 * s, 0.01, 0.3 * s), new THREE.MeshStandardMaterial({ color: '#3a3a3a', roughness: 0.8 }));
      shelf.position.set(0, -0.005, 0);
      shelf.receiveShadow = true;
      cell.add(shelf);
      const l = label(kind, `${hex}  r=${rough}`);
      l.scale.setScalar(s);
      l.position.set(0, -0.07 * s, 0.16 * s);
      l.rotation.x = -0.35;
      cell.add(l);
      enhanceTree(cell);
      group.add(cell);
    });
    return materialsReady();
  },
};
export default scene;
