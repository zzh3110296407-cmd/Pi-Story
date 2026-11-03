import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { foldBranch } from './fixture-lib.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
export function checkTerminal(){
 const reports=[];
 for(const id of ['unclaimed_lane','unclaimed_pedestal','second_cairn']){
 const state=JSON.parse(readFileSync(root+'acceptance/end-state/'+id+'.json','utf8'));
 const last=JSON.parse(readFileSync(root+'acceptance/gold/'+id+'-c3.json','utf8'));
 const truth=JSON.parse(readFileSync(root+'truth/'+id+'.json','utf8'));
 for(const fact of last.facts.filter(f=>f.predicate==='injury')){const active=state.facts.filter(f=>f.subject===fact.subject&&f.predicate===fact.predicate&&f.mode==='narrated');assert.equal(active.length,1,`${id}: outdated injury still active`);assert.deepEqual(active[0].object,fact.object);}
 if(id==='second_cairn'){
  const position=state.facts.find(f=>f.subject==='char:rafi'&&f.predicate==='location'&&f.mode==='narrated');assert.equal(position.object,'place:relief_boat','Rafi has boarded the relief boat at the chapter end.');
  const prior=foldBranch(JSON.parse(readFileSync(root+'acceptance/entries/second_cairn-c3.json','utf8')));
  const historical=prior.commits.flatMap(c=>c.delta.factOps.upsert);
  const lower=historical.find(f=>f.id==='F-108'),high=historical.find(f=>f.id==='F-208');
  assert.equal(lower.subject,'place:lower_path');assert.equal(lower.predicate,'closure_status');assert.equal(lower.validUntil,1);
  assert.equal(high.subject,'place:high_traverse');assert.equal(high.predicate,'passability');assert.equal(high.validUntil,2);
  assert(!prior.commits.flatMap(c=>c.delta.factOps.expire).some(f=>['F-108','F-208'].includes(f.id)),'Independent route conditions must not expire one another.');
  const landing=state.facts.find(f=>f.subject==='place:landing'&&f.predicate==='condition');assert.equal(landing.object,'intact');
  assert(!state.facts.some(f=>f.predicate==='route_status'),'No route-book status conflation remains.');
 }
 const account=truth.sharedResources[0];
 for(let chapter=1;chapter<=3;chapter++){const gold=JSON.parse(readFileSync(root+`acceptance/gold/${id}-c${chapter}.json`,'utf8'));const balance=gold.facts.find(f=>f.predicate===account.predicate);assert.equal(balance.subject,account.key);assert.equal(balance.subjectScope,'shared_story_resource_account');assert.equal(balance.arithmetic.before+balance.arithmetic.change,balance.object.value);}
 const current=state.facts.find(f=>f.subject===account.key&&f.predicate===account.predicate);assert(current,'The terminal balance belongs to the shared account.');
 const temporary=id==='unclaimed_pedestal'?JSON.parse(readFileSync(root+'acceptance/gold/unclaimed_pedestal-c2.json','utf8')).facts.find(f=>f.id==='F-204'):null;
 if(temporary){assert.equal(temporary.validUntil,2);assert(temporary.object.includes('rehearsal only'));assert(!state.facts.some(f=>f.id==='F-204'),'A rehearsal-only appointment cannot remain active in chapter three.');}
 for(const k of last.cognitions.filter(k=>k.supersededBy))assert(!state.cognitions.some(o=>o.id===k.id),'Corrected misbelief must not remain active.');
 const unresolved=state.hooks.filter(h=>h.status!=='resolved');assert(unresolved.length>=1,'At least one planted hook remains open.');
 reports.push({storyId:id,terminalInjuryCorrect:true,sharedAccountConsistent:true,independentRoutesPreserved:id==='second_cairn'?true:null,terminalBoatLocation:id==='second_cairn'?true:null,temporaryAppointmentBounded:!!temporary,formerMisbeliefInactive:true,unresolvedHooks:unresolved.length});
 }
 return {stories:reports,passed:true};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])console.log(JSON.stringify(checkTerminal()));
