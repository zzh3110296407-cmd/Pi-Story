import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export const sha=value=>createHash('sha256').update(value).digest('hex');
export function io(root){
 const read=relative=>JSON.parse(readFileSync(path.join(root,relative),'utf8'));
 const write=(relative,value)=>{const target=path.join(root,relative);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,Buffer.isBuffer(value)||typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');};
 const pins=existsSync(path.join(root,'labels/source-pins.json'))?read('labels/source-pins.json'):{};
 const source=(directory,version)=>{
  const folder=path.resolve(root,'../../../datasets',directory,version),bytes=readFileSync(path.join(folder,'manifest.json')),manifest=JSON.parse(bytes),key=directory+'/'+version;
  assert(manifest.frozenAt,key+' must be frozen');
  if(pins[key])assert.equal(pins[key].manifestSha256,sha(bytes));
  else{
   const cwd=path.resolve(root,'../../../../..'),rel=`story/testing/datasets/${key}/manifest.json`;
   const log=spawnSync('git',['log','-1','--format=%H','--',rel],{cwd,encoding:'utf8',windowsHide:true});assert.equal(log.status,0);const commit=log.stdout.trim();assert(/^[0-9a-f]{40}$/u.test(commit));
   const original=spawnSync('git',['show',commit+':'+rel],{cwd,windowsHide:true});assert.equal(original.status,0);assert.equal(sha(original.stdout),sha(bytes));
   pins[key]={directory,version,commit,manifestSha256:sha(bytes)};
  }
  return {directory,version,manifest,pin:pins[key],bytes:relative=>{const registration=manifest.files.find(f=>f.path===relative);assert(registration,key+': '+relative);const value=readFileSync(path.join(folder,relative));assert.equal(sha(value),registration.sha256);return value;}};
 };
 const finish=(metadata)=>{
  write('labels/source-pins.json',pins);
  const files=[];function walk(folder){for(const entry of readdirSync(folder,{withFileTypes:true})){const target=path.join(folder,entry.name);if(entry.isDirectory())walk(target);else{const relative=path.relative(root,target).split(path.sep).join('/');if(relative==='manifest.json')continue;const bytes=readFileSync(target);assert(!bytes.includes(13),relative);assert(!bytes.subarray(0,3).equals(Buffer.from([239,187,191])));files.push({path:relative,sha256:sha(bytes),source:'Frozen source versions pinned in labels/source-pins.json; explicit hook-input repair and verification',license:'AGPL-3.0-only',split:relative.startsWith('acceptance/')?'acceptance':relative.startsWith('development-inputs/')?'development':'metadata'});}}}walk(root);
  write('manifest.json',{schema:'story/dataset-manifest@1',...metadata,files:files.sort((a,b)=>a.path.localeCompare(b.path))});
 };
 return {read,write,source,finish};
}
export function withoutHookSemantics(value){
 if(Array.isArray(value))return value.map(withoutHookSemantics);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!(key==='expectedPayoff'&&/^H-[1-9][0-9]*$/u.test(value.id??''))).map(([key,child])=>[key,withoutHookSemantics(child)]));
 return value;
}
