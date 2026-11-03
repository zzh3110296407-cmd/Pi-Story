import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {publicEvidence,readEvidence,sha256} from '../../../../../scripts/eval/p2/artifacts.ts';
import {UsageLedger} from '../../../../../scripts/eval/p2/ledger.ts';
import {scoreEvidence} from '../../../../../scripts/eval/p2/score.ts';
import {scanSecrets} from '../../../../../scripts/eval/p2/secrets.mjs';
const folder=import.meta.dirname,root=path.resolve(folder,'../..'),repo=path.resolve(folder,'../../../../../..');
const runId=path.basename(folder),work=path.join(repo,'story/testing/exec/runs/P2-CHAP',runId);
const manifestFile=path.join(folder,'run-manifest.json'),manifest=JSON.parse(readFileSync(manifestFile,'utf8'));
assert.equal(runId,'20261030T015951Z-34ea13b-r1');assert.equal(manifest.status,'running');
assert(!existsSync(path.join(folder,'raw/evidence.jsonl.gz')));
const original=readFileSync(path.join(work,'archive/evidence.jsonl'));assert(original.toString('utf8').endsWith('\n'));
const records=original.toString('utf8').trimEnd().split('\n').map(JSON.parse);
const meta=records.find(row=>row.type==='meta');assert(meta.expectedCaseIds.length===5);
const fees=new UsageLedger(path.join(root,'usage-ledger.jsonl'),path.join(root,'request-reservations.jsonl'));
const rows=file=>readFileSync(file,'utf8').trimEnd().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const charged=new Set(rows(fees.ledgerFile).map(row=>row.requestId));
for(const request of rows(fees.reservationsFile))if(request.runId===runId&&!charged.has(request.requestId))fees.complete(request.requestId,null,'process_interrupted');
const compressed=gzipSync(original),rawChecksums={evidenceSha256:sha256(compressed)};
writeFileSync(path.join(folder,'raw/evidence.jsonl.gz'),compressed,{flag:'wx'});
writeFileSync(path.join(folder,'raw/checksums.json'),JSON.stringify(rawChecksums,null,2)+'\n',{flag:'wx'});
readEvidence(folder);
const sessions=[];
for(const caseDir of readdirSync(work,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&entry.name!=='archive')){
 const directory=path.join(work,caseDir.name,'sessions');if(!existsSync(directory))continue;
 for(const name of readdirSync(directory).filter(name=>name.endsWith('.jsonl'))){
  const bytes=readFileSync(path.join(directory,name));publicEvidence(bytes.toString('utf8'));
  const target='recovered-session-'+caseDir.name+'.jsonl.gz',packed=gzipSync(bytes);
  writeFileSync(path.join(folder,'raw',target),packed,{flag:'wx'});sessions.push({rawFile:target,sha256:sha256(packed),originalSha256:sha256(bytes)});
 }
}
const finished=new Set(records.filter(row=>row.type==='story_result').map(row=>row.caseId));
const started=new Set(records.filter(row=>row.type==='author_prompt').map(row=>row.caseId));
const committed=new Set(records.filter(row=>row.type==='tool_result'&&row.message?.details?.schema==='story/macro-result@1'&&row.message.details.ok&&row.message.details.commit).map(row=>row.caseId+':'+row.message.details.commit.chapter));
const recoveredAt=new Date().toISOString();
const incident={schema:'story/p2-process-interruption@1',runId,recoveredAt,reason:'The previously detached batch and all its test processes are absent. Their last evidence predates the desktop runtime restart. The exact termination cause is unavailable.',processAbsenceVerified:true,originalJournalSha256:sha256(original),originalJournalPreservedExactly:true,sessions,committedChaptersObserved:committed.size,completedStories:finished.size,requests:records.filter(row=>row.type==='request').length,responses:records.filter(row=>row.type==='response').length,replacementPolicy:'Exclude this partial attempt from the formal repetition; retain every raw record and fee in all-real accounting. Execute the entire missing repetition on the same frozen source; never combine partial chapter samples.'};
Object.assign(manifest,{status:'interrupted',executionComplete:false,recoveredAt,elapsedMs:null,rawChecksums,costs:fees.snapshot(runId),totalP2Costs:fees.snapshot(),caseFailures:meta.expectedCaseIds.filter(id=>!finished.has(id)).map(caseId=>({caseId,code:started.has(caseId)?'INTERRUPTED_BEFORE_STORY_RESULT':'NOT_EXECUTED_DUE_TO_INTERRUPTION'})),recovery:incident});
for(const [name,data] of [['run-manifest.json',manifest],['interruption.json',incident],['metrics.json',scoreEvidence(readEvidence(folder),[])]]){const text=JSON.stringify(data,null,2)+'\n';publicEvidence(text);writeFileSync(path.join(folder,name),text);}
const scan=scanSecrets([folder],repo);writeFileSync(path.join(folder,'secret-scan.json'),JSON.stringify(scan,null,2)+'\n');assert(scan.passed);
console.log(JSON.stringify({runId,status:manifest.status,committedChaptersObserved:committed.size,completedStories:finished.size,costs:manifest.costs,totalP2Costs:manifest.totalP2Costs,scanPassed:scan.passed}));
