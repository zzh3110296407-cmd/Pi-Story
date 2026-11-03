import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const repository='D:/AI/Story Dome/Story/pi-Story';
const commit=process.argv[2];
if(!/^[a-f0-9]{40}$/.test(commit??'')) throw new Error('Explicit full source commit required');
const id=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z')+'-'+commit.slice(0,7);
const base='D:/开源/test/pi-Story/p1/reproduce-'+id;
const source=path.join(base,'source'),work=path.join(base,'workspace');
const runs=path.join(repository,'story/testing/runs/P1/reproduce',id);
for(const folder of [source,work,runs,path.join(runs,'logs')]) mkdirSync(folder,{recursive:true});
const env={};
for(const key of ['PATH','SystemRoot','ComSpec','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA']) if(process.env[key]!==undefined) env[key]=process.env[key];
for(const name of ['temp','npm-cache','node-compile-cache']) mkdirSync(path.join(work,name),{recursive:true});
Object.assign(env,{TEMP:path.join(work,'temp'),TMP:path.join(work,'temp'),TMPDIR:path.join(work,'temp'),NODE_COMPILE_CACHE:path.join(work,'node-compile-cache'),NPM_CONFIG_CACHE:path.join(work,'npm-cache'),PI_STORY_WORK_DIR:work,PI_STORY_GIT_SOURCE:repository,PI_STORY_ARCHIVE_COMMIT:commit,PI_STORY_RUNS_DIR:runs});
function run(program,args,cwd,label){
 const r=spawnSync(program,args,{cwd,env,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});
 writeFileSync(path.join(runs,'logs',label+'.log'),(r.stdout??'')+'\n'+(r.stderr??''));
 if(r.status!==0) throw new Error(label+' failed; inspect bounded log at '+runs);
 console.log(label+': passed');
}
run('git',['archive',commit,'--format=tar','--output='+path.join(base,'source.tar')],repository,'archive');
run('tar',['-xf','source.tar','-C','source'],base,'extract');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const lock=path.join(source,'story/package-lock.json'),lockBefore=sha(readFileSync(lock));
run(process.execPath,['story/scripts/install-isolated.mjs'],source,'install');
if(lockBefore!==sha(readFileSync(lock))) throw new Error('Installation changed the frozen lockfile');
run(process.execPath,['story/scripts/check-datasets.mjs'],source,'datasets');
run(process.execPath,['scripts/eval/run-suite.mjs','--all'],path.join(source,'story'),'eval');
const catalog=JSON.parse(readFileSync(path.join(source,'story/scripts/eval/suites.json'),'utf8'));
const comparison=[];
for(const suite of Object.keys(catalog)) {
 const find=(root)=>readdirSync(root).sort().reverse().map(n=>path.join(root,n)).find(p=>existsSync(path.join(p,'run-manifest.json'))&&JSON.parse(readFileSync(path.join(p,'run-manifest.json'),'utf8')).repositoryCommit===commit);
 const original=find(path.join(repository,'story/testing/runs/P1',suite));
 const repeated=find(path.join(runs,suite));
 if(!original||!repeated) throw new Error('Missing source or repeated suite '+suite);
 const a=JSON.parse(readFileSync(path.join(original,'metrics.json'),'utf8')),b=JSON.parse(readFileSync(path.join(repeated,'metrics.json'),'utf8'));
 comparison.push({suite,original:path.relative(repository,original),repeated:path.relative(repository,repeated),identical:JSON.stringify(a)===JSON.stringify(b),originalMetrics:a,repeatedMetrics:b});
}
const evidence={schema:'story/reproduction@1',id,repositoryCommit:commit,archiveSha256:sha(readFileSync(path.join(base,'source.tar'))),source,workspace:work,readOnlyGitObjectSource:repository,installMode:'independent pinned npm install --ignore-scripts; lockfile unchanged',modelRequests:0,suites:comparison.length,identical:comparison.every(r=>r.identical),comparison};
writeFileSync(path.join(runs,'comparison.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({id,runs,identical:evidence.identical,differences:comparison.filter(r=>!r.identical).map(r=>r.suite)}));
if(!evidence.identical) process.exitCode=1;
