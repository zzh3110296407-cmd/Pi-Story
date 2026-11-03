import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stories } from './story-plans.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
if(stories.some(s=>existsSync(path.join(root,'truth',s.id+'.json'))))throw new Error('Initial authoring only: existing truth and its review history must not be overwritten.');
mkdirSync(path.join(root,'truth'),{recursive:true});
for(const story of stories){const bible=[...Object.entries(story.cast).map(([slug,identity])=>({key:`char:${slug}`,kind:'character',identity})),...Object.entries(story.places).map(([slug,name])=>({key:`place:${slug}`,kind:'place',name})),{key:'rule:physical_limit',kind:'rule',statement:story.rule}];
 if(story.id==='borrowed_rain')bible.push({key:'char:old_tree',kind:'character',identity:'The ancient living orchard tree'},{key:'char:new_tree',kind:'character',identity:'A new sapling distinct from the old tree'});
 const truth={schema:'story/state-truth-design@1',designedAt:new Date().toISOString(),designOrder:'truth_before_prose',...story,bible,relationBaseline:[{from:Object.keys(story.cast)[0],to:Object.keys(story.cast)[1],stance:'wary cooperation'}],annotationPolicy:{facts:'Gold targets end-of-chapter state; explicit within-chapter before/change values remain arithmetic evidence. Do not create multiple active single-valued facts.',recalls:'Unknown starts are null, not zero. Chapter-two memories explicitly dated to chapter one use [1,1].',claims:'Keep reported dialogue separate from confirmed world facts.',traps:'Plans, hypotheses and dreams produce no asserted world facts.',provisional:'Uncertain sensory inference is provisional and never a confirmed premise.'}};
 writeFileSync(path.join(root,'truth',story.id+'.json'),JSON.stringify(truth,null,2)+'\n');}
console.log('Five truth tables written before any DS09 chapter prose.');
