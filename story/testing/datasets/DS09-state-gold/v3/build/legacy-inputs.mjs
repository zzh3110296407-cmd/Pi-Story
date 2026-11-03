import assert from 'node:assert/strict';
import { foldBranch } from '../../../../../packages/core/src/fold/index.ts';
import { keeperInput, editorInput } from '../../../../../packages/core/src/flow/inputs.ts';
import { createDraft } from '../../../../../packages/core/src/production/index.ts';
import { context } from '../../../../../packages/core/test/context.ts';
import { validateEntries } from '../../../../datasets/DS09-state-gold/v2/build/fixture-lib.mjs';
import { sha, withoutHookSemantics } from './io.mjs';

export function patchLegacy({source,ds09,write,kind}){
 const items=[];let occurrences=0,described=0;
 for(const file of source.manifest.files.filter(f=>/^(dev|acceptance)\/entries\/.*\.json$/u.test(f.path))){
  const originalBytes=source.bytes(file.path),original=JSON.parse(originalBytes),entries=structuredClone(original);
  const split=file.path.split('/')[0],id=file.path.split('/').at(-1).slice(0,-5);
  const info=kind==='keeper'?{storyId:id.split('-c')[0],chapter:Number(id.split('-c')[1])}:JSON.parse(source.bytes(`${split}/defects/${id}.json`));
  const seedById=new Map();let additions=0;
  for(const entry of entries){const commit=entry.details?.commit;if(!commit)continue;assert(commit.chapter<info.chapter,'Development input must not contain the current/future commit.');
   const gold=JSON.parse(ds09.bytes(`${split}/gold/${info.storyId}-c${commit.chapter}.json`));
   const prose=ds09.bytes(`${split}/chapters/${info.storyId}-c${commit.chapter}.md`).toString('utf8');
   for(const hook of commit.delta.hookOps.upsert){const seed=gold.hooks.find(h=>h.id===hook.id&&h.operation==='upsert');assert(seed,`${id}: missing prior seed ${hook.id}`);assert(prose.includes(seed.statement),'Use the seed text already present in that committed chapter.');assert(!hook.expectedPayoff||hook.expectedPayoff===seed.statement);hook.expectedPayoff=seed.statement;seedById.set(hook.id,seed.statement);additions++;}
  }
  assert.deepEqual(withoutHookSemantics(entries),withoutHookSemantics(original),'No non-hook development data may change.');
  const model=validateEntries(entries);let input,textRef,goldRef;
  if(kind==='keeper'){
   textRef=`${split}/chapters/${id}.md`;goldRef=`${split}/gold/${id}.json`;
   const result=createDraft(context(entries),{chapter:info.chapter,text:ds09.bytes(textRef).toString('utf8')});assert(result.ok,JSON.stringify(result.error));input=keeperInput(model,result.details);
  }else{
   const draft=model.drafts.at(-1);assert(draft);textRef=`${split}/variants/${id}.md`;goldRef=`${split}/defects/${id}.json`;assert.equal(draft.text,source.bytes(textRef).toString('utf8'));input=editorInput(model,draft,'full');
  }
  for(const hook of input.state.hooks){occurrences++;assert.equal(hook.expectedPayoff,seedById.get(hook.id));assert(hook.expectedPayoff?.trim());described++;}
  const target='development-inputs/'+file.path;write(target,additions?entries:originalBytes);
  items.push({id,storyId:info.storyId,chapter:info.chapter,originalSplit:split,use:'R4_development_only',input:target,sourceInput:file.path,sourceInputSha256:sha(originalBytes),prose:{dataset:source.directory,version:source.version,path:textRef,sha256:sha(source.bytes(textRef))},gold:{dataset:source.directory,version:source.version,path:goldRef,sha256:sha(source.bytes(goldRef))},hookFieldsAdded:additions,existingHookOccurrences:input.state.hooks.length,actualRole:kind==='keeper'?'keeper':'editor',nonHookDataUnchanged:true});
 }
 assert.equal(items.length,kind==='keeper'?15:45);assert.equal(occurrences,described);assert(occurrences>0);
 const result={schema:'story/development-input-patch@1',sourceVersion:source.pin,scope:'Both original v1 dev and acceptance are development-only under plan23. Prose/gold remain immutable canonical references, not copied or relabelled.',actualRole:kind,fixtures:items.length,existingHookOccurrences:occurrences,describedHookOccurrences:described,passed:true,items};
 write('development-inputs/index.json',result);return result;
}
