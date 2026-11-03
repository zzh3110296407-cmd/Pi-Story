import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import * as core from '@pi-story/core';
import {validateScenario} from './scenario-contract.mjs';
const base=path.resolve(process.argv[2]??path.dirname(new URL(import.meta.url).pathname));
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const hash=x=>createHash('sha256').update(x).digest('hex');
const cases=[];const results=[];
function env(entries){
 return {model:core.foldBranch(entries),batch:{committed:false},settings:{localRevision:true,roles:Object.fromEntries(['writer','editor','keeper','verifier'].map(r=>[r,{model:'faux-p3-fixture',maxTokens:4096}]))},ports:{entries:{branch:()=>entries,authorMessage:id=>entries.find(x=>x.entryId===id&&x.kind==='authorMessage')?.text??null},models:{call:async()=>{throw Error('Unscripted model request prohibited');}},prices:{price:()=>null},rules:{get:name=>`Faux fixture placeholder ${name}; no product role rules loaded.`},interjections:{seq:()=>0},budget:{reserve:()=>({ok:true,reservationId:'fixture-reservation',costUsd:0}),settle:()=>{}}}};
}
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
function persisted(entries,tool,result){
 const details=result.details??{schema:'story/error@1',tool,error:result.error};
 entries.push({kind:'toolResult',entryId:`fixture-${entries.length}`,toolName:tool,isError:!result.ok,details});
}
function command(entries,text){
 const [name,...args]=text.split(' '),value=args.join(' '),m=core.foldBranch(entries);let result,type;
 if(name==='/intent'||name==='/focus'){type='story.control';result=core.authorControl(m,{field:name==='/intent'?'author_intent':'current_focus',text:value});}
 else if(name==='/goal'){type='story.goal';result=core.authorGoal(m,{targetChapter:value==='off'?null:Number(value)});}
 else if(name==='/budget'){type='story.goal';result=core.authorGoal(m,{budget:value==='off'?null:Object.fromEntries(args.map(a=>{const [k,v]=a.split('=');return [k==='usd'?'costUsd':k,Number(v)];}))});}
 else if(name==='/ledger'){
  type='story.control';const [op,id,...rest]=args;
  const p=op==='add'?{op:'set',kind:id,text:rest.join(' ')}:op==='set'?{op,id,text:rest.join(' ')}:{op:'remove',id};
  result=core.authorControl(m,{field:'ledger_edit',ledgerPatch:[p]});
 }else throw Error(`Unknown setup command: ${name}`);
 if(result.ok)entries.push({kind:'custom',entryId:`fixture-${entries.length}`,customType:type,data:result.details});
 return result;
}
function macroError(error){return {schema:'story/macro-result@1',ok:false,revision:true,interjectionSeq:{atStart:0},steps:[],drafts:[],checks:[],reviews:[],responses:[],calls:[],error};}
for(const name of readdirSync(base).filter(x=>/^DS(?:11|14)-/u.test(x))){
 const folder=path.join(base,name,name.startsWith('DS11')?'v3':'v2');
 for(const split of ['dev','acceptance']){
  const idx=read(path.join(folder,split,'index.json'));
  for(const ref of idx.cases){
   const bytes=readFileSync(path.join(folder,split,ref.path));assert.equal(hash(bytes),ref.sha256);
   assert(!bytes.includes(13));assert(!bytes.subarray(0,3).equals(Buffer.from([239,187,191])));
   const s=JSON.parse(bytes);cases.push(s);
   validateScenario(s);assert.equal(s.schema,name.startsWith('DS11')?'story/p3-scenario@2':'story/p3-scenario@1');assert.equal(s.split,split);assert.equal(s.id,ref.id);
   assert(['real','faux'].includes(s.mode));assert(s.expect.acceptable.length);
   assert(s.expect.programChecks.length);assert(s.trigger.text.trim());
   const entries=[];let commits=0,calls=0,errorContexts=0;
   if(s.storyPrompt)entries.push({kind:'authorMessage',entryId:'fixture-author',text:s.storyPrompt});
   for(const step of s.setup){
    if(step.step==='open'){
     for(const [tool,fn,input] of [['submit_constraints',core.submitConstraints,step.constraints],['submit_bible',core.submitBible,step.bible],['submit_outline',core.submitOutline,step.outline]]){
      const result=await fn(env(entries),input);assert(result.ok,`${s.id} ${tool}: ${JSON.stringify(result.error)}`);persisted(entries,tool,result);
     }
    }else if(step.step==='commitChapters'){
     assert.equal(step.texts.length,step.count);
     for(const [textIndex,text] of step.texts.entries()){
      const ctx=env(entries);const roles=[];const target=ctx.model.outline.find(x=>x.n===ctx.model.lastChapter+1);
      ctx.ports.models.call=async req=>{
       roles.push(req.role);calls++;
       let json;
       if(req.role==='editor')json={observations:[]};
       if(req.role==='keeper'){
        const input=JSON.parse(req.user);
        const hooks=(step.keeperHooks?.[textIndex]??[]).map(h=>{
         const matched=input.sentences.filter(s=>s.text===h.evidenceText);assert.equal(matched.length,1,'Faux hook evidence must be a unique actual numbered sentence');
         const {evidenceText,...fields}=h;return {...fields,sentences:[matched[0].n]};
        });
        json={facts:[],claims:[],cognitions:[],relations:[],hooks,summary:{title:target.title,characters:[],events:[target.purpose,target.turn],mood:'Quiet'},issues:[]};
       }
       if(req.role!=='writer'&&!json)throw Error('Unexpected faux role');
       return {text:json?JSON.stringify(json):text,...(json?{json}:{}),usage,stopReason:'stop',durationMs:0};
      };
      const result=await core.writeNextChapter(ctx);assert(result.ok,`${s.id} commit: ${JSON.stringify(result.error)}`);
      assert(result.details.commit);assert.equal(result.details.commit.text,text);assert.deepEqual(roles,['writer','editor','keeper']);
      persisted(entries,'write_next_chapter',result);commits++;
     }
    }else if(step.step==='command')assert(command(entries,step.text).ok,`${s.id} invalid setup command`);
    else if(step.step==='authorMessage')entries.push({kind:'authorMessage',entryId:`fixture-${entries.length}`,text:step.text});
    else if(step.step==='toolCall'){
     const r=step.result;
     if(step.tool==='patch_outline'||step.tool==='update_bible'){
      const fn=step.tool==='patch_outline'?core.patchOutline:core.updateBible;
      const bad=await fn(env(entries),step.args);assert.equal(bad.ok,false);assert.equal(bad.error.code,r.error.code);errorContexts++;
     }
     if(step.tool==='write_next_chapter')persisted(entries,step.tool,{ok:false,error:r.error,details:macroError(r.error)});
     else persisted(entries,step.tool,r);
    }else throw Error(`Unsupported setup step ${step.step}`);
   }
   const m=core.foldBranch(entries);assert.equal(m.lastChapter,commits);
   if(s.category.startsWith('L_'))assert.equal(m.failures[m.lastChapter+1],2,'Failure streak must survive until the continue trigger');
   if(s.category.startsWith('I_')){const r=await core.writeNextChapter(env(entries));assert.equal(r.error.code,'GOAL_REACHED');}
   if(s.referenceAction){
    const a=s.referenceAction,fn=a.tool==='update_bible'?core.updateBible:core.patchOutline;
    const measurementEntries=structuredClone(entries);
    if(s.trigger.type==='authorMessage')measurementEntries.push({kind:'authorMessage',entryId:'fixture-trigger',text:s.trigger.text});
    const result=await fn(env(measurementEntries),a.args);assert(result.ok,`${s.id} reference action: ${JSON.stringify(result.error)}`);
    assert.equal(result.details.effectiveFromChapter??m.lastChapter+1,m.lastChapter+1);
   }
   if(s.category.startsWith('B_')) {
    const ed=structuredClone(entries);
    ed.push({kind:'authorMessage',entryId:'fixture-trigger',text:s.trigger.text});
    const existing=s.referenceAction.args.changes[0];
    const forms=[structuredClone(s.referenceAction.args)];
    if(existing.kind==='rule') {
     const open=s.setup.find(step=>step.step==='open');
     const place=open.bible.items.find(item=>item.kind==='place');
     forms.push({reason:'Author future-only setting, additive existing-place representation.',changes:[{
      kind:'place',key:place.key,op:'set',source:'user',authorQuote:existing.authorQuote,
      value:{handling:existing.value.description}}]});
    } else forms.push({reason:'Author future-only setting, new-rule representation.',changes:[{
      kind:'rule',key:'rule:future_addition',op:'set',source:'user',authorQuote:existing.authorQuote,
      value:{description:s.trigger.text.split(' Add this as')[0]}}]});
    for(const action of forms) {
     const result=await core.updateBible(env(structuredClone(ed)),action);
     assert(result.ok,`${s.id} admissible representation: ${JSON.stringify(result.error)}`);
     assert.equal(result.details.effectiveFromChapter,3);
    }
   }
   if(s.category==='E01')assert.equal(command(entries,s.trigger.text).ok,false);
   if(s.category==='E08'){
    const ed=structuredClone(entries);assert(command(ed,s.trigger.text).ok);
    for(const a of s.execution.afterTrigger.filter(a=>a.text.startsWith('/ledger')))assert(command(ed,a.text).ok);
    const now=core.foldBranch(ed);assert(now.ledger.some(x=>x.id==='L-4'));assert(!now.ledger.some(x=>x.id==='L-3'));assert(now.ledger.find(x=>x.id==='L-1').text.includes('optional'));
   }
   if(s.id.startsWith('ds14')&&s.mode==='real')assert(m.outline.every(c=>c.targetWords>=600&&c.targetWords<=900)&&m.outline.length<=3);
   results.push({id:s.id,split,setupCommits:commits,fauxSetupCalls:calls,lastChapter:m.lastChapter,repairableErrorContextsValidated:errorContexts,setupDigest:hash(JSON.stringify(entries)),status:'setup_and_static_oracle_validated_not_measurement_passed'});
  }
 }
}
assert.equal(cases.length,72);assert.equal(new Set(cases.map(s=>s.id)).size,72);
for(const [dataset,expected] of [['ds11',{dev:18,acceptance:32}],['ds14',{dev:7,acceptance:15}]])for(const split of ['dev','acceptance'])assert.equal(cases.filter(s=>s.id.startsWith(dataset)&&s.split===split).length,expected[split]);
const counts={A:3,B:3,C:2,D:3,E:3,F:3,G:4,H:2,I:2,J:2,K:2,L:2,M:1};
for(const [c,n]of Object.entries(counts))assert.equal(cases.filter(s=>s.id.startsWith('ds11')&&s.split==='acceptance'&&s.category.startsWith(c+'_')).length,n);
assert.equal(cases.filter(s=>s.id.startsWith('ds11')&&s.split==='acceptance'&&['G','H','I','J','L'].includes(s.category[0])).length,12);
for(const c of Object.keys(counts))assert(cases.some(s=>s.id.startsWith('ds11')&&s.split==='dev'&&s.category.startsWith(c+'_')));
const prompts=split=>new Set(cases.filter(s=>s.split===split&&s.storyPrompt).map(s=>s.storyPrompt));
assert([...prompts('dev')].every(p=>!prompts('acceptance').has(p)));
const report={schema:'story/p3-dataset-static-validation@1',date:'2026-11-02',identity:'Codex AI data construction; local deterministic validation',admissibleBibleRepresentationsValidated:10,executionSessionRunnerReplay:'pending_execution_session_plan30_S5',cases:72,development:25,acceptance:47,DS11AcceptanceCategories:counts,T03AcceptanceErrorCases:12,paidModelCalls:0,setupFauxCalls:results.reduce((a,r)=>a+r.fauxSetupCalls,0),setupCommits:results.reduce((a,r)=>a+r.setupCommits,0),measurementExecuted:false,limitations:['P3 adapters, UI scheduling, automatic continuation, transport retry and paid-model behavior are not exercised by this setup validator.','Faux keeper outputs store no state facts but do store the explicitly scripted missing-page hook; committed prose and Bible remain the source for other story questions.','Program checks are explicit executable-driver requirements, not self-certified product passes.'],results};
if(process.argv[3])writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({cases:report.cases,development:25,acceptance:47,setupCommits:report.setupCommits,fauxSetupCalls:report.setupFauxCalls,paidModelCalls:0,measurementExecuted:false}));
