import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const snapshot=root+'labels/delegated-review.json';
const external='D:/AI/Story Dome/新版综合方案/测试结果/P2/人工复核/DS08-v2-金标复核.json';
if(!existsSync(snapshot)&&existsSync(external)){
 const bytes=readFileSync(external),candidate=JSON.parse(bytes);
 if(candidate.state==='AI_delegated_review_completed_with_changes'){
  assert.equal(createHash('sha256').update(readFileSync(root+'labels/review.json')).digest('hex'),candidate.originalDraft.sha256,'Review must match the original 219-item draft.');
  writeFileSync(snapshot,bytes);
 }
}
export const delegatedReview=existsSync(snapshot)?JSON.parse(readFileSync(snapshot,'utf8')):null;
if(delegatedReview){assert.equal(delegatedReview.items.length,219);assert.equal(delegatedReview.items.filter(i=>i.authorVerdict==='change').length,36);assert.equal(delegatedReview.proposedAdditions.length,13);}
export function applyReviewed(prompt){
 if(!delegatedReview)return;
 const decisions=delegatedReview.items.filter(i=>i.promptId===prompt.id);
 const replacements=new Map(decisions.map(i=>[i.itemId,i]));
 for(const [name,key]of [['constraints','gid'],['authorBible','bid']]){
  const result=[];
  for(const original of prompt[name]){
   const d=replacements.get(original[key]);assert(d,original[key]);assert.deepEqual(d.aiLabel,original,'Archived review must preserve the original AI label.');assert(['agree','change'].includes(d.authorVerdict));
   const value=d.authorVerdict==='change'?d.changedTo:original;
   if(value.operation!=='remove'){assert.equal(value[key],original[key]);result.push(structuredClone(value));}
   for(const addition of delegatedReview.proposedAdditions.filter(a=>a.promptId===prompt.id&&a.afterItemId===original[key])){assert.equal(name,'constraints');assert.equal(addition.authorVerdict,'agree');result.push(structuredClone(addition.aiLabel));}
  }
  prompt[name]=result;
 }
 const length=replacements.get(prompt.id+'-length');assert.deepEqual(length.aiLabel,prompt.length);if(length.authorVerdict==='change')prompt.length=structuredClone(length.changedTo);
 for(const entry of [...prompt.constraints,...prompt.authorBible]){assert(prompt.prompt.includes(entry.quote));if(entry.authorGivenPart)assert(prompt.prompt.includes(entry.authorGivenPart.quote));}
 prompt.annotation={kind:'AI_labelled_then_user_delegated_AI_review',humanReviewed:false,authorReviewed:false,reviewSource:'labels/delegated-review.json',reviewChangesApplied:true};
}
