import {existsSync,readFileSync,writeFileSync} from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const id of ['tide_register','borrowed_rain','bakery_apartment','quiet_europa','last_impression']){
 const t=JSON.parse(readFileSync(path.join(root,'truth',id+'.json'),'utf8'));
 for(const [i,c]of t.chapters.entries()){
  const f=path.join(root,t.split,'chapters',`${id}-c${i+1}.md`);if(!existsSync(f))continue;let text=readFileSync(f,'utf8');
  if(id==='bakery_apartment'&&i===2)text=text.replace('She remembered an old neighbour teaching her to divide dough, long before dates mattered to her.',c.memory);
  if(!text.includes(c.relationship.anchor)&&text.includes(c.knows))text=text.replace(c.knows,c.knows+' '+c.relationship.anchor);
  const anchors=[...c.facts.map(f=>f.anchor),c.claim[2],c.memory,c.knows,c.misbelieves,c.suspect,c.plan,c.hypothesis,c.dream,...c.hooks.map(h=>h[2]),c.relationship.anchor,c.believes];
  for(const anchor of anchors){if(text.includes(anchor))continue;const plain=s=>s.replaceAll('’',"'");const at=plain(text).indexOf(plain(anchor));if(at>=0)text=text.slice(0,at)+anchor+text.slice(at+anchor.length);else console.log(`Missing semantic anchor ${id} c${i+1}: ${anchor}`);}
  if(!text.includes(c.trueClaim.anchor))text=text.replace(c.facts[2].anchor,c.facts[2].anchor+' '+c.trueClaim.anchor);
  if(id==='bakery_apartment'&&i===2)text=text.replace('Daniel put the key on its new hook','Naomi secured the key in her own pocket');
  if(!text.includes(c.endStateAnchor))text=text.trimEnd()+' '+c.endStateAnchor+'\n';
  writeFileSync(f,text);
 }
}
