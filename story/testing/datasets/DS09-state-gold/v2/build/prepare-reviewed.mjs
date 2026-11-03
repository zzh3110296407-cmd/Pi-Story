import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=x=>createHash('sha256').update(x).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const write=(p,data)=>writeFileSync(path.join(root,p),JSON.stringify(data,null,2)+'\n');
const snapshot=path.join(root,'labels/delegated-review.json');
if(!existsSync(snapshot)){
 const bytes=readFileSync('D:/AI/Story Dome/新版综合方案/测试结果/P2/人工复核/DS09-v2-金标复核.json');
 const reviewed=JSON.parse(bytes),draft=read(path.join(root,'labels/review.json'));
 assert.equal(reviewed.state,'AI_delegated_review_completed_with_changes');assert.equal(reviewed.items.length,219);
 assert.equal(reviewed.items.filter(i=>i.authorVerdict==='change').length,24);
 const initial=new Map(draft.items.map(i=>[i.itemId,i]));
 for(const item of reviewed.items){assert(initial.has(item.itemId));assert.deepEqual(item.aiLabel,initial.get(item.itemId).aiLabel,item.itemId);assert(['agree','change'].includes(item.authorVerdict));}
 writeFileSync(snapshot,bytes);
}
const reviewed=read(snapshot);
const auditPath=path.join(root,'labels/review-implementation.json');
if(existsSync(auditPath)){console.log('Reviewed truth changes are already materialized; no overwrite.');process.exit(0);}
const changes=[];
for(const storyId of ['second_cairn','unclaimed_lane','unclaimed_pedestal']){
 const file=path.join(root,'truth',storyId+'.json'),before=readFileSync(file),truth=JSON.parse(before);
 const facts=reviewed.items.filter(i=>i.chapterId.startsWith(storyId+'-')&&i.type==='fact'&&i.authorVerdict==='change');
 for(const item of facts){const chapter=Number(item.chapterId.split('-c')[1]),index=Number(item.aiLabel.id.slice(2))%100-1,row=truth.chapters[chapter-1].facts[index],replacement=item.changedTo;
  assert.equal(row.subject,item.aiLabel.subject,item.itemId);assert.equal(row.predicate,item.aiLabel.predicate,item.itemId);
  for(const key of ['subject','predicate','object','validFrom','validUntil'])if(Object.hasOwn(replacement,key))row[key]=structuredClone(replacement[key]);
  if(item.itemId==='second_cairn-c3:fact:F-301'){
   const sentences=read(path.join(root,'acceptance/sentences',item.chapterId+'.json'));
   row.anchor=replacement.evidence.map(ref=>{const sentence=sentences.find(s=>s.id===ref);assert(sentence);return sentence.text;}).join(' ');
   assert(readFileSync(path.join(root,'acceptance/chapters',item.chapterId+'.md'),'utf8').includes(row.anchor));
  }
 }
 if(storyId==='second_cairn')Object.assign(truth.places,{lower_path:'the lower river path below the shelter',high_traverse:'the high traverse above the flood line',relief_boat:'the relief boat, distinct from the expedition canoe'});
 const quantity=facts.find(i=>i.changedTo.subjectScope==='shared_story_resource_account').changedTo;
 truth.sharedResources=[{key:quantity.subject,predicate:quantity.predicate,scope:'shared_story_resource_account',description:storyId==='second_cairn'?'The expedition’s jointly used measured water supply.':storyId==='unclaimed_lane'?'The team’s jointly used travel fund.':'The exhibition’s petty-cash account.',steward:truth.protagonist,stewardIsNotPersonalOwner:true,matchingPolicy:'A semantically identical shared-account subject may match one-to-one; do not interpret the steward character as personal ownership or merge unrelated accounts.'}];
 const after=JSON.stringify(truth,null,2)+'\n';writeFileSync(file,after);changes.push({path:'truth/'+storyId+'.json',beforeSha256:sha(before),afterSha256:sha(after),changedFactLabels:facts.map(i=>i.itemId)});
}
const sourceChapters=[];
for(const id of ['second_cairn','unclaimed_lane','unclaimed_pedestal'])for(let chapter=1;chapter<=3;chapter++){const p=`acceptance/chapters/${id}-c${chapter}.md`;sourceChapters.push({path:p,sha256:sha(readFileSync(path.join(root,p)))});}
write('labels/review-implementation.json',{date:'2026-10-30',sourceReview:'labels/delegated-review.json',sourceReviewSha256:sha(readFileSync(snapshot)),reviewIdentity:reviewed.reviewer,originalItems:219,agreed:195,changesApplied:24,requiredCorrections:15,sharedResourceClarifications:9,proseChanged:false,sourceChapters,truthChanges:changes,note:'Truth facts adopt independent route subjects, bounded appointment and route times, terminal boat location and stable shared accounts. Evidence/via/acquisition corrections are applied as a reviewed gold overlay. No core or frozen dataset is modified.'});
console.log('Archived 219-item delegated review and revised truth for all 24 changes; prose is unchanged.');
