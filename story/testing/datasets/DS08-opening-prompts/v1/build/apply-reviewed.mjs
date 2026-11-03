import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const reviewPath=fileURLToPath(new URL('../labels/delegated-review.json',import.meta.url));
export const review=existsSync(reviewPath)?JSON.parse(readFileSync(reviewPath,'utf8')):null;
const authorizationPath=fileURLToPath(new URL('../labels/freeze-authorization.json',import.meta.url));
export const freezeApproval=existsSync(authorizationPath)?JSON.parse(readFileSync(authorizationPath,'utf8')):null;
export function applyReviewed(file,split){
 if(split!=='valid'||!review)return file;
 const items=review.items.filter(i=>i.promptId===file.id),extra=review.additionalItems.filter(i=>i.promptId===file.id);
 assert(items.length>0);const map=new Map(items.map(i=>[i.itemId,i]));
 for(const [field,type,idKey]of [['constraints','constraint','gid'],['authorBible','authorBible','bid']]){
  file[field]=file[field].flatMap(old=>{const r=map.get(old[idKey]);assert(r&&r.type===type);assert.deepEqual(r.aiLabel,old);assert(['agree','change'].includes(r.authorVerdict));if(r.authorVerdict==='agree')return [old];assert(r.changedTo);return r.changedTo.action==='remove'?[]:[r.changedTo];});
  file[field].push(...extra.filter(i=>i.type===type).map(i=>i.proposedLabel));
  assert.equal(new Set(file[field].map(x=>x[idKey])).size,file[field].length);
  for(const item of file[field])assert(file.prompt.includes(item.quote),`${file.id}: revised source quote absent`);
 }
 const length=map.get(`${file.id}-length`);assert(length);assert.deepEqual(length.aiLabel,file.length);if(length.authorVerdict==='change')file.length=length.changedTo;
 assert(file.prompt.includes(file.length.quote));
 file.annotation={kind:'AI_labelled_then_user_delegated_AI_review',authorReviewed:!!freezeApproval,reviewMode:'user_delegated_AI_review_accepted_by_author',humanReviewed:false,reviewer:review.reviewer,reviewDate:review.date,reviewSource:'labels/delegated-review.json',authorizationSource:freezeApproval?'labels/freeze-authorization.json':null,state:freezeApproval?'frozen_with_author_authorization':'review_changes_applied_pending_freeze_decision'};
 return file;
}
