// Feasibility regression only: normal SDK hooks and reservations, local provider.
// No role-policy quality or real-model success is inferred from scripted replies.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {fauxAssistantMessage} from '@earendil-works/pi-ai';
import {createMeasuredSession} from '../../../../../scripts/eval/p3/session.ts';
import {prepareScenario, ReplyQueue, continuation} from '../../../../../scripts/eval/p3/prepare.ts';
import {UsageLedger} from '../../../../../scripts/eval/p2/ledger.ts';
import {RunControl} from '../../../../../scripts/eval/p2/run-control.ts';

const [oldRoot, newRoot, workRoot, output] = process.argv.slice(2).map(p=>path.resolve(p));
assert(oldRoot && newRoot && workRoot && output);
const repo = path.resolve(oldRoot, '../../../../../');
const execRoot = path.join(repo, 'story/testing/exec');
assert(path.relative(execRoot, workRoot) && !path.relative(execRoot, workRoot).startsWith('..'));
mkdirSync(workRoot, {recursive:true});
const ledger = new UsageLedger(path.join(workRoot,'usage.jsonl'), path.join(workRoot,'reservations.jsonl'));
const results=[];
for (const [version, root] of [['v1',oldRoot], ['v2',newRoot]]) {
 for (const file of ['dev/ds11-h01-dev.json','acceptance/ds11-h01.json']) {
  const scenario=JSON.parse(readFileSync(path.join(root,file),'utf8'));
  const queue=new ReplyQueue();
  let fixture;
  let generated=0;
  const reservations=[];
  const observed=[];
  const errors=[];
  const caseWork=path.join(workRoot,version,scenario.id);
  fixture=await createMeasuredSession({
   work:caseWork,archive:path.join(caseWork,'archive'),suiteId:'DS11-V2-OFFLINE-REGRESSION',
   runId:`${version}-${scenario.id}`,caseId:scenario.id,ledger,control:new RunControl(),runLimitUsd:1,
   main:'faux',internals:'faux',price:true,maxShowrunnerRequests:1,
   reply:context=>{
    if(fixture.phase==='preparation')return queue.next(context);
    generated++;
    return fauxAssistantMessage('The chapter workflow exhausted its call allowance. No further chapter was committed. I have stopped and will wait for an author budget change.');
   },
   extension:pi=>{
    pi.on('agent_before_settle',event=>({entries:event.entries,continue:false}));
   },
   onEvidence:record=>observed.push(record),
  });
  try {
   await fixture.session.bindExtensions({mode:'print',onError:event=>errors.push(event.error)});
   const runner=fixture.session.extensionRunner;
   assert(runner);
   await fixture.session.bindExtensions({mode:'print',uiContext:{...runner.getUIContext(),notify:(message,severity)=>observed.push({type:'notice',message,severity})},onError:event=>errors.push(event.error)});
   await prepareScenario(fixture,scenario,queue);
   const before=structuredClone(fixture.story.current().source.model());
   const guard=fixture.story.current().services.guard;
   const reserve=guard.reserve.bind(guard);
   // Record the real result without changing it, the budget or any stop state.
   guard.reserve=request=>{
    const result=reserve(request);
    reservations.push({role:request.role,ok:result.ok,costUsd:result.costUsd??null,error:result.error?.code??null});
    return result;
   };
   const beforeCount=fixture.manager.getBranch().length;
   await fixture.measure();
   await continuation(fixture,scenario.trigger.text);
   const after=fixture.story.current().source.model();
   const successful=fixture.manager.getBranch().slice(beforeCount).filter(e=>e.type==='message'&&e.message.role==='assistant'&&!['error','aborted'].includes(e.message.stopReason));
   assert.deepEqual(errors,[]);
   assert.equal(before.lastChapter,2);
   assert.deepEqual(before.commits,after.commits);
   assert.equal(reservations.length,1);
   assert.equal(reservations[0].role,'showrunner');
   if(version==='v1') {
    assert.equal(generated,0);
    assert.equal(successful.length,0);
    assert.equal(reservations[0].error,'BUDGET_EXHAUSTED');
    assert.equal(fixture.story.current().stopReason,'budget_exhausted');
   } else {
    assert.deepEqual(before.policy.budget,{perChapterCalls:3});
    assert.equal(generated,1);
    assert.equal(successful.length,1);
    assert.equal(reservations[0].ok,true);
    assert.equal(reservations[0].costUsd,0.006);
    assert(!successful[0].message.content.some(block=>block.type==='toolCall'));
   }
   assert(observed.filter(e=>e.type==='model_call').every(e=>e.paid===false));
   fixture.finish();
   results.push({version,id:scenario.id,providerGenerations:generated,normalShowrunnerReservation:reservations[0],successfulLocalReplies:successful.length,priorCommitsUnchanged:true,paidModelCalls:0});
  } finally {
   if(fixture.session.isStreaming)await fixture.session.abort();
   fixture.dispose();
  }
 }
}
const report={schema:'story/ds11-h01-reservation-regression@1',date:'2026-11-01',identity:'Codex AI; deterministic local regression',status:'passed',realModelMeasured:false,paidModelCalls:0,scope:'Two H01 fixtures only. Preparation uses the contracted scripted prior error. The measured local reply checks dispatch feasibility through normal before_provider_request; it is not a T02/T03 model judgment.',results};
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,probes:results.length,v1Blocked:results.filter(r=>r.version==='v1'&&r.providerGenerations===0).length,v2Admitted:results.filter(r=>r.version==='v2'&&r.providerGenerations===1).length,paidModelCalls:0}));
