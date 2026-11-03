import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {wordCount} from '../../../../../packages/core/src/shared/text.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const [id,module] of [['quiet_europa','prose-europa'],['last_impression','prose-print'],['tide_register','prose-tide'],['borrowed_rain','prose-orchard']]){
 if(!existsSync(path.join(root,'build',module+'.mjs')))continue;
 const t=JSON.parse(readFileSync(path.join(root,'truth',id+'.json'),'utf8'));
 const {default:chapters}=await import('./'+module+'.mjs');
 for(const [i,template] of chapters.entries()){
  const c=t.chapters[i],lookup={claim:c.claim[2],memory:c.memory,knows:c.knows,misbelieves:c.misbelieves,suspect:c.suspect,plan:c.plan,hypothesis:c.hypothesis,dream:c.dream,relation:c.relationship.anchor,believes:c.believes};
  c.facts.forEach((f,i)=>lookup['f'+i]=f.anchor);c.hooks.forEach((h,i)=>lookup['h'+i]=h[2]);
  const text=template.replace(/\{([a-z0-9]+)\}/g,(_,key)=>{assert(lookup[key],key);return lookup[key];}).replace(/\r\n?/g,'\n')+'\n';
  for(const [key,value] of Object.entries(lookup))assert(text.includes(value),`${id} c${i+1} missing ${key}`);
  const out=path.join(root,t.split,'chapters',`${id}-c${i+1}.md`);mkdirSync(path.dirname(out),{recursive:true});writeFileSync(out,text);
  console.log(`${id} c${i+1}: ${wordCount(text).value} words`);
 }
}
// These prose files were authored directly. Insert only the explicitly revised design anchors once.
const b=JSON.parse(readFileSync(path.join(root,'truth','bakery_apartment.json'),'utf8'));
for(const [i,c] of b.chapters.entries()){
 const file=path.join(root,'acceptance','chapters',`bakery_apartment-c${i+1}.md`);let text=readFileSync(file,'utf8').replace(/\r\n?/g,'\n');
 if(!text.includes(c.relationship.anchor))text=text.replace(c.knows,c.knows+' '+c.relationship.anchor);
 if(!text.includes(c.believes)){const paragraphs=text.trimEnd().split('\n\n');paragraphs[paragraphs.length-2]+=' '+c.believes;text=paragraphs.join('\n\n')+'\n';}
 writeFileSync(file,text);console.log(`bakery_apartment c${i+1}: ${wordCount(text).value} words`);
}
