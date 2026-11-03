import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,statSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const repository='D:/AI/Story Dome/Story/pi-Story', work='D:/开源/test/pi-Story/p1', results='D:/AI/Story Dome/新版综合方案/测试结果/P1';
const git=(...args)=>{const r=spawnSync('git',args,{cwd:repository,encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error('Git source unavailable');return r.stdout;};
const commit=git('rev-parse','HEAD').trim();
const id=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')+'-'+commit.slice(0,7);
const target=path.join(repository,'story/testing/runs/P1/P1-Z',id);mkdirSync(target,{recursive:true});
const regex=/\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+/-]{8,})|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/gu;
const hits=[],synthetic=[],environmentFiles=[],skippedLinks=[];let files=0,bytes=0;
const baselineFiles=new Map();
function publicFixture(file,text,match){
 const normalized=file.replaceAll('\\','/');
 const index=normalized.lastIndexOf('/packages/');
 if(index<0||!match.startsWith('Bearer ')||(!/^Bearer [a-z]+(?:[-_][a-z]+)+$/.test(match)&&match!==['Bearer','provider'].join(' ')))return false;
 const relative=normalized.slice(index+1);
 if(!/^packages\/(?:ai|coding-agent|evals|mcp)\/(?:test\/|evals\/acme-server\.ts$)/.test(relative))return false;
 if(!baselineFiles.has(relative)) baselineFiles.set(relative,git('show','b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6:'+relative).replace(/\r\n?/g,'\n'));
 return baselineFiles.get(relative)===text.replace(/\r\n?/g,'\n');
}
const visit=file=>{
 const name=path.basename(file);
 if(/^\.env(?:\.|$)/i.test(name)) {environmentFiles.push({path:file,read:false,knownSynthetic:/[\\/]dataset-guard[\\/]/.test(file)});return;}
 if(!/\.(?:[cm]?js|tsx?|jsonl?|md|txt|log|ya?ml|toml|ini|sh|ps1|css|html|svg|pem|key|lock|npmrc)$/i.test(name)&&!name.startsWith('.'))return;
 const data=readFileSync(file);if(data.subarray(0,8192).includes(0))return;
 const text=data.toString('utf8');files++;bytes+=data.length;if(files%1000===0)console.log(JSON.stringify({files,megabytes:Math.round(bytes/1048576),current:file}));
 for(const match of text.matchAll(regex)) {
  const row={path:file,line:text.slice(0,match.index).split('\n').length,category:match[0].startsWith('Bearer')?'bearer':match[0].startsWith('-----')?'private_key':'key_like'};
  if(publicFixture(file,text,match[0])) synthetic.push({...row,reason:'static word-only dummy or WWW-Authenticate syntax in a public upstream fixture; entire file equals pinned baseline',candidateDigest:createHash('sha256').update(match[0]).digest('hex')});
  else if(/^sk-x{24}$/.test(match[0])&&/[\\/]dataset-guard[\\/]/.test(file)) synthetic.push({...row,reason:'exact deterministic negative fixture from check-datasets.test.mjs'});
  else hits.push(row);
 }
};
const walk=folder=>{for(const e of readdirSync(folder,{withFileTypes:true})){
 if(e.name==='.git')continue;
 const file=path.join(folder,e.name);
 if(e.isSymbolicLink()){skippedLinks.push(file);continue;}
 if(e.isDirectory())walk(file);else if(e.isFile())visit(file);
}};
const tracked=git('ls-files','-z').split('\0').filter(Boolean);
for(const file of tracked)if(existsSync(path.join(repository,file)))visit(path.join(repository,file));
walk(path.join(repository,'story/testing/runs'));walk(work);walk(results);
const report={schema:'story/secret-scan@1',runId:id,repositoryCommit:commit,scopes:[repository,work,results],method:'tracked repository text + all run/workspace/report text; never read environment files; binary files and .git internals excluded; links not followed',files,bytes,modelRequests:0,hits,syntheticFixtures:synthetic,environmentFiles,skippedLinks,passed:hits.length===0&&environmentFiles.every(e=>e.knownSynthetic)};
writeFileSync(path.join(target,'scan.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({target,files,hits: hits.length,knownSynthetic:synthetic.length,environmentFiles:environmentFiles.length,passed:report.passed,hitLocations:hits.slice(0,30)}));
if(!report.passed)process.exitCode=1;
