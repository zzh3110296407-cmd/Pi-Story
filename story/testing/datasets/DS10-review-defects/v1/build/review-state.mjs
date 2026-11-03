import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';import path from 'node:path';
const hash=s=>createHash('sha256').update(s).digest('hex');
export function prepareReviewedState(root){
 const read=p=>JSON.parse(readFileSync(path.join(root,p),'utf8')),snapshot=path.join(root,'labels/delegated-review-r2.json');
 if(!existsSync(snapshot)){
  const incoming=JSON.parse(readFileSync('D:/AI/Story Dome/新版综合方案/测试结果/P2/人工复核/DS10-v1-r2补充复核.json','utf8')),current=read('labels/review.json');
  assert.equal(incoming.items.length,14);for(const r of incoming.items)assert.deepEqual(current.items.find(i=>i.itemId===r.itemId)?.aiLabel,r.aiLabel,'The completed r2 review must refer to the current draft.');
  writeFileSync(snapshot,JSON.stringify(incoming,null,2)+'\n');
 }
 const r2=read('labels/delegated-review-r2.json'),r1=read('labels/delegated-review.json'),design=read('labels/structural-redesign.json');
 assert.equal(r2.reviewMode,'user_delegated_ai_semantic_review');assert.equal(r2.humanReviewed,false);assert.equal(r2.summary.primaryClassificationsConfirmed,14);assert.equal(r2.summary.structuralConfirmed,4);assert.equal(r2.items.filter(r=>r.authorVerdict==='change').length,2);assert(r2.items.every(r=>['agree','change'].includes(r.authorVerdict)));
 const applied=[];for(const r of r2.items.filter(r=>r.authorVerdict==='change')){
  const permitted=design.cases.find(c=>c.variantId===r.variantId);assert(permitted);const file=path.join(root,permitted.file);let prose=readFileSync(file,'utf8');
  for(const p of r.repairProposals){assert.equal(p.target,permitted.file);const at=prose.indexOf(p.find);if(at>=0){assert.equal(prose.indexOf(p.find,at+1),-1);prose=prose.replace(p.find,p.replace);}else{assert(prose.includes(p.replace),'A requested prose repair is neither applicable nor already applied.');}
   applied.push({itemId:r.itemId,target:p.target,find:p.find,replace:p.replace,reason:p.reason,applied:true});
  }
  assert.equal(prose.trimEnd(),r.changedTo.changed,'Prose must exactly match the reviewed replacement proposal.');writeFileSync(file,prose);
 }
 assert.equal(applied.length,3);writeFileSync(path.join(root,'labels/r2-prose-repairs.json'),JSON.stringify({date:'2026-10-29',reviewSource:'labels/delegated-review-r2.json',reviewer:r2.reviewer,humanReviewed:false,repairs:applied,sourceBodies:r2.items.filter(r=>r.authorVerdict==='change').map(r=>({itemId:r.itemId,beforeSha256:hash(r.aiLabel.changed+'\n'),afterSha256:hash(r.changedTo.changed+'\n')}))},null,2)+'\n');
 const candidates=Array.isArray(r2.baselineCandidates)?r2.baselineCandidates:[r2.baselineCandidates];assert.equal(candidates.length,1);assert.equal(candidates[0].authorVerdict,'agree');writeFileSync(path.join(root,'labels/unplanned-candidates.json'),JSON.stringify({items:candidates},null,2)+'\n');
 const approval=path.join(root,'labels/freeze-authorization.json');return {r1,r2,freezeApproval:existsSync(approval)?JSON.parse(readFileSync(approval,'utf8')):null};
}
export function finalizeReviewedDefects(defects,split,state){
 if(split!=='acceptance')return;
 for(const d of defects){const r=state.r2.items.find(i=>i.itemId===d.id);if(r){const expected=r.authorVerdict==='change'?r.changedTo:r.aiLabel;for(const field of ['category','severity','objective','scope','original','changed','sources'])assert.deepEqual(d[field],expected[field],`The effective ${d.id}/${field} must match the reviewed label.`);d.reviewSource='labels/delegated-review-r2.json';d.reviewStatus='r2_review_and_requested_prose_repairs_applied';d.aiReviewVerdict=r.authorVerdict;}
  else{const old=state.r1.items.find(i=>i.itemId===d.id);assert(old);d.aiReviewVerdict=old.authorVerdict;assert.equal(d.reviewStatus,'r1_review_applied');}
 }
}
export function writeFinalReview(root,items,state){
 const out='D:/AI/Story Dome/新版综合方案/测试结果/P2/人工复核';mkdirSync(out,{recursive:true});const repairs=JSON.parse(readFileSync(path.join(root,'labels/r2-prose-repairs.json'),'utf8'));
 const record={instructions:'Final effective DS10 labels after r1, r2 and the three explicitly requested sentence repairs. AI review identity is preserved. This is a request for author acceptance as the freeze basis, not a fabricated personal human review or P2 stage acceptance.',reviewer:state.r2.reviewer,humanReviewed:false,state:state.freezeApproval?'frozen_author_accepted_delegated_reviews':'AI_review_complete_pending_author_freeze',authorFreezeDecision:state.freezeApproval?.authorDecision??null,summary:{variants:45,acceptanceDefects:36,devDefects:24,reviewedR1Retained:22,reviewedR2:14,structuralReviewedByAI:4,requestedSentenceRepairsApplied:3},repairs:repairs.repairs,items};
 writeFileSync(path.join(out,'DS10-v1-修订结果.json'),JSON.stringify(record,null,2)+'\n');
 let md='# DS10 v1 修订结果\n\n'+(state.freezeApproval?'作者已认可AI复核结果并授权冻结。':'AI复核已完成，待作者认可为冻结依据。')+'身份始终为受用户委托AI，不记作真人逐项亲审。\n\n45个变体；36处验收缺陷（六类各6处），24处开发缺陷。四份整章重述均已被AI复核确认为major/structural；配套时间线为blocking/local。原六处可删除引言的r1范围改判保留，不覆盖原判。22项沿用r1，14项采用r2；r2的12同意、2正文修订原判完整保留。\n\n## 已应用的三处句子修订\n\n';
 for(const p of repairs.repairs)md+=`- ${p.target}\n  - 原：${p.find}\n  - 改：${p.replace}\n`;
 md+='\n三处均精确采用r2逐项提案；其余正文没有借此增加额外情节。保留收据关联的不确定性，去掉新增找错位置动作，明确满足呼吸或审计任一条件的物品均可携带。\n\n45份分支输入由P1 createDraft/schema/fold校验；52项来源与42个注入片段行号已核对；15个对照与冻结DS09字节一致。底本防护服表述作为AI已核对的minor/local歧义单列，不计入36处注入，不据此断言衣服转移。\n\n原判：[r1复核](DS10-v1-缺陷复核.md) / [r2复核](DS10-v1-r2补充复核.md)。[当前36项有效标注](DS10-v1-修订结果.json)。未运行P2模型或测量脚本，本记录不宣告P2验收通过。\n';
 writeFileSync(path.join(out,'DS10-v1-修订结果.md'),md);
}
