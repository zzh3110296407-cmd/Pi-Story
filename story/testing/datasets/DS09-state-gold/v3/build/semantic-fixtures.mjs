import assert from 'node:assert/strict';
import {foldBranch,stateAt} from '../../../../../packages/core/src/fold/index.ts';
import {validateDelta,singleValue} from '../../../../../packages/core/src/canon/delta.ts';
import {createDraft} from '../../../../../packages/core/src/production/index.ts';
import {context} from '../../../../../packages/core/test/context.ts';
import {validateEntries,tool} from './fixture-lib.mjs';
// These fixture predicates denote one changing condition of one designed object.
// P1 intentionally leaves injury/free predicates open-ended, so the dataset owns
// the explicit expiration when this story replaces that condition.
const replacesCurrent=predicate=>singleValue(predicate)||['injury','entry_status','delivery_status'].includes(predicate);
export function commitGold(entries,gold,text){
 const m=foldBranch(entries),chapter=gold.chapter,ctx=context(entries),draftResult=createDraft(ctx,{chapter,text});assert(draftResult.ok,JSON.stringify(draftResult.error));const draft=draftResult.details;
 const numbers=ev=>ev.map(s=>Number(s.split('.s')[1]));const state=stateAt(m),mapping=new Map();
 const proposal={facts:[],claims:[],cognitions:[],relations:[],hooks:[],summary:{title:gold.title,characters:gold.cast,events:gold.facts.filter(f=>f.key).map(f=>f.statement),mood:'Evidence, memory and uncertainty remain distinct.'},issues:[]};
 const refs=new Map(),keep=(ref,id)=>{refs.set(ref,id);return ref;};
 for(const f of gold.facts){
  assert.notEqual(f.recordPolicy,'reference_existing','Historical references do not create world facts.');
  if(f.mode!=='recalled'&&replacesCurrent(f.predicate))for(const old of state.facts.filter(o=>o.mode==='narrated'&&o.subject===f.subject&&o.predicate===f.predicate&&(o.validUntil===null||o.validUntil>=chapter)))proposal.facts.push({ref:'expire-'+old.id,op:'expire',id:old.id,validUntil:chapter-1,sentences:numbers(f.evidence)});
  const prior=state.facts.find(o=>o.subject===f.subject&&o.predicate===f.predicate&&o.mode==='narrated');
  const row={ref:keep('fact-'+f.id,f.id),op:'upsert',subject:f.subject,predicate:f.predicate,object:f.object,mode:f.mode==='recalled'?'recalled_past':'narrated',validFrom:f.validFrom,...(f.validUntil!==null?{validUntil:f.validUntil}:{}),certainty:f.certainty==='provisional'?'uncertain':'confirmed',...(f.uncertainReason?{uncertainReason:f.uncertainReason}:{}),sentences:numbers(f.evidence)};
  if(f.arithmetic&&prior){assert.equal(prior.object.value,f.arithmetic.before);row.change=f.arithmetic.change;}
  proposal.facts.push(row);
 }
 for(const s of gold.claims)proposal.claims.push({ref:keep('claim-'+s.id,s.id),speaker:s.speaker,content:s.content,sentences:numbers(s.evidence)});
 for(const k of gold.cognitions){
  if(k.recordPolicy==='historical_attitude_not_required_as_active_add'||k.supersededBy){
   const old=state.cognitions.find(o=>o.id===k.id);if(old){assert(k.supersededBy);proposal.cognitions.push({ref:'supersede-'+k.id,op:'supersede',id:k.id,by:'cognition-'+k.supersededBy,characterId:old.characterId,kind:old.kind,content:old.content,via:old.via,sentences:numbers(k.evidence)});}continue;
  }
  proposal.cognitions.push({ref:keep('cognition-'+k.id,k.id),op:'add',characterId:k.characterId,kind:k.kind,content:k.content,via:k.via,certainty:'confirmed',sentences:numbers(k.evidence)});
 }
 for(const r of gold.relations)proposal.relations.push({ref:'relation-'+r.key,op:'upsert',key:r.key,stance:r.stance,certainty:'confirmed',sentences:numbers(r.evidence)});
 for(const h of gold.hooks)proposal.hooks.push({ref:h.operation==='upsert'?keep('hook-'+h.id,h.id):'hook-'+h.id,op:h.operation,...(h.operation==='upsert'?{type:'story_question',expectedPayoff:h.statement,dependsOn:[]}:{id:h.id}),sentences:numbers(h.evidence)});
 const validated=validateDelta(m,draft,proposal);assert(validated.ok,JSON.stringify({chapter:gold.id,error:validated.error}));
 // P1 allocates canonical IDs. Map its fresh IDs to this dataset's stable reference IDs,
 // preserving the validated operations. Existing history IDs are never remapped.
 for(const [ref,id]of refs){const allocated=validated.details.refs[ref];assert(allocated);mapping.set(allocated,id);}
 const remap=v=>typeof v==='string'?(mapping.get(v)??v):Array.isArray(v)?v.map(remap):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,remap(x)])):v;
 const delta=remap(validated.details.delta),commit={schema:'story/commit@1',chapter,draftId:draft.draftId,draftDigest:draft.digest,text,sentenceRule:'s2',quality:'clean',basis:delta.basis,delta,summary:delta.summary,responses:[]};
 const result=[...entries,tool(`${gold.storyId}-commit-${chapter}`,'commit_chapter',{schema:'story/commit-result@1',ok:true,calls:[],commit})],after=validateEntries(result);assert.equal(after.lastChapter,chapter);const final=stateAt(after);
 for(const f of gold.facts.filter(f=>f.mode!=='recalled'&&replacesCurrent(f.predicate))){const active=final.facts.filter(o=>o.mode==='narrated'&&o.subject===f.subject&&o.predicate===f.predicate);assert.equal(active.length,1);assert.deepEqual(active[0].object,f.object);}
 for(const k of gold.cognitions.filter(k=>k.supersededBy))assert(!final.cognitions.some(o=>o.id===k.id),'Corrected former belief cannot stay active.');
 for(const h of gold.historicalReferences??[])if(h.existingFactId){const old=after.commits.flatMap(c=>c.delta.factOps.upsert).find(f=>f.id===h.existingFactId);assert(old);assert.equal(old.subject,h.subject);assert.equal(old.predicate,h.predicate);assert.deepEqual(old.object,h.object);assert(!delta.factOps.upsert.some(f=>f.id===h.id));}
 return result;
}
