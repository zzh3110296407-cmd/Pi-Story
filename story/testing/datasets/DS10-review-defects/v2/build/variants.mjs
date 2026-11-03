import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
export const categories=['characterisation','factual_details','narrative_style','timeline_plot','world_setting','ledger_violation'];
export function constructVariant({root,t,c,chapter,ordinal,variant,clean,ledger,bibleAdditions}){
 const chapterId=t.id+'-c'+chapter,id=chapterId+(variant===0?'-control':'-injected-'+variant);
 if(variant===0)return {id,text:clean,defects:[],injectionOrder:[]};
 const selected=[0,1].map(i=>categories[(ordinal*4+(variant-1)*2+i)%6]);
 let text=clean.trimEnd(),defects=[];const injectionOrder=[];
 const hero=t.cast[t.protagonist.slice(5)].split(' ')[0];
 if(selected.includes('narrative_style')&&t.id!=='second_cairn'){
  const rewritten=readFileSync(path.join(root,'acceptance/design',chapterId+'-first-person.md'),'utf8').trimEnd();
  const oldBody=clean.slice(clean.indexOf('\n\n')+2).trimEnd(),newBody=rewritten.slice(rewritten.indexOf('\n\n')+2);
  assert.notEqual(oldBody,newBody);assert((newBody.match(/\bI\b/gu)??[]).length>=20);
  text=rewritten;defects.push({category:'narrative_style',severity:'major',objective:true,scope:'structural',original:oldBody,changed:newBody,spans:[{original:oldBody,changed:newBody}],sources:[{kind:'ledger',ref:'L-2',quote:ledger[1].text}],reason:'The protagonist narrates the actual action, perception and reflection in first person across the body. Restoring third person requires recasting passages throughout; no removable framing encloses an untouched third-person chapter.',repairRequirement:'Restore the narrative person throughout the chapter while preserving events and epistemic qualifications.',reviewStatus:'pending_semantic_and_scope_review'});injectionOrder.push('narrative_style');
 }
 for(const category of selected){
  if(category==='narrative_style'&&t.id!=='second_cairn')continue;
  let inserted,sources,reason,severity='major';
  if(category==='characterisation'){
   const opposite=t.dominantHand==='left-handed'?'right-handed':'left-handed';
   inserted=`${hero} had been ${opposite} from birth and had never been ${t.dominantHand}.`;
   sources=[{kind:'bible',ref:t.protagonist,quote:bibleAdditions[0].card.embodiment}];reason='Unquoted narration reverses the explicit lifelong dominant-hand invariant; an injury or temporary use of the other hand cannot explain it.';
  }else if(category==='factual_details'){
   const f=c.facts[2];inserted=`With no intervening gain or loss after that completed count, the very same balance was ${f.object.value+7} ${f.object.unit}, not ${f.object.value} ${f.object.unit}.`;
   sources=[{kind:'current_chapter_narration',quote:f.anchor},{kind:'chapter_intent',ref:'mustKeep[1]',quote:f.anchor}];reason='The correct narrated count is retained in this actual variant; the added count contradicts that same completed balance with all intervening changes explicitly excluded.';
  }else if(category==='narrative_style'){
   inserted='I am standing here now and I can feel the next decision waiting. I want the reader to hear my voice before this scene goes on.';
   sources=[{kind:'ledger',ref:'L-2',quote:ledger[1].text},{kind:'ledger',ref:'L-3',quote:ledger[2].text}];reason='One plainly removable narrator aside breaks third-person past action. Deleting this paragraph restores the untouched body, so the scope is local.';
  }else if(category==='timeline_plot'){
   inserted=t.id==='unclaimed_lane'?'In the ordinary waking present, Coach Roland entered alive and shook Nessa’s hand; this was neither a memory nor an imagined scene.':t.id==='unclaimed_pedestal'?'In the ordinary waking present, Orson entered alive and shook Tom’s hand; this was neither a memory nor an imagined scene.':chapter===1?'Eamon had already died before this expedition began and had never returned alive, although the same present expedition included his living actions.':'In the ordinary waking present, Eamon stepped off the relief boat alive and spoke to Jun; he had not been revived and this was neither a memory nor an imagined scene.';
   sources=[{kind:'bible',ref:'rule:chronology',quote:bibleAdditions[1].value}];severity='blocking';reason='The actual-world event contradicts the explicit life/death chronology; dream, memory, temporal uncertainty and a new revival are expressly excluded.';
  }else if(category==='world_setting'){
   inserted=t.id==='unclaimed_lane'?'Without any key turning, the still-intact locked calibration cabinet opened through its built-in electronic release.':t.id==='unclaimed_pedestal'?'While its paper roll was removed and no other paper was supplied, the intact receipt machine printed a new paper receipt.':'The intact river gate moved fully open by itself while the hand capstan stayed motionless and no one operated it.';
   sources=[{kind:'bible',ref:'rule:mechanism',quote:t.rule},{kind:'ledger',ref:'L-4',quote:ledger[3].text}];severity='blocking';reason='A narrated actual event violates the supplied mechanism rule under the exact conditions the rule excludes.';
  }else{
   const partner=t.cast[Object.keys(t.cast)[1]].split(' ')[0];inserted=`${partner} died permanently at that moment, and the death was confirmed before the chapter ended.`;
   sources=[{kind:'ledger',ref:'L-7',quote:ledger[6].text}];severity='blocking';reason='A confirmed permanent death violates the explicit author requirement to keep this named person alive through chapter three.';
  }
  text+='\n\n'+inserted;defects.push({category,severity,objective:true,scope:'local',original:'',changed:inserted,spans:[{original:'',changed:inserted}],sources,reason,reviewStatus:'pending_author_review'});injectionOrder.push(category);
 }
 text+='\n';
 // Preserve deterministic category order even though the full rewrite is applied first.
 defects=selected.map(category=>defects.find(d=>d.category===category));
 for(const [i,d]of defects.entries()){
  d.id=id+'-defect-'+(i+1);
  for(const span of d.spans){const at=text.indexOf(span.changed);assert(at>=0);assert.equal(text.indexOf(span.changed,at+1),-1);span.lines={start:text.slice(0,at).split('\n').length,end:text.slice(0,at+span.changed.length).split('\n').length};}
  d.lines=[...new Set(d.spans.flatMap(s=>Array.from({length:s.lines.end-s.lines.start+1},(_,j)=>s.lines.start+j)))];
 }
 assert.equal(defects.length,2);return {id,text,defects,injectionOrder};
}
