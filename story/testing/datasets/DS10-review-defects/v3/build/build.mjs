import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io, sha, withoutHookSemantics } from '../../../../datasets/DS09-state-gold/v3/build/io.mjs';
import { patchLegacy } from '../../../../datasets/DS09-state-gold/v3/build/legacy-inputs.mjs';
import { validateEntries, tool } from '../../../../datasets/DS09-state-gold/v2/build/fixture-lib.mjs';
import { createDraft } from '../../../../../packages/core/src/production/index.ts';
import { context } from '../../../../../packages/core/test/context.ts';
import { editorInput } from '../../../../../packages/core/src/flow/inputs.ts';

const root=fileURLToPath(new URL('../',import.meta.url)),{read,write,source,finish}=io(root);
assert(!existsSync(root+'manifest.json')||!read('manifest.json').frozenAt,'Never rebuild a frozen version.');
const previous=source('DS10-review-defects','v2'),base=source('DS09-state-gold','v3'),oldBase=source('DS09-state-gold','v2'),v1=source('DS10-review-defects','v1'),old09=source('DS09-state-gold','v1');
const index=JSON.parse(previous.bytes('index.json'));
const preserved=[];
for(const file of previous.manifest.files.filter(f=>f.path.startsWith('acceptance/')&&!f.path.startsWith('acceptance/entries/'))){
 const bytes=previous.bytes(file.path);
 if(/^acceptance\/(defects|no-defects)\//u.test(file.path)){
  const item=JSON.parse(bytes),chapterId=item.source.path.split('/').at(-1),sourceBytes=base.bytes('acceptance/chapters/'+chapterId);
  assert.equal(sha(sourceBytes),item.source.sha256);assert.equal(item.source.version,'v2');item.source.version='v3';write(file.path,item);
 }else{write(file.path,bytes);preserved.push({path:file.path,sha256:file.sha256});}
}
for(const file of ['labels/development-reference.json','unplanned.json'])write(file,previous.bytes(file));
write('labels/inherited-v2-review.json',previous.bytes('labels/review.json'));
write('labels/inherited-v2-freeze-approval.json',previous.bytes('labels/freeze-approval.json'));
const cases=[];let existing=0,described=0,changed=0;
for(const item of index.variants){
 const chapterId=item.storyId+'-c'+item.chapter,priorFile='acceptance/entries/'+chapterId+'.json';
 const oldPrior=JSON.parse(oldBase.bytes(priorFile)),newPrior=JSON.parse(base.bytes(priorFile));
 const oldBytes=previous.bytes('acceptance/entries/'+item.id+'.json'),oldEntries=JSON.parse(oldBytes);
 assert.deepEqual(oldEntries.slice(0,oldPrior.length),oldPrior,'Source prefix must match frozen DS09 v2.');
 const oldLast=oldEntries.at(-1);assert.equal(oldLast.details.schema,'story/draft@1');
 const common=[...newPrior,...oldEntries.slice(oldPrior.length,-1)],text=previous.bytes('acceptance/variants/'+item.id+'.md').toString('utf8');
 const result=createDraft(context(common),{chapter:item.chapter,text});assert(result.ok,JSON.stringify(result.error));assert.deepEqual(result.details,oldLast.details,'Draft text, basis, ID, count and digest must remain unchanged.');
 const entries=[...common,{...oldLast,details:result.details}];assert.deepEqual(withoutHookSemantics(entries),withoutHookSemantics(oldEntries));
 const model=validateEntries(entries),oldModel=validateEntries(oldEntries),input=editorInput(model,result.details,'full'),oldInput=editorInput(oldModel,oldLast.details,'full');
 assert.deepEqual(withoutHookSemantics(input),withoutHookSemantics(oldInput),'Only hook semantics may change in the actual editor input.');
 const seeds=new Map(JSON.parse(base.bytes('acceptance/gold/'+item.storyId+'-c1.json')).hooks.map(h=>[h.id,h.statement]));
 for(const hook of input.state.hooks){existing++;assert.equal(hook.expectedPayoff,seeds.get(hook.id));assert(hook.expectedPayoff?.trim());described++;}
 const file='acceptance/entries/'+item.id+'.json';write(file,entries);if(sha(Buffer.from(JSON.stringify(entries,null,2)+'\n'))!==sha(oldBytes))changed++;
 const oldDefects=JSON.parse(previous.bytes('acceptance/defects/'+item.id+'.json')),newDefects=read('acceptance/defects/'+item.id+'.json');assert.deepEqual(newDefects.defects,oldDefects.defects);
 if(item.variant==='control')assert.deepEqual(read('acceptance/no-defects/'+item.id+'.json').labels,JSON.parse(previous.bytes('acceptance/no-defects/'+item.id+'.json')).labels);
 cases.push({variantId:item.id,actualRole:'editor',currentDraftPassed:true,describedHooks:input.state.hooks.length,nonHookInputUnchanged:true,goldAndLinesUnchanged:true});
}
assert.equal(cases.length,27);assert.equal(existing,54);assert.equal(described,54);assert.equal(changed,18);
const development=patchLegacy({source:v1,ds09:old09,write,kind:'editor'});
index.sourceDataset='DS09 v3';index.sourceManifestSha256=base.pin.manifestSha256;index.sourceFrozen=true;write('index.json',index);
const dev=read('labels/development-reference.json');dev.inputOverride='development-inputs/index.json';dev.overrideScope='R4 development only; frozen v1 prose/gold remain referenced unchanged.';write('labels/development-reference.json',dev);
write('labels/source-base.json',{dataset:'DS09-state-gold',version:'v3',commit:base.pin.commit,manifestSha256:base.pin.manifestSha256,sourceFrozen:true,sourceLocation:'canonical_dataset'});
write('labels/source-chapters.json',{schema:'story/source-digest-index@1',chapters:JSON.parse(previous.bytes('labels/source-chapters.json')).chapters.map(c=>({...c,path:c.path.replace('DS09-state-gold/v2/','DS09-state-gold/v3/')}))});
write('labels/input-repair-review.json',{schema:'story/input-repair-review@1',date:'2026-10-30',reviewer:'Codex (AI)',humanReviewed:false,newGoldAnnotations:0,inheritedGoldItems:48,inheritedApproval:'labels/inherited-v2-freeze-approval.json',sourceGoldReview:'labels/inherited-v2-review.json',actualEditorInputs:27,changedInputFiles:changed,existingHookOccurrences:existing,describedHookOccurrences:described,allVariantProseByteIdentical:true,all36InjectionLabelsAndLinesUnchanged:true,all12ConsistentControlLabelsUnchanged:true,sourceReferencesUpdatedTo:base.pin,developmentInputSummary:{fixtures:development.fixtures,existingHookOccurrences:development.existingHookOccurrences,describedHookOccurrences:development.describedHookOccurrences,passed:development.passed},cases,passed:true});
write('labels/unchanged-content.json',{source:previous.pin,byteIdenticalFiles:preserved,assertion:'All variant prose and context are byte-identical to v2. Defect/control semantic labels and spans are unchanged; only source-version metadata and prior hook descriptions change.'});
write('labels/annotation.json',{kind:'AI_verified_input_serialization_repair_with_inherited_author_accepted_gold',date:'2026-10-30',humanReviewed:false,authorGoldReviewInherited:true,inheritedGoldItems:48,newGoldAnnotations:0,variants:27,acceptanceDefects:36,consistentControls:12,confirmedStructural:4,actualEditorInputDescriptions:'54/54',legacyDevelopmentInputs:45,legacyDevelopmentDescriptions:`${development.describedHookOccurrences}/${development.existingHookOccurrences}`});
write('LABELING.md','# DS10 review defects v3 DRAFT\n\nInput/source-reference repair of frozen v2, now based on committed DS09 v3. All 27 variant prose files and existing context files are byte-identical to v2; all 36 injected defect labels, line spans, classifications and 12 consistent-control labels retain their author-accepted review. This inherits all 48 existing gold decisions, not a fresh human review. Definitions and completed semantic/scope review are in the pinned DS10 v2 LABELING.md and labels/inherited-v2-review.json.\n\nThe actual prior-entry prefix is replaced with the corresponding DS09 v3 prefix. All 27 current drafts are recreated through P1 createDraft and checked to retain identical ID, basis, digest, count and text. Actual editorInput is checked for each variant: 54/54 existing-hook references have the verbatim already-reviewed seed. Removing hook expectedPayoff restores every original entry and editor input exactly. 18 later-chapter inputs change; the nine chapter-one inputs remain byte-identical. All defect/control source headers and the manifest/index now point to DS09 v3.\n\nSeparate R4 development overrides in development-inputs/ cover all 45 DS10 v1 variants across original dev AND acceptance. Their canonical v1 prose and gold are unchanged referenced files. Only prior hook upserts acquire the matching earlier gold seed; actual editor inputs are checked. These overrides are development-only and do not read the new acceptance source.\n\nNo product/schema/role-rule/measurement code, original frozen data or historical run is changed. No paid model call occurs. New serialization checks are Codex AI verification; existing author approval of unchanged gold remains the review basis. The current user explicitly requests repair, publication and local commits after checks. Source commits/manifests are pinned in labels/source-pins.json.\n\nBuild only in an unpublished draft with frozen DS09 v3 present: node build/build.mjs. Validation and review details are recorded in labels/input-repair-review.json. Freeze only after its checks pass.\n');
finish({id:'DS10',version:'v3',frozenAt:null,state:'verified_input_repair_pending_freeze',annotationStatus:'AI_input_verification_inherited_author_accepted_gold',sourceDataset:'DS09 v3',sourceManifestSha256:base.pin.manifestSha256,developmentReference:dev});
console.log(JSON.stringify({p1CurrentDraftChecks:27,changedInputs:changed,acceptanceDescriptions:'54/54',variantsUnchanged:27,inheritedGoldItems:48,developmentFixtures:45,developmentDescriptions:`${development.describedHookOccurrences}/${development.existingHookOccurrences}`},null,2));
