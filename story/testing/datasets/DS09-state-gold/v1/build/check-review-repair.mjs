import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import path from 'node:path';
import {fileURLToPath} from 'node:url';import {context} from '../../../../../packages/core/test/context.ts';
import {createDraft} from '../../../../../packages/core/src/production/index.ts';
import {validateDelta} from '../../../../../packages/core/src/canon/delta.ts';
import {foldBranch,stateAt} from '../../../../../packages/core/src/fold/index.ts';
export function checkReviewRepair(){
 const root=fileURLToPath(new URL('../',import.meta.url)),read=p=>JSON.parse(readFileSync(path.join(root,p),'utf8')),review=read('labels/delegated-review.json'),regressions=[];
 for(const id of ['bakery_apartment-c2','last_impression-c2','quiet_europa-c2']){
  const ctx=context(read('acceptance/entries/'+id+'.json')),g=read('acceptance/gold/'+id+'.json'),draft=createDraft(ctx,{chapter:2,text:readFileSync(path.join(root,'acceptance/chapters/'+id+'.md'),'utf8')});assert(draft.ok);
  const old=review.items.find(r=>r.chapterId===id&&r.aiLabel.id==='F-280').aiLabel,empty={facts:[],claims:[],cognitions:[],relations:[],hooks:[],summary:{title:g.title,characters:g.cast,events:[],mood:'Historical reference regression'},issues:[]};
  const before=validateDelta(ctx.model,draft.details,{...empty,facts:[{ref:'duplicate-recall',op:'upsert',subject:old.subject,predicate:old.predicate,object:old.object,mode:'recalled_past',validFrom:old.validFrom,validUntil:old.validUntil,certainty:'confirmed',sentences:old.evidence.map(ref=>Number(ref.split('.s')[1]))}]});assert(!before.ok);assert.equal(before.error.code,'DOMAIN_INVALID');
  assert(!g.facts.some(f=>f.id==='F-280'));assert(g.historicalReferences.some(f=>f.existingFactId==='F-101'));const after=validateDelta(ctx.model,draft.details,empty);assert(after.ok);regressions.push({chapterId:id,before:before.error.code,after:'pass_omit_duplicate_and_retain_historical_reference'});
 }
 const corrected=[];for(const r of review.additionalItems){const final=read('acceptance/end-state/'+r.chapterId.replace(/-c[123]$/,'')+'.json');const oldId=r.proposedLabel.id==='K-15'?'K-12':'K-22';assert(!final.cognitions.some(k=>k.id===oldId));assert(final.cognitions.some(k=>k.id===r.proposedLabel.id&&k.kind==='knows'));corrected.push({chapterId:r.chapterId,oldId,correctedId:r.proposedLabel.id});}
 for(const id of ['bakery_apartment','last_impression','quiet_europa'])for(let c=1;c<=3;c++){const g=read(`acceptance/gold/${id}-c${c}.json`);assert(!g.cognitions.some(k=>k.acquiredChapter===0));}
 const trap=read('acceptance/gold/quiet_europa-c2.json').mustNotRecord.find(t=>t.kind==='plan');assert.equal(trap.scope,'source_sentence_only');assert.equal(trap.laterConfirmation.length,3);
 const miriam=read('acceptance/end-state/last_impression.json').cognitions;assert(!miriam.some(k=>k.characterId==='char:miriam'&&k.acquiredChapter===3&&k.kind==='knows'));
 return {scope:'P1 semantic validation only; no P2/model/evaluation calls',regressions,correctedBeliefs:corrected,unknownBeliefStartsNotFabricated:true,trapAllowsIndependentLaterCompletion:true,miriamAcceptanceNotInvented:true};
}
