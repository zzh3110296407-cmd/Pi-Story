import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=path.resolve(root,'../../DS09-state-gold/v2');
const sha=x=>createHash('sha256').update(x).digest('hex');
const configurations=[['unclaimed_lane-c1','Ada'],['unclaimed_lane-c3','Ada'],['unclaimed_pedestal-c1','Leila'],['unclaimed_pedestal-c3','Leila']];
// Explicit edits of the narrator's own pronominal references are added after a
// first-pass read. Quoted dialogue and all event-bearing nouns/verbs remain intact.
const pronouns={
 'unclaimed_lane-c1':{count:61,I:[1,4,5,6,10,12,13,16,19,22,23,24,25,29,30,32,33,34,36,39,41,42,49,51,52,53,58,61],my:[3,11,31,35,37,59,60],me:[28,43,56],myself:[15,17,18,40,57]},
 'unclaimed_lane-c3':{count:52,I:[1,2,4,6,8,9,10,13,18,22,26,28,31,37,38,40,42,45,46,48,49,51,52],my:[3,7,11,30,36,47],me:[21,27,41,43],myself:[32,50]},
 'unclaimed_pedestal-c1':{count:29,I:[1,2,3,4,5,11,13,14,16,17,18,19,20,21,22,23,24,25,27,28],my:[10,15,29],me:[],myself:[]},
 'unclaimed_pedestal-c3':{count:17,I:[1,3,4,6,7,9,11,14,16],my:[2,17],me:[8,13],myself:[]}
};
const groups={
 'unclaimed_lane-c1':[['They stood beside the kettle','We stood beside the kettle'],['their travel fund','our travel fund'],['they should reserve','we should reserve'],['either of them','either of us'],['their different histories','our different histories'],['neither runner could explain','neither of us could explain'],['the team’s names','our team’s names'],['They went through','We went through'],['kept their conversation','kept our conversation'],['showed them the single key','showed us the single key'],['they could open it','we could open it'],['one of them ought','one of us ought']],
 'unclaimed_lane-c3':[['their relay team','our relay team'],['their time','our time'],['keep them from arguing','keep us from arguing'],['a volunteer gave them','a volunteer gave us'],['their travel fund','our travel fund'],['They would not need','We would not need'],['Their absent teammate','Our absent teammate'],['They could all reproduce','We could all reproduce'],['They did not need to settle','We did not need to settle'],['the question they had actually pursued','the question we had actually pursued'],['documents could tell them','documents could tell us'],['They had opened the door','We had opened the door'],['Nessa believed they could return','Nessa believed we could return'],['They talked about','We talked about'],['cheering they had heard','cheering we had heard'],['They had finished second','We had finished second'],['when they invented','when we invented'],['their signed sheet','our signed sheet'],['collect their bags','collect our bags']],
 'unclaimed_pedestal-c1':[['I said they could repair','I said we could repair'],['asked them to check the postage','asked us to check the postage'],['would teach them anything','would teach us anything'],['They measured the pedestal','We measured the pedestal'],['when they knew what was absent','when we knew what was absent'],['They left the straps','We left the straps']],
 'unclaimed_pedestal-c3':[['Their shared picture','Our shared picture'],['each of them assumed','each of us assumed'],['they had manufactured locally','we had manufactured locally'],['their questions page','our questions page'],['as if they had always known','as if we had always known'],['a task they had finally allowed','a task we had finally allowed'],['Their observation connected','Our observation connected'],['They listed the roll','We listed the roll'],['but they did not establish','but we did not establish'],['They had opened the lid','We had opened the lid'],['things they did not know','things we did not know']]
};
const metadata=[];
for(const [id,hero]of configurations){
 const before=readFileSync(path.join(source,'acceptance/chapters',id+'.md'),'utf8');
 let text=before.split(/(“[^”]*”)/gu).map((piece,i)=>{
  if(i%2)return piece;
  let result=piece.replace(new RegExp(`\\b${hero}[’']s\\b`,'gu'),'my');
  result=result.replace(new RegExp(`\\b(to|for|with|from|at|beside|about|against|towards|past|behind|of) ${hero}\\b`,'gu'),'$1 me');
  result=result.replace(new RegExp(`\\b${hero}\\b`,'gu'),'I');
  return result;
 }).join('');
 const configuration=pronouns[id];let occurrence=0;
 text=text.replace(/\b(?:she|her|herself|She|Her)\b/gu,original=>{occurrence++;for(const replacement of ['I','my','me','myself'])if(configuration[replacement].includes(occurrence))return replacement;return original;});
 assert.equal(occurrence,configuration.count,'Source pronoun inventory changed; re-read affected chapter before regenerating its voice edit.');
 text=text.replaceAll('asked I whether','asked me whether').replaceAll('irritated I before','irritated me before');
 for(const [old,replacement]of groups[id]){assert(text.includes(old),`${id}: group reference changed: ${old}`);text=text.replaceAll(old,replacement);}
 assert.notEqual(text,before);
 mkdirSync(path.join(root,'acceptance/design'),{recursive:true});
 writeFileSync(path.join(root,'acceptance/design',id+'-first-person.md'),text);
 metadata.push({chapterId:id,sourceSha256:sha(before),rewrittenSha256:sha(text),change:'First-person narrator throughout main action and reflections; no inserted framing around an untouched third-person chapter.',reviewStatus:'pending_author_semantic_and_scope_review'});
 console.log(JSON.stringify({id,heroReferencesRecast:(text.match(/\bI\b/gu)??[]).length,sourceSha256:sha(before),rewrittenSha256:sha(text)}));
}
mkdirSync(path.join(root,'labels'),{recursive:true});writeFileSync(path.join(root,'labels/voice-design.json'),JSON.stringify({date:'2026-10-30',transform:'Named narrator substitutions plus explicit reviewed pronoun edits outside dialogue; author review pending.',chapters:metadata},null,2)+'\n');
