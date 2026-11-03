import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),repository=path.resolve(root,'../../../../..');
const source=path.resolve(root,'../../../datasets/DS09-state-gold/v2'),draft=path.resolve(root,'../../DS09-state-gold/v2');
const sha=x=>createHash('sha256').update(x).digest('hex'),read=p=>JSON.parse(readFileSync(p,'utf8'));
const targetManifest=read(root+'manifest.json');assert(!targetManifest.frozenAt,'Do not change a frozen target.');
const bytes=readFileSync(path.join(source,'manifest.json')),manifest=JSON.parse(bytes);assert(manifest.frozenAt);
const rel='story/testing/datasets/DS09-state-gold/v2/manifest.json';
const log=spawnSync('git',['log','-1','--format=%H','--',rel],{cwd:repository,encoding:'utf8',windowsHide:true});assert.equal(log.status,0);const commit=log.stdout.trim();assert(/^[0-9a-f]{40}$/u.test(commit));
const recorded=spawnSync('git',['show',commit+':'+rel],{cwd:repository,windowsHide:true});assert.equal(recorded.status,0);assert.equal(sha(recorded.stdout),sha(bytes),'Canonical source must match its local frozen commit.');
const dependent=manifest.files.filter(f=>/^truth\/.*\.json$/u.test(f.path)||/^acceptance\/(entries|chapters)\//u.test(f.path));assert.equal(dependent.length,21);
for(const file of dependent){const canonical=readFileSync(path.join(source,file.path));assert.equal(sha(canonical),file.sha256);assert.equal(sha(readFileSync(path.join(draft,file.path))),file.sha256,'Source freeze changed a previously validated input.');}
const pin={schema:'story/source-freeze@1',date:'2026-10-30',dataset:'DS09-state-gold',version:'v2',commit,manifestSha256:sha(bytes),sourcePath:'story/testing/datasets/DS09-state-gold/v2',dependentFilesCompared:21,allComparedBytesEqualReviewedDraft:true,sourceProseChanged:false,note:'Canonical committed source replaces the preparation draft. Its 3 truth tables, 9 prior-entry files and 9 chapters match the already validated draft; this is a provenance-only transition, not another model or draft-validation run.'};
const pinPath=root+'labels/source-freeze.json';if(existsSync(pinPath))assert.deepEqual(read(pinPath),pin);else writeFileSync(pinPath,JSON.stringify(pin,null,2)+'\n');
const base=read(root+'labels/source-base.json');base.manifestSha256=sha(bytes);base.sourceFrozen=true;base.sourceLocation='canonical_dataset';writeFileSync(root+'labels/source-base.json',JSON.stringify(base,null,2)+'\n');
const index=read(root+'index.json');index.sourceManifestSha256=sha(bytes);index.sourceFrozen=true;writeFileSync(root+'index.json',JSON.stringify(index,null,2)+'\n');
for(const file of ['build/pin-source.mjs','labels/source-freeze.json','labels/source-base.json','index.json']){let record=targetManifest.files.find(f=>f.path===file);if(!record){record={path:file,source:'Local committed DS09 v2 provenance and direct equality checks for dependent data',license:'AGPL-3.0-only',split:'metadata'};targetManifest.files.push(record);}record.sha256=sha(readFileSync(root+file));}
targetManifest.sourceManifestSha256=sha(bytes);targetManifest.files.sort((a,b)=>a.path.localeCompare(b.path));writeFileSync(root+'manifest.json',JSON.stringify(targetManifest,null,2)+'\n');
console.log(JSON.stringify({sourceCommit:commit,sourceFrozen:true,dependentFilesEqual:21,variantOrGoldChanges:0}));
