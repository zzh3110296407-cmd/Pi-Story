import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Preserve the delegated review when rematerializing the same reviewed draft.
// Gold and prose remain untouched; drift requires a new semantic review.
export function applyDelegatedReview(root) {
 const read=relative=>JSON.parse(readFileSync(path.join(root,relative),'utf8'));
 const write=(relative,value)=>writeFileSync(path.join(root,relative),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
 if(!existsSync(path.join(root,'labels/delegated-review.json')))return false;
 const reviewed=read('labels/delegated-review.json'),form=read('labels/review.json');
 const approval=existsSync(path.join(root,'labels/freeze-approval.json'))?read('labels/freeze-approval.json'):null;
 if(approval){
  assert.equal(approval.reviewMode,'author_accepted_delegated_AI_review');
  assert.equal(approval.humanPersonallyReviewedEveryItem,false);
  assert.equal(approval.reviewSha256,createHash('sha256').update(readFileSync(path.join(root,'labels/delegated-review.json'))).digest('hex'),'Freeze approval must name this exact delegated review.');
 }
 assert.equal(reviewed.reviewIdentity.kind,'AI_delegated_reviewer');
 assert.equal(reviewed.reviewIdentity.humanReviewed,false);
 assert.equal(reviewed.items.length,48);
 assert.equal(form.items.length,48);
 const decisions=new Map(reviewed.items.map(item=>[item.itemId,item]));
 assert.equal(decisions.size,48);
 for(const item of form.items){
  const decision=decisions.get(item.itemId);assert(decision,item.itemId);
  assert.equal(decision.authorVerdict,'agree','A changed label requires materialization before review metadata can be carried forward.');
  assert.deepEqual(item.aiLabel,decision.aiLabel,`Reviewed gold drift: ${item.itemId}`);
  assert(decision.note);
 }
 const freezeReadiness=approval?{technicalAndReviewConditionsMet:true,authorAcceptanceRecorded:true,freezeAuthorized:true,frozenAt:approval.frozenAt,freezeApproval:'labels/freeze-approval.json',freezeRule:'Freeze is completed by the local Git commit containing this version; use Git history for the commit identity.',remainingSteps:[]}:reviewed.freezeReadiness;
 write('labels/review.json',{...form,state:approval?'frozen_author_accepted_delegated_AI_review':'AI_delegated_review_completed_pending_author_freeze',reviewer:reviewed.reviewer,date:reviewed.date,reviewedAt:reviewed.reviewedAt,humanReviewed:false,reviewIdentity:reviewed.reviewIdentity,instructions:reviewed.instructions,reviewSource:'labels/delegated-review.json',reviewSummary:reviewed.reviewSummary,freezeReadiness,...(approval?{authorFreezeApproval:'labels/freeze-approval.json',authorAcceptedDelegatedReview:true,humanPersonallyReviewedEveryItem:false}:{}),items:form.items.map(item=>({...item,authorVerdict:'agree',changedTo:null,note:decisions.get(item.itemId).note,reviewedBy:reviewed.reviewer,humanReviewed:false}))});
 write('labels/annotation.json',{...read('labels/annotation.json'),kind:'AI_designed_and_labelled_then_user_delegated_AI_review',humanReviewed:false,authorReviewed:!!approval,authorAcceptedDelegatedReview:!!approval,humanPersonallyReviewedEveryItem:false,reviewer:reviewed.reviewer,reviewedAt:reviewed.reviewedAt,delegatedReviewCompleted:true,reviewSource:'labels/delegated-review.json',reviewItems:48,agree:48,change:0,confirmedStructural:4,originalGoldAndProseUnchanged:true,authorAcceptancePending:!approval,...(approval?{freezeApproval:'labels/freeze-approval.json'}:{})});
 const voice=read('labels/voice-design.json');
 write('labels/voice-design.json',{...voice,transform:'Named narrator substitutions plus explicit pronoun edits; all four complete bodies have now been semantically compared to the frozen source by delegated AI.',reviewer:reviewed.reviewer,humanReviewed:false,reviewSource:'labels/delegated-review.json',...(approval?{authorAcceptedDelegatedReview:true,freezeApproval:'labels/freeze-approval.json'}:{}),chapters:voice.chapters.map(chapter=>{
  const decision=reviewed.structuralReviews.find(item=>item.itemId.startsWith(chapter.chapterId+'-'));assert(decision,chapter.chapterId);
  return {...chapter,originalReviewStatus:chapter.originalReviewStatus??chapter.reviewStatus,reviewStatus:'AI_delegated_semantic_and_structural_review_confirmed',reviewSource:'labels/delegated-review.json',scope:'structural',severity:'major',plotDeviationInRewrittenBody:false};
 })});
 let labeling=readFileSync(path.join(root,'LABELING.md'),'utf8');
 labeling=labeling.replace('Four first-person whole-body versions are structural candidates (major), pending actual semantic/scope review.','Four first-person whole-body versions are confirmed major/structural defects by the completed delegated AI semantic/scope review.');
 labeling=labeling.replace('All 48 review items and source freeze remain pending; no schema check establishes structural scope or author approval.',approval?'All 48 items have completed delegated AI review (48 agree, zero changes). The DS09 v2 source is frozen and committed. The author explicitly accepted this delegated review and authorized the DS10 v2 freeze and local commit on 2026-10-30; see labels/freeze-approval.json and labels/source-freeze.json. No personal human review is fabricated.':'All 48 items have completed delegated AI review (48 agree, zero changes). The DS09 v2 source is frozen. Final author acceptance of this delegated review and the DS10 v2 freeze/local commit remain pending.');
 labeling+='\nCompleted review: Codex, explicitly delegated by the user on 2026-10-30; humanReviewed=false. All 36 injected defects and 12 particular consistent-control passages were checked against actual context and source text. The four whole-body rewrites preserve events, epistemic qualifications and every direct quotation; only narrator and group references change. Their paired chronology append is a separate local defect outside the structural span. Two removable wilderness narrator asides remain major/local. No gold, variant or source prose was repaired or replaced. Original reviewStatus strings inside aiLabel are construction-time provenance; the effective review state is labels/review.json plus labels/delegated-review.json. The review does not certify every unlabelled passage flawless.\n\n';
 labeling+='| Structural variant | Reviewed body lines | Paragraphs | Result |\n|---|---|---:|---|\n';
 for(const item of reviewed.structuralReviews)labeling+=`| ${item.variantId} | ${item.lines.start}–${item.lines.end} | ${item.paragraphs} | major/structural; no extra plot deviation |\n`;
 if(approval)labeling=labeling.replace('# DS10 review defects v2 DRAFT','# DS10 review defects v2')+'\nThe delegated-review.json freezeReadiness fields are the preserved pre-acceptance review snapshot. Current accepted freeze state is recorded in labels/review.json, labels/annotation.json and labels/freeze-approval.json.\n';
 write('LABELING.md',labeling);
 return true;
}
