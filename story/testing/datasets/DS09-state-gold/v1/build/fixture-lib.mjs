import assert from 'node:assert/strict';
import {foldBranch,stateAt} from '../../../../../packages/core/src/fold/index.ts';
import {schemas,validate} from '../../../../../packages/core/src/schema/index.ts';
import {digest,wordCount} from '../../../../../packages/core/src/shared/text.ts';
export {foldBranch,stateAt,digest,wordCount};
export const tool=(entryId,toolName,details)=>({kind:'toolResult',entryId,toolName,isError:false,details});
export function validateEntries(entries){for(const e of entries){const d=e.details??e.data;if(!d)continue;const name=Object.keys(schemas).find(k=>schemas[k].properties?.schema?.const===d.schema);assert(name,`Unknown fixture schema ${d.schema}`);const result=validate(schemas[name],d);assert(result.ok,JSON.stringify({entry:e.entryId,errors:result.errors}));}return foldBranch(entries);}
export function bibleEntry(t){return tool(t.id+'-bible','submit_bible',{schema:'story/bible@1',rev:1,op:'submit',effectiveFromChapter:1,changes:[...t.bible.map(b=>({kind:b.kind,key:b.key,op:'set',source:'model',...(b.kind==='character'?{card:{identity:b.identity}}:{value:b.statement??b.name})})),...t.relationBaseline.map(r=>({kind:'relationBaseline',key:`rel:${r.from}->${r.to}`,op:'set',source:'model',value:{stance:r.stance}}))]});}
export function basisOf(m,chapter){return {canonHead:m.canonHead,controlRev:m.controlRev,bibleRev:m.bibleRev,intentRev:m.intents[chapter]?.rev??0,stateRev:m.stateRev};}
export {commitGold} from './semantic-fixtures.mjs';
