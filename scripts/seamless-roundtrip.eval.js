// Seamless doors round trip without the full world: seamless.ts + a real ShopLevel behind a fake street door.
// Run (no world lock needed):
//   node scripts/shot.mjs --port <port> --url "/?lab=index" --quality low --w 320 --h 180 --max 300 --out /tmp/x.png --eval "$(cat scripts/seamless-roundtrip.eval.js)"
// Expect: shown true, corridor blocked at 0, enter/exit true, re-enter with "builds added 0".
(async()=>{
const THREE=await import(performance.getEntriesByType('resource').map(e=>e.name).find(n=>/deps\/three\.js/.test(n)));
const SM=await import('/src/seamless.ts'); const S=await import('/src/shop.ts');
const sl=(ms)=>new Promise(r=>setTimeout(r,ms));
const out=[];
const scene=new THREE.Scene(); const camera=new THREE.PerspectiveCamera(70,1.6,0.05,500);
const renderer=new THREE.WebGLRenderer();
// a fake street: one storefront door at (10,0,5); walking in faces yaw PI/2 (towards -x)
const door={pos:new THREE.Vector3(10,0,5), yaw:Math.PI/2, see:true, hole:new THREE.Box3(new THREE.Vector3(9,0,2),new THREE.Vector3(11,3,8))};
const target={kind:'interior',seed:3,name:'RT Deli',style:'store',floor:0,floors:1,biome:'metropolis',shop:'deli'};
const portal={box:new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(10.7,1.4,5),new THREE.Vector3(1.6,2.8,1.8)),label:'Enter',target,door};
const street={name:'street',group:new THREE.Group(),spawn:{pos:new THREE.Vector3(),yaw:0},env:{},colliders:()=>[{minX:4,maxX:10,minZ:-10,maxZ:20}],portals:()=>[portal],update(){},dispose(){}};
const build=(d,staged)=>d.kind==='nyc'?street:new S.ShopLevel(d,{staged});
const seam=new SM.Seamless({scene,camera,renderer,build});
const streetDesc={kind:'nyc',seed:1,name:'street'};
seam.setActive(seam.take(streetDesc));
let level=street;
const f=(y)=>new THREE.Vector3(-Math.sin(y),0,-Math.cos(y));
const player=door.pos.clone().addScaledVector(f(door.yaw),-4);
camera.position.set(player.x,1.6,player.z); camera.lookAt(door.pos.x,1.6,door.pos.z); camera.updateMatrixWorld();
// 1. stand 4 m from the door, facing it: prebuilt and shown?
const t0=performance.now(); let frames=0, maxMs=0;
while(performance.now()-t0<60000){ const a=performance.now(); seam.update(1/60,level,player); maxMs=Math.max(maxMs,performance.now()-a); frames++; const s=[...seam.slots.values()].find(s=>s.desc.kind==='interior'); if(s&&s.shown) break; await sl(16);}
const slot=[...seam.slots.values()].find(s=>s.desc.kind==='interior');
out.push(`prebuild: frames ${frames}, max update ${maxMs.toFixed(0)} ms, built in ${slot&&slot.ms.toFixed(0)} ms, shown ${slot&&slot.shown}, pool light ${seam['pool'][0].intensity.toFixed(1)}`);
// 2. the colliders let you through the door
const cols=seam.colliders(street.colliders(), player);
const blocked=(p)=>cols.some(c=>p.x>c.minX&&p.x<c.maxX&&p.z>c.minZ&&p.z<c.maxZ);
const path=[...Array(10)].map((_,i)=>door.pos.clone().addScaledVector(f(door.yaw),-1+i*0.25));
out.push('door corridor blocked at '+path.filter(blocked).length+' of 10 points');
// 3. cross the threshold
const inside=door.pos.clone().addScaledVector(f(door.yaw),0.8);
const r1=seam.update(1/60,level,inside); out.push('crossing -> enter '+!!r1.enter);
const builds0=seam.stats.builds;
const s=seam.take(target); seam.placeAt(s,portal); const c=seam.carry(s,'in',inside,door.yaw); seam.setActive(s,[SM.descKey(streetDesc)]); level=s.level;
out.push(`inside at ${c.pos.toArray().map(v=>v.toFixed(2))} yaw ${c.yaw.toFixed(2)} entry ${s.entry.pos.toArray().map(v=>v.toFixed(2))}`);
// 4. walk back out
const outLocal=s.entry.pos.clone().addScaledVector(f(s.entry.yaw),-0.6);
const r2=seam.update(1/60,level,outLocal); out.push('walking out -> exit '+!!r2.exit);
const back=seam.carry(s,'out',outLocal,c.yaw+Math.PI);
seam.setActive(seam.take(streetDesc)); level=street;
out.push(`back on street at ${back.pos.toArray().map(v=>v.toFixed(2))} (door ${door.pos.toArray()})`);
// 5. and in again: no rebuild
for(let i=0;i<20;i++){seam.update(1/60,level,back.pos); await sl(16);}
const r3=seam.update(1/60,level,inside);
out.push(`re-enter -> enter ${!!r3.enter}, builds added ${seam.stats.builds-builds0}, hits ${seam.stats.hits}, shown ${s.shown}`);
return out.join('\n');
})()
