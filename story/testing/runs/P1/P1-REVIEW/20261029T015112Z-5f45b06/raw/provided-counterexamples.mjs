import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { submitConstraints, authorControl } from 'file:///D:/AI/Story%20Dome/Story/pi-Story/story/packages/core/src/control/index.ts';
import { foldBranch } from 'file:///D:/AI/Story%20Dome/Story/pi-Story/story/packages/core/src/fold/index.ts';
import { writerInput, editorInput } from 'file:///D:/AI/Story%20Dome/Story/pi-Story/story/packages/core/src/flow/inputs.ts';
import { writeNextChapter } from 'file:///D:/AI/Story%20Dome/Story/pi-Story/story/packages/core/src/flow/next.ts';
import { context } from 'file:///D:/AI/Story%20Dome/Story/pi-Story/story/packages/core/test/context.ts';
import { author, tool } from 'file:///D:/AI/Story%20Dome/Story/pi-Story/story/packages/core/test/fixtures.ts';
const entries=[author('a','主角不能死亡。')];
const initial=await submitConstraints(context(entries),{op:'submit',items:[{kind:'story',text:'主角不能死亡。',quotes:['主角不能死亡。']}]});
assert(initial.ok);entries.push(tool('ledger','submit_constraints',initial.details));
const changed=authorControl(foldBranch(entries),{field:'ledger_edit',ledgerPatch:[{id:'L-1',op:'set',text:'主角必须死亡。'}]});
assert(changed.ok);entries.push({kind:'custom',entryId:'author-edit',customType:'story.control',data:changed.details});
const m=foldBranch(entries);
const results={ledgerEdit:{commandAccepted:changed.ok,ledger:m.ledger,writerLedger:writerInput(m).ledger}};
const scenarios=JSON.parse(readFileSync('D:/AI/Story Dome/Story/pi-Story/story/testing/datasets/DS04-eligibility-flow/v2/scenarios.json','utf8'));
const normal=scenarios.find(s=>s.command==='macro'&&s.expected.ok&&s.script.length===3);
assert(normal,'Need an existing successful three-call macro fixture');
const source=structuredClone(normal.entries);
const ctx=context(source);
const controller=new AbortController();ctx.signal=controller.signal;
let index=0;
const cancellationTrace=[];
ctx.ports.models.call=async req=>{
 const response=structuredClone(normal.script[index++]);assert.equal(req.role,response.role);
 if(req.role==='keeper') {
  cancellationTrace.push({event:'keeper completed normally',signalAborted:controller.signal.aborted});
  queueMicrotask(()=>{controller.abort();cancellationTrace.push({event:'cancellation delivered before core resumes',signalAborted:controller.signal.aborted});});
 }
 return response;
};
const result=await writeNextChapter(ctx,normal.input);
results.abortAtKeeperCompletion={sourceScenario:normal.id,cancellationTrace,signalAborted:controller.signal.aborted,ok:result.ok,committed:Boolean(result.details?.commit),error:result.error??null,calls:result.details?.calls.length};
writeFileSync('D:/开源/test/pi-Story/p1/review-20261029/counterexamples.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
