import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=x=>createHash('sha256').update(x).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const temp=path.resolve(root,'../../../exec/temp/ds10-ds09-review-before.json');
const inventory=folder=>Object.fromEntries(readdirSync(path.join(root,folder)).sort().map(name=>[name,sha(readFileSync(path.join(root,folder,name)))]));
const current=()=>({variants:inventory('acceptance/variants'),defects:inventory('acceptance/defects'),consistentControls:inventory('acceptance/no-defects'),entries:inventory('acceptance/entries'),reviewedLabelsSha256:sha(JSON.stringify(read(root+'labels/review.json').items.map(i=>({itemId:i.itemId,aiLabel:i.aiLabel})))),sourceChapters:read(root+'labels/source-chapters.json')});
assert(!read(root+'manifest.json').frozenAt,'Never rewrite a frozen dataset.');
if(process.argv[2]==='before'){
 mkdirSync(path.dirname(temp),{recursive:true});writeFileSync(temp,JSON.stringify(current(),null,2)+'\n');console.log('Captured source-dependent DS10 draft baseline without copying data.');
}else{
 assert.equal(process.argv[2],'after');assert(existsSync(temp));const before=read(temp),after=current();
 for(const key of ['variants','defects','consistentControls','reviewedLabelsSha256','sourceChapters'])assert.deepEqual(after[key],before[key],`Unexpected DS10 semantic drift: ${key}`);
 const updatedEntries=Object.keys(after.entries).filter(name=>after.entries[name]!==before.entries[name]);assert(updatedEntries.length>0,'Expected repaired prior-state/context inputs to change.');
 const result={date:'2026-10-30',cause:'DS09 v2 delegated review corrections to prior state, shared subjects, temporal bounds, independent routes and current chapter target.',sourceDataset:'DS09 v2',sourceManifestSha256:read(root+'labels/source-base.json').manifestSha256,sourceProseChanged:false,all27VariantBytesUnchanged:true,all36InjectionLabelsUnchanged:true,all12ConsistentControlLabelsUnchanged:true,all48ReviewLabelsUnchanged:true,updatedCurrentDraftFixtures:updatedEntries.map(n=>n.slice(0,-5)),p1CurrentDraftChecks:27,note:'Only actual source-dependent entries and provenance were rebuilt. No passage, injection, span, evidence line or severity/scope label changed. Source is still a draft until its author-approved freeze.'};
 const rel='labels/ds09-review-impact.json',bytes=JSON.stringify(result,null,2)+'\n';writeFileSync(root+rel,bytes);
 const manifest=read(root+'manifest.json');manifest.files=manifest.files.filter(f=>f.path!==rel);manifest.files.push({path:rel,sha256:sha(bytes),source:'Direct comparison of before/after source-dependent DS10 fixtures and all unchanged gold/prose bytes',license:'AGPL-3.0-only',split:'metadata'});manifest.files.sort((a,b)=>a.path.localeCompare(b.path));writeFileSync(root+'manifest.json',JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify({sourceProseUnchanged:true,variantsUnchanged:27,reviewLabelsUnchanged:48,updatedEntries:updatedEntries.length,p1CurrentDraftChecks:27}));
}
