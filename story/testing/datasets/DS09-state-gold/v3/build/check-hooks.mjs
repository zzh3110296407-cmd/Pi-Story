import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldBranch } from '../../../../../packages/core/src/fold/index.ts';
import { keeperInput } from '../../../../../packages/core/src/flow/inputs.ts';
import { createDraft } from '../../../../../packages/core/src/production/index.ts';
import { context } from '../../../../../packages/core/test/context.ts';

export function checkHooks(root){
 const read=p=>JSON.parse(readFileSync(path.join(root,p),'utf8'));
 const cases=[],missing=[];let existing=0,described=0;
 for(const story of read('index.json').stories){
  const seeds=new Map(read(`acceptance/gold/${story.storyId}-c1.json`).hooks.map(h=>[h.id,h.statement]));
  for(let chapter=1;chapter<=3;chapter++){
   const id=story.storyId+'-c'+chapter,entries=read(`acceptance/entries/${id}.json`),model=foldBranch(entries);
   const result=createDraft(context(entries),{chapter,text:readFileSync(path.join(root,'acceptance/chapters',id+'.md'),'utf8')});assert(result.ok,JSON.stringify(result.error));
   const input=keeperInput(model,result.details),hooks=input.state.hooks;assert.equal(hooks.length,chapter===1?0:3);
   const ids=new Set(hooks.map(h=>h.id));assert.equal(ids.size,hooks.length);
   for(const hook of hooks){existing++;if(hook.expectedPayoff===seeds.get(hook.id)&&hook.expectedPayoff?.trim())described++;else missing.push(id+':'+hook.id);}
   cases.push({chapterId:id,existingHooks:hooks.length,describedHooks:hooks.filter(h=>h.expectedPayoff===seeds.get(h.id)&&h.expectedPayoff?.trim()).length,hookIds:hooks.map(h=>h.id)});
  }
 }
 assert.equal(existing,18);assert.equal(missing.length,0,`Existing hook semantics missing or mismatched: ${missing.join(', ')}`);assert.equal(described,18);
 return {passed:true,actualRole:'keeper',chapters:9,existingHookOccurrences:existing,describedHookOccurrences:described,sourcePolicy:'Every expectedPayoff equals that same story/id’s already-reviewed chapter-one seed, not a later answer.',cases};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))console.log(JSON.stringify(checkHooks(process.argv[2]?path.resolve(process.argv[2]):fileURLToPath(new URL('../',import.meta.url))),null,2));
