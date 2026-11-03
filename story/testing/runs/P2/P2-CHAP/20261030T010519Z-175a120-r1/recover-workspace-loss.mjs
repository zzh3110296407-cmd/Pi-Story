import {existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {publicEvidence,readEvidence,sha256} from '../../../../../scripts/eval/p2/artifacts.ts';
import {UsageLedger} from '../../../../../scripts/eval/p2/ledger.ts';
import {scanSecrets} from '../../../../../scripts/eval/p2/secrets.mjs';
const folder=import.meta.dirname;
const root=path.resolve(folder,'../..');
const repo=path.resolve(folder,'../../../../../..');
const runId=path.basename(folder);
const manifestFile=path.join(folder,'run-manifest.json');
const manifest=JSON.parse(readFileSync(manifestFile,'utf8'));
if(runId!=='20261030T010519Z-175a120-r1'||manifest.status!=='running')throw new Error('Recovery applies once to the interrupted unfinished run');
if(existsSync(path.join(folder,'raw/evidence.jsonl.gz')))throw new Error('Do not overwrite original or finalized evidence');
const journal='D:/开源/test/pi-Story/p2/exec/runs/P2-CHAP/'+runId+'/archive/evidence.jsonl';
if(existsSync(journal))throw new Error('Journal exists; do not substitute a recovery container');
const previous=path.join(root,'P2-CHAP/20261029T164903Z-175a120-r1');
const previousManifest=JSON.parse(readFileSync(path.join(previous,'run-manifest.json'),'utf8'));
if(previousManifest.repositoryCommit!==manifest.repositoryCommit||JSON.stringify(previousManifest.datasets)!==JSON.stringify(manifest.datasets))throw new Error('Prior run cannot supply matching frozen case IDs');
const previousMeta=readEvidence(previous).find(row=>row.type==='meta');
if(!previousMeta?.expectedCaseIds?.length)throw new Error('Frozen case metadata unavailable');
const rows=file=>readFileSync(file,'utf8').split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const fees=new UsageLedger(path.join(root,'usage-ledger.jsonl'),path.join(root,'request-reservations.jsonl'));
const charged=new Set(rows(fees.ledgerFile).map(row=>row.requestId));
for(const reservation of rows(fees.reservationsFile))if(reservation.runId===runId&&!charged.has(reservation.requestId))fees.complete(reservation.requestId,null,'workspace_evidence_lost');
const references=[];
for(const area of ['request_body','http_response']){
 const directory=path.join(folder,'raw',area);
 if(!existsSync(directory))continue;
 for(const name of readdirSync(directory).filter(name=>name.endsWith('.jsonl.gz')).sort()){
  const bytes=readFileSync(path.join(directory,name));
  references.push({type:'recovered_raw_reference',runId,rawFile:area+'/'+name,sha256:sha256(bytes),note:'Existing bytes retained. Original journal reference and its prior digest are lost; this hash was taken during recovery.'});
 }
}
const recoveredAt=new Date().toISOString();
const incident={schema:'story/p2-evidence-loss@1',runId,recoveredAt,reason:'Execution workspace disappeared while the model process was active; the driver ended with ENOENT in EvidenceArchive.finish reading its journal.',lost:['fixed Pi build','dependency runtime','in-progress measurement journal','case session files','temporary helpers'],retained:{rawFiles:references.length,manifest:true,canonicalReservations:true,canonicalCharges:true},lastChatProgress:{committedChapters:2,requestedChapters:20,failedMacroAttempts:1,lastMacroError:'TRANSPORT_FAILURE',logicalRequests:24,completedResponses:23,internalCalls:14,source:'Last successful progress command in the execution chat; this is not a reconstructed product result.'},originalJournalIntegrity:'unavailable',recoveryPolicy:'Preserve raw bytes and fees. Do not reconstruct responses, CallRecords, chapter results, or success metrics. Exclude this attempt from complete formal repetitions; include it in all-real accounting.'};
const records=[{type:'meta',runId,suiteId:manifest.suiteId,split:manifest.split,phase:manifest.phase,repetition:manifest.repetition,expectedCaseIds:previousMeta.expectedCaseIds,recovery:{originalJournalLost:true,caseIdsSource:previousManifest.runId,onlyReferenceContainer:true}},{type:'configuration',runId,repositoryCommit:manifest.repositoryCommit,dirty:manifest.dirty,rules:manifest.rules,templates:manifest.templates},...references,{type:'run_failure',runId,diagnostic:incident.reason,evidenceLoss:true}];
const text=records.map(row=>JSON.stringify(row)).join('\n')+'\n';publicEvidence(text);
const bytes=gzipSync(text),rawChecksums={evidenceSha256:sha256(bytes)};
writeFileSync(path.join(folder,'raw/evidence.jsonl.gz'),bytes,{flag:'wx'});
writeFileSync(path.join(folder,'raw/checksums.json'),JSON.stringify(rawChecksums,null,2)+'\n',{flag:'wx'});
writeFileSync(path.join(folder,'evidence-loss.json'),JSON.stringify(incident,null,2)+'\n',{flag:'wx'});
Object.assign(manifest,{status:'failed_evidence_loss',recoveredAt,elapsedMs:null,executionComplete:false,costs:fees.snapshot(runId),totalP2Costs:fees.snapshot(),rawChecksums,evidenceLoss:true,caseFailures:previousMeta.expectedCaseIds.map(caseId=>({caseId,code:'ORIGINAL_MEASUREMENT_JOURNAL_LOST'}))});
writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
readEvidence(folder);
const scan=scanSecrets([folder],repo);
writeFileSync(path.join(folder,'secret-scan.json'),JSON.stringify(scan,null,2)+'\n');
console.log(JSON.stringify({runId,status:manifest.status,preservedRawReferences:references.length,costs:manifest.costs,totalP2Costs:manifest.totalP2Costs,scanPassed:scan.passed}));
if(!scan.passed)process.exitCode=1;
