import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import * as core from '@pi-story/core';

const [source,folder,output]=process.argv.slice(2).map(p=>path.resolve(p));
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const hash=x=>createHash('sha256').update(x).digest('hex');
const results=[];
const changed=[];
const categories={A:3,B:3,C:2,D:3,E:3,F:3,G:4,H:2,I:2,J:2,K:2,L:2,M:1};
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
function env(entries) {
 return {model:core.foldBranch(entries),batch:{committed:false},settings:{localRevision:true,roles:Object.fromEntries(['writer','editor','keeper','verifier'].map(r=>[r,{model:'faux-p3-fixture',maxTokens:4096}]))},ports:{entries:{branch:()=>entries,authorMessage:id=>entries.find(x=>x.entryId===id&&x.kind==='authorMessage')?.text??null},models:{call:async()=>{throw Error('Unscripted model call prohibited');}},prices:{price:()=>null},rules:{get:name=>`Local preparation ${name}; no product policy loaded.`},interjections:{seq:()=>0},budget:{reserve:()=>({ok:true,reservationId:'fixture-reservation',costUsd:0}),settle:()=>{}}}};
}
function persist(entries,tool,result) {
 entries.push({kind:'toolResult',entryId:`fixture-${entries.length}`,toolName:tool,isError:!result.ok,details:result.details??{schema:'story/error@1',tool,error:result.error}});
}
function command(entries,text) {
 const [name,...args]=text.split(' '),value=args.join(' '),model=core.foldBranch(entries);
 let result,type;
 if(name==='/intent'||name==='/focus') {type='story.control';result=core.authorControl(model,{field:name==='/intent'?'author_intent':'current_focus',text:value});}
 else if(name==='/goal') {type='story.goal';result=core.authorGoal(model,{targetChapter:value==='off'?null:Number(value)});}
 else if(name==='/budget') {type='story.goal';result=core.authorGoal(model,{budget:value==='off'?null:Object.fromEntries(args.map(a=>{const [k,v]=a.split('=');return [k==='usd'?'costUsd':k,Number(v)];}))});}
 else throw Error(`Unknown DS11 preparation command: ${name}`);
 assert(result.ok,JSON.stringify(result.error));
 entries.push({kind:'custom',entryId:`fixture-${entries.length}`,customType:type,data:result.details});
}
for(const split of ['dev','acceptance']) {
 const index=read(path.join(folder,split,'index.json'));
 const oldIndex=read(path.join(source,split,'index.json'));
 assert.equal(index.cases.length,split==='dev'?15:32);
 for(const [n,row] of index.cases.entries()) {
  assert.equal(row.id,oldIndex.cases[n].id);
  const bytes=readFileSync(path.join(folder,split,row.path));
  const oldBytes=readFileSync(path.join(source,split,row.path));
  assert.equal(hash(bytes),row.sha256);
  assert(!bytes.includes(13));assert(!bytes.subarray(0,3).equals(Buffer.from([239,187,191])));
  const scenario=JSON.parse(bytes),old=JSON.parse(oldBytes);
  assert.equal(scenario.id,row.id);assert.equal(scenario.split,split);assert.equal(scenario.mode,'real');
  if(['ds11-h01-dev','ds11-h01'].includes(row.id)) {
   const expected=structuredClone(old);
   expected.setup.find(s=>s.step==='command').text='/budget perChapterCalls=3';
   const error=expected.setup.find(s=>s.step==='toolCall').result.error;
   error.message='The chapter workflow reached its perChapterCalls limit of 3.';
   error.hint='Report the chapter-call budget stop and do not retry without an author budget change.';
   assert.deepEqual(scenario,expected,'Only the authorized three H01 setup fields may change');
   changed.push({id:row.id,path:`${split}/${row.path}`,beforeSha256:hash(oldBytes),afterSha256:hash(bytes)});
  } else assert(bytes.equals(oldBytes),`${row.id} must be byte-identical to v1`);
  const entries=[{kind:'authorMessage',entryId:'fixture-author',text:scenario.storyPrompt}];
  let commits=0,calls=0;
  for(const step of scenario.setup) {
   if(step.step==='open') {
    for(const [tool,fn,input] of [['submit_constraints',core.submitConstraints,step.constraints],['submit_bible',core.submitBible,step.bible],['submit_outline',core.submitOutline,step.outline]]) {
     const result=await fn(env(entries),input);assert(result.ok,`${scenario.id} ${tool}: ${JSON.stringify(result.error)}`);persist(entries,tool,result);
    }
   } else if(step.step==='commitChapters') {
    assert.equal(step.texts.length,step.count);
    for(const [i,text] of step.texts.entries()) {
     const ctx=env(entries),roles=[];
     const target=ctx.model.outline.find(c=>c.n===ctx.model.lastChapter+1);
     ctx.ports.models.call=async request=>{
      calls++;roles.push(request.role);
      let json;
      if(request.role==='editor')json={observations:[]};
      if(request.role==='keeper') {
       const input=JSON.parse(request.user);
       const hooks=step.keeperHooks[i].map(({evidenceText,...hook})=>{
        const matches=input.sentences.filter(s=>s.text===evidenceText);assert.equal(matches.length,1);
        return {...hook,sentences:[matches[0].n]};
       });
       json={facts:[],claims:[],cognitions:[],relations:[],hooks,summary:{title:target.title,characters:[],events:[target.purpose,target.turn],mood:'Quiet'},issues:[]};
      }
      if(request.role!=='writer'&&!json)throw Error('Unexpected local role');
      return {text:json?JSON.stringify(json):text,...(json?{json}:{}),usage,stopReason:'stop',durationMs:0};
     };
     const result=await core.writeNextChapter(ctx);assert(result.ok,`${scenario.id}: ${JSON.stringify(result.error)}`);
     assert.equal(result.details.commit.text,text);assert.deepEqual(roles,['writer','editor','keeper']);
     persist(entries,'write_next_chapter',result);commits++;
    }
   } else if(step.step==='command')command(entries,step.text);
   else if(step.step==='authorMessage')entries.push({kind:'authorMessage',entryId:`fixture-${entries.length}`,text:step.text});
   else if(step.step==='toolCall') {
    if(['patch_outline','update_bible'].includes(step.tool)) {
     const fn=step.tool==='patch_outline'?core.patchOutline:core.updateBible;
     const bad=await fn(env(entries),step.args);assert.equal(bad.ok,false);assert.equal(bad.error.code,step.result.error.code);
     persist(entries,step.tool,step.result);
    } else {
     assert.equal(step.tool,'write_next_chapter');
     persist(entries,step.tool,{ok:false,details:{schema:'story/macro-result@1',ok:false,revision:true,interjectionSeq:{atStart:0},steps:[],drafts:[],checks:[],reviews:[],responses:[],calls:[],error:step.result.error}});
    }
   } else throw Error(`Unsupported setup: ${step.step}`);
  }
  const model=core.foldBranch(entries);assert.equal(model.lastChapter,commits);
  if(row.id.includes('-h01'))assert.deepEqual(model.policy.budget,{perChapterCalls:3});
  if(scenario.category.startsWith('L_'))assert.equal(model.failures[model.lastChapter+1],2);
  if(scenario.category.startsWith('I_'))assert.equal((await core.writeNextChapter(env(entries))).error.code,'GOAL_REACHED');
  if(scenario.referenceAction) {
   const copy=structuredClone(entries),action=scenario.referenceAction;
   if(scenario.trigger.type==='authorMessage')copy.push({kind:'authorMessage',entryId:'fixture-trigger',text:scenario.trigger.text});
   const fn=action.tool==='update_bible'?core.updateBible:core.patchOutline;
   const result=await fn(env(copy),action.args);assert(result.ok,JSON.stringify(result.error));
  }
  results.push({id:row.id,split,category:scenario.category,setupCommits:commits,fauxSetupCalls:calls,status:'preparation_validated_not_product_measurement'});
 }
}
assert.equal(results.length,47);assert.equal(new Set(results.map(r=>r.id)).size,47);assert.equal(changed.length,2);
for(const [category,count] of Object.entries(categories))assert.equal(results.filter(r=>r.split==='acceptance'&&r.category.startsWith(category+'_')).length,count);
assert.equal(results.filter(r=>r.split==='acceptance'&&['G','H','I','J','L'].includes(r.category[0])).length,12);
const report={schema:'story/ds11-v2-validation@1',date:'2026-11-01',status:'passed',cases:47,dev:15,acceptance:32,changedCases:changed,unchangedCaseFiles:45,goldAndStoryContentUnchanged:true,acceptanceCategories:categories,T03ErrorCasesPerRepetition:12,setupCommits:results.reduce((a,r)=>a+r.setupCommits,0),fauxSetupCalls:results.reduce((a,r)=>a+r.fauxSetupCalls,0),paidModelCalls:0,productMeasurementExecuted:false,results};
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,cases:47,changedCases:2,unchangedCaseFiles:45,setupCommits:report.setupCommits,fauxSetupCalls:report.fauxSetupCalls,paidModelCalls:0}));
