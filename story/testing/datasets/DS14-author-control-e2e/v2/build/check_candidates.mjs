import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {validateScenario} from './scenario-contract.mjs';
const root=path.resolve(process.argv[2]);
const repo=path.resolve('');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
let valid=0, oldCompatible=0;
let first;
const changes=[];
for (const [name,version,oldVersion] of [['DS11-showrunner-scenarios','v3','v2'],['DS14-author-control-e2e','v2','v1']]) {
 const now=path.join(root,name,version), old=path.join(repo,'story/testing/datasets',name,oldVersion);
 for(const split of ['dev','acceptance']) {
  const before=read(path.join(old,split,'index.json'));
  const current=read(path.join(now,split,'index.json'));
  assert.equal(current.cases.length,name.startsWith('DS11')?(split==='dev'?18:32):(split==='dev'?7:15));
  assert.equal(new Set(current.cases.map(row=>row.id)).size,current.cases.length);
  for(const row of current.cases) {
   assert.equal(hash(path.join(now,split,row.path)),row.sha256);
   const next=validateScenario(read(path.join(now,split,row.path))); valid++;
   assert.equal(next.split,split); assert.equal(next.id,row.id);
   const prev=before.cases.find(r=>r.id===row.id);
   if(!prev) continue;
   const prior=validateScenario(read(path.join(old,split,prev.path)));oldCompatible++;
   if(name.startsWith('DS11')) {
    first??=next;
    const stripped=structuredClone(next);
    stripped.schema=prior.schema;stripped.execution=prior.execution;
    stripped.expect.acceptable=prior.expect.acceptable;stripped.expect.judgeChecks=prior.expect.judgeChecks;
    assert.deepEqual(stripped,prior,`${row.id}: forbidden non-delta change`);
    assert.equal(next.execution.maxReadOnlyCalls,3);assert.equal(next.execution.maxShowrunnerRequests,6);
    assert.equal(next.execution.maxChapterAttempts,2);assert(!('stopAfterFirstAction' in next.execution));
    for(const action of next.expect.acceptable) {
     for(const [key,val] of Object.entries(action.argsMatch??{})) {
      assert(['chapters[0].n','changes[0].source','changes[0].op'].includes(key));
      if(key==='chapters[0].n') assert(prior.trigger.text.includes(`chapter ${val}`),row.id);
      if(key==='changes[0].source') assert.equal(val,'user');
      if(key==='changes[0].op') assert.equal(val,'set');
     }
    }
    if(JSON.stringify(prior.expect.acceptable)!==JSON.stringify(next.expect.acceptable))changes.push(row.id);
   } else assert(readFileSync(path.join(old,split,prev.path)).equals(readFileSync(path.join(now,split,row.path))));
  }
  if(name.startsWith('DS14')&&split==='acceptance')assert(readFileSync(path.join(old,split,'index.json')).equals(readFileSync(path.join(now,split,'index.json'))));
 }
}
const invalid=[];
function reject(name,mutate) {const c=structuredClone(first);mutate(c);assert.throws(()=>validateScenario(c),undefined,name);invalid.push(name);}
reject('missing read bound',c=>delete c.execution.maxReadOnlyCalls);
reject('mixed legacy stop flag',c=>c.execution.stopAfterFirstAction=true);
reject('negative read bound',c=>c.execution.maxReadOnlyCalls=-1);
reject('noninteger request bound',c=>c.execution.maxShowrunnerRequests=1.5);
reject('wrong stop target',c=>c.execution.stopAt='first_action');
reject('read as decisive acceptable',c=>c.expect.acceptable=[{tool:'read_story'}]);
reject('setup text count mismatch',c=>c.setup.find(s=>s.step==='commitChapters').texts.pop());
reject('unknown schema',c=>c.schema='story/p3-scenario@3');
reject('blank reply script',c=>c.execution.dialogResponses=[{on:'ask_author',reply:' ',delayUntilAssertion:'automatic_continuation_paused'}]);
const result={schema:'story/p3r2-candidate-delta-validation@1',status:'passed',date:'2026-11-02',cases:valid,
 oldV1CompatibleCases:oldCompatible,negativeFormatCases:invalid,acceptableChanged:changes,DS14AcceptanceCaseFilesByteIdentical:15,DS14AcceptanceIndexByteIdentical:true,
 oldDevDS14ByteIdentical:5,DS11ProtectedFieldsUnchanged:true,paidModelCalls:0};
writeFileSync(path.join(root,'delta-validation.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
