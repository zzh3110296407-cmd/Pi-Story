import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import path from 'node:path';
import {stateAt} from '../../../../datasets/DS09-state-gold/v1/build/fixture-lib.mjs';
const clone=v=>structuredClone(v);
const categories=['characterisation','factual_details','narrative_style','timeline_plot','world_setting','ledger_violation'];
export function constructVariant({root,t,p,c,chapter,chapterId,variant,ordinal,clean,model,ledger,storyContext,review,redesign}){
 const id=chapterId+(variant===0?'-control':'-injected-'+variant);if(variant===0)return {id,text:clean,defects:[],injectionOrder:[]};
 const chosen=[categories[(ordinal*4+(variant-1)*2)%6],categories[(ordinal*4+(variant-1)*2+1)%6]];
 const effective=(defect)=>{if(t.split!=='acceptance')return defect;const r=review.items.find(r=>r.itemId===defect.id);assert(r);assert.equal(r.aiLabel.category,defect.category);return clone(r.authorVerdict==='change'?r.changedTo:r.aiLabel);};
 const scopeRepair=d=>({...d,reviewIdentity:'AI delegated by user',reviewSource:'labels/delegated-review.json',reviewStatus:'r1_review_applied'});
 const chronologySources=()=>{const sources=[{kind:'bible',ref:'rule:chronology',quote:storyContext.bibleAdditions[1].value}],prior=stateAt(model).facts.find(f=>f.subject===p.deadId&&f.predicate==='alive');if(prior)sources.push({kind:'state',ref:prior.id,quote:JSON.stringify(prior.object)});return sources;};
 const event=t.id==='bakery_apartment'?'Naomi’s father walked in alive and asked what they were doing.':chapter===1?`${p.dead==='the old tree'?'The old tree':p.dead} had already been dead for ten years before this visit began.`:t.id==='borrowed_rain'?'The same old tree was alive again, its original trunk carrying new sap, before the present scene ended.':`${p.dead} walked into the present scene alive and uninjured and asked a question.`;
 const strong=redesign.cases.find(x=>x.variantId===id);let text=clean;const defects=[];let injectionOrder=[];
 if(strong){
  assert(chosen.includes('narrative_style')&&chosen.includes('timeline_plot'));const prose=readFileSync(path.join(root,strong.file),'utf8');assert(!prose.includes('\r'));assert(prose.trimEnd().endsWith(strong.closing));
  const style={id:id+'-defect-2',category:'narrative_style',severity:'major',objective:true,scope:'structural',revision:'r2-full-chapter-replacement',original:clean.trimEnd(),changed:prose.trimEnd(),spans:[{original:clean.trimEnd(),changed:prose.trimEnd()}],sources:[{kind:'ledger',ref:'L-2',quote:ledger[1].text}],reason:redesign.scopeRationale,reviewSource:'labels/delegated-review.json',reviewStatus:'requires_supplemental_review',replaces:'r1 four removable framing insertions; their reviewed scope remains local in the immutable review record',repairRequirement:'Recast the narrative mode across the entire body, including action subjects and access to other characters’ minds. No source paragraph survives behind a removable aside.',designedSource:strong.file};
  let timeline=effective({id:id+'-defect-1',category:'timeline_plot'});timeline={...scopeRepair(timeline),revision:'r2-anchor-in-rewritten-prose',original:strong.closing,changed:strong.closing+' '+event,spans:[{original:strong.closing,changed:strong.closing+' '+event}],sources:chronologySources(),reviewStatus:'requires_supplemental_review',reason:'The final waking action contradicts the supplied death chronology. The semantic defect is retained but its first-person closing anchor and evidence are new.'};
  text=prose.trimEnd()+' '+event+'\n';defects.push(timeline,style);injectionOrder=['narrative_style','timeline_plot'];
 }else{
  for(const category of chosen.filter(c=>c!=='narrative_style')){
   const itemId=id+'-defect-'+(defects.length+1);let original,changed,sources,reason,severity='major';
   if(category==='characterisation'){original=c.facts[0].anchor;const opposite=p.hand==='left-handed'?'right-handed':'left-handed';changed=original+` ${p.hero} had been ${opposite} from birth and had never been ${p.hand}.`;sources=[{kind:'bible',ref:'char:'+Object.keys(t.cast)[0],quote:storyContext.bibleAdditions[0].card.embodiment}];reason='Unquoted narration reverses the explicit lifetime dominant-hand attribute.';}
   if(category==='factual_details'){original=c.facts[2].anchor;changed=original+` With no intervening gain or loss, that same completed count stood at ${c.facts[2].object.value+7} ${c.facts[2].object.unit}.`;sources=[{kind:'current_chapter_narration',quote:original},{kind:'chapter_intent',ref:'mustKeep[1]',quote:original,note:'An actual supplied authoring target, not previously committed canon.'}];reason='The correct narrated completed count is retained in the final variant. An immediately following narrated total contradicts that same count while explicitly ruling out an intervening change. No character’s speech or removed source sentence is treated as independent truth.';}
   if(category==='world_setting'){original=c.facts[0].anchor;changed=original+' '+p.world;sources=[{kind:'bible',ref:'rule:physical_limit',quote:t.rule},{kind:'ledger',ref:'L-4',quote:ledger[3].text}];reason='Actual-world narration violates the supplied physical rule.';severity='blocking';}
   if(category==='ledger_violation'){original=c.knows;changed=original+' '+p.ledgerDeath;sources=[{kind:'ledger',ref:'L-7',quote:ledger[6].text}];reason='A permanent death contradicts the named author keep-alive requirement.';severity='blocking';}
   if(category==='timeline_plot'){original=c.endStateAnchor;changed=original+' '+event;sources=chronologySources();reason='The waking present contradicts the supplied life/death sequence outside dreams, recollections and hypotheticals.';severity='blocking';}
   let d={id:itemId,category,severity,objective:true,scope:'local',original,changed,spans:[{original,changed}],sources,reason};
   if(t.split==='acceptance')d=scopeRepair(effective(d));
   if(category==='factual_details')d={...d,original,changed,spans:[{original,changed}],sources,reason,revision:'r2-retained-narrated-count',reviewStatus:t.split==='acceptance'?'requires_supplemental_review':'AI_development_only'};
   if(category==='timeline_plot')d.sources=chronologySources();
   assert(text.includes(d.original),`${id}: original missing`);assert.equal(text.indexOf(d.original,text.indexOf(d.original)+1),-1);text=text.replace(d.original,d.changed);defects.push(d);
  }
  if(chosen.includes('narrative_style')){
   const paragraphs=text.trimEnd().split('\n\n'),indices=[0,Math.floor(paragraphs.length/3),Math.floor(paragraphs.length*2/3),paragraphs.length-2],spans=[];
   indices.forEach((at,j)=>{const original=paragraphs[at],changed=p.frames[j]+' '+original;paragraphs[at]=changed;spans.push({original,changed,inserted:p.frames[j]});});
   let d={id:id+'-defect-'+(defects.length+1),category:'narrative_style',severity:'major',objective:true,scope:'local',original:spans.map(s=>s.original).join('\n\n[noncontiguous passage]\n\n'),changed:spans.map(s=>s.changed).join('\n\n[noncontiguous passage]\n\n'),spans,sources:[{kind:'ledger',ref:'L-2',quote:ledger[1].text},{kind:'ledger',ref:'L-3',quote:ledger[2].text}],reason:'Deleting the four clearly delimited insertions restores the original narration; their distribution does not make this structural.'};
   if(t.split==='acceptance')d=scopeRepair(effective(d));assert.equal(d.scope,'local');text=paragraphs.join('\n\n')+'\n';defects.push(d);
  }
  injectionOrder=chosen.filter(c=>c!=='narrative_style').concat(chosen.includes('narrative_style')?['narrative_style']:[]);
 }
 const lines=text.split('\n'),range=fragment=>{const at=text.indexOf(fragment);assert(at>=0,`${id}: final fragment absent`);assert.equal(text.indexOf(fragment,at+1),-1);return {start:text.slice(0,at).split('\n').length,end:text.slice(0,at+fragment.length).split('\n').length};};
 for(const d of defects){for(const s of d.spans)s.lines=range(s.changed);d.lines=[...new Set(d.spans.flatMap(s=>Array.from({length:s.lines.end-s.lines.start+1},(_,j)=>s.lines.start+j)))].filter(n=>lines[n-1].trim()).sort((a,b)=>a-b);for(const s of d.sources)if(s.kind==='current_chapter_narration'){const r=range(s.quote);s.ref='line:'+r.start;}}
 assert.equal(defects.length,2);return {id,text,defects,injectionOrder};
}
