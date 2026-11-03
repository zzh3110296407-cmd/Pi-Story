import assert from 'node:assert/strict';import {readFileSync,existsSync} from 'node:fs';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
export const review=existsSync(root+'labels/delegated-review.json')?JSON.parse(readFileSync(root+'labels/delegated-review.json','utf8')):null;
export const freezeApproval=existsSync(root+'labels/freeze-authorization.json')?JSON.parse(readFileSync(root+'labels/freeze-authorization.json','utf8')):null;
const baseline=existsSync(root+'labels/review-sentence-baseline.json')?JSON.parse(readFileSync(root+'labels/review-sentence-baseline.json','utf8')):null;
const revisions=existsSync(root+'labels/prose-revision.json')?JSON.parse(readFileSync(root+'labels/prose-revision.json','utf8')):null;
const groups=[['facts','fact'],['claims','claim'],['cognitions','cognition'],['relations','relation'],['hooks','hook'],['mustNotRecord','mustNotRecord'],['uncertainties','uncertainty']];
export function applyReviewedGold(gold,currentSentences,split){
 const objects=groups.flatMap(([field,type])=>gold[field].map(label=>({field,type,label})));
 if(split!=='acceptance'||!review){
  // Development: remembered chapter-one locations are history, never a second simultaneous location.
  gold.historicalReferences=[];
  if(gold.chapter===2){const old=gold.facts.find(f=>f.id==='F-280');if(old){gold.facts=gold.facts.filter(f=>f!==old);gold.historicalReferences.push({...old,recordPolicy:'narrative_history_only',expectedOperation:'no_new_state_fact',note:'A within-chapter remembered location does not create a second single-valued fact at that chapter granularity.'});}}
  for(const k of gold.cognitions)if(k.supersededBy)k.recordPolicy='historical_attitude_not_required_as_active_add';
  return {gold,items:objects.map(({type,label},j)=>({itemId:`${gold.id}-item-${j+1}`,chapterId:gold.id,type,aiLabel:label,evidence:label.evidence.map(ref=>({ref,text:currentSentences.find(s=>s.id===ref).text})),authorVerdict:null,changedTo:null,note:null}))};
 }
 const byId=new Map(review.items.filter(r=>r.chapterId===gold.id).map(r=>[r.itemId,r]));assert.equal(byId.size,objects.length);
 const mapRef=ref=>{const previous=baseline.chapters[gold.id].find(s=>s.id===ref);assert(previous,`Missing review baseline ${ref}`);const replacement=revisions?.sentences.find(s=>s.chapterId===gold.id&&s.original===previous.text);const wanted=replacement?.changed??previous.text;const found=currentSentences.filter(s=>s.text===wanted);assert.equal(found.length,1,`${gold.id} evidence no longer unique: ${ref}`);return found[0].id;};
 const remap=value=>typeof value==='string'&&/^c[0-9]+\.s[0-9]+$/.test(value)?mapRef(value):Array.isArray(value)?value.map(remap):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remap(v)])):value;
 for(const [field]of groups)gold[field]=[];gold.historicalReferences=[];const items=[];
 for(const [{field,type,label},j]of objects.map((o,j)=>[o,j])){
  const itemId=`${gold.id}-item-${j+1}`,r=byId.get(itemId);assert(r);assert.equal(r.type,type);assert.equal(r.aiLabel.id??r.aiLabel.key??r.aiLabel.statement,label.id??label.key??label.statement);assert(['agree','change'].includes(r.authorVerdict));
  const effective=remap(r.authorVerdict==='change'?r.changedTo:r.aiLabel);const target=effective.recordPolicy==='reference_existing'?'historicalReferences':field;gold[target].push(effective);
  items.push({itemId,chapterId:gold.id,type:target==='historicalReferences'?'historicalReference':type,originalType:type,aiLabel:effective,evidence:effective.evidence.map(ref=>({ref,text:currentSentences.find(s=>s.id===ref).text})),reviewerVerdict:r.authorVerdict,reviewSource:'labels/delegated-review.json',authorVerdict:null,changedTo:null,note:r.note});
 }
 for(const r of review.additionalItems.filter(r=>r.chapterId===gold.id)){const label=remap(r.proposedLabel);assert(!gold.cognitions.some(k=>k.id===label.id));gold.cognitions.push(label);items.push({itemId:r.itemId,chapterId:gold.id,type:'cognition',aiLabel:label,evidence:label.evidence.map(ref=>({ref,text:currentSentences.find(s=>s.id===ref).text})),reviewerVerdict:'add',reviewSource:'labels/delegated-review.json',authorVerdict:null,changedTo:null,note:r.note});}
 gold.annotation={kind:'AI_designed_then_user_delegated_AI_review',humanReviewed:false,authorReviewed:!!freezeApproval,reviewMode:freezeApproval?.reviewMode??review.reviewMode,reviewer:review.reviewer,reviewSource:'labels/delegated-review.json',authorFreezeSource:freezeApproval?'labels/freeze-authorization.json':null,reviewPolicies:review.reviewPolicies};
 if(freezeApproval)for(const i of items)i.authorVerdict='accepted_delegated_review_in_batch';
 return {gold,items};
}
