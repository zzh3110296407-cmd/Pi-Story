import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeSharedAccount } from './shared-accounts.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),snapshot=root+'labels/delegated-review.json';
export const delegatedReview=existsSync(snapshot)?JSON.parse(readFileSync(snapshot,'utf8')):null;
export function applyReviewedGold(gold,sentences){
 if(!delegatedReview)return;
 const decisions=delegatedReview.items.filter(i=>i.chapterId===gold.id);
 const collection={fact:'facts',claim:'claims',cognition:'cognitions',relation:'relations',hook:'hooks',trap:'mustNotRecord',uncertainty:'uncertainties',historicalReference:'historicalReferences'};
 for(const item of decisions){
  const rows=gold[collection[item.type]];assert(rows,item.type);
  const index=rows.findIndex((row,j)=>`${gold.id}:${item.type}:${row.id??row.key??j+1}`===item.itemId);assert(index>=0,item.itemId);
  if(item.authorVerdict==='agree')assert.deepEqual(rows[index],item.aiLabel,`Unreviewed drift in an agreed label: ${item.itemId}`);
  else{assert.equal(item.authorVerdict,'change');assert(item.changedTo);rows[index]=normalizeSharedAccount(structuredClone(item.changedTo));}
  for(const ref of rows[index].evidence)assert(sentences.some(s=>s.id===ref),`${item.itemId}: evidence does not exist`);
 }
 assert.equal(decisions.length,Object.values(collection).reduce((n,name)=>n+gold[name].length,0),'Review must cover every effective label.');
}
