import type { LabScene } from '../lab';
import { labScenes } from '../lab';

/** ?lab=index lists every lab scene as a contact sheet of links. */
const scene: LabScene = {
  name: 'index',
  description: 'list of lab scenes',
  ground: false,
  build() {
    const list = document.createElement('div');
    list.style.cssText = 'position:fixed;inset:60px 20px 20px;overflow:auto;background:rgba(10,10,14,.9);padding:20px;border-radius:12px;font:14px system-ui;color:#fff;z-index:9';
    list.innerHTML = '<h2>Lab scenes</h2>' + labScenes().map((s) => `<p><a href="?lab=${s.name}">${s.name}</a> — ${s.description ?? ''}</p>`).join('');
    document.body.appendChild(list);
  },
};
export default scene;
