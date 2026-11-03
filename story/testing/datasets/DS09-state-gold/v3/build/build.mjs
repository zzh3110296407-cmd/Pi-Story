import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io, sha, withoutHookSemantics } from './io.mjs';
import { commitGold, validateEntries, stateAt } from './fixture-lib.mjs';
import { checkHooks } from './check-hooks.mjs';
import { patchLegacy } from './legacy-inputs.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),{read,write,source,finish}=io(root);
assert(!existsSync(path.join(root,'manifest.json'))||!read('manifest.json').frozenAt,'Never rebuild a frozen version.');
const previous=source('DS09-state-gold','v2'),v1=source('DS09-state-gold','v1');
const index=JSON.parse(previous.bytes('index.json'));
const inherited=[];
for(const file of previous.manifest.files.filter(f=>/^(truth\/|acceptance\/(chapters|gold|sentences)\/)/u.test(f.path))){write(file.path,previous.bytes(file.path));inherited.push({path:file.path,sha256:file.sha256});}
assert.equal(inherited.length,30);
for(const file of ['index.json','labels/development-reference.json','labels/scoring-policy.json','labels/hook-coverage.json'])write(file,previous.bytes(file));
write('labels/inherited-v2-review.json',previous.bytes('labels/review.json'));
write('labels/inherited-v2-freeze-approval.json',previous.bytes('labels/freeze-approval.json'));
const mappings=[],entryChecks=[];
for(const story of index.stories){
 let entries=JSON.parse(previous.bytes(`acceptance/entries/${story.storyId}-c1.json`));
 for(let chapter=1;chapter<=3;chapter++){
  const id=story.storyId+'-c'+chapter,gold=read(`acceptance/gold/${id}.json`),text=readFileSync(path.join(root,'acceptance/chapters',id+'.md'),'utf8');
  const old=JSON.parse(previous.bytes(`acceptance/entries/${id}.json`));assert.deepEqual(withoutHookSemantics(entries),withoutHookSemantics(old));
  validateEntries(entries);write(`acceptance/entries/${id}.json`,entries);
  for(const hook of gold.hooks.filter(h=>h.operation==='upsert')){assert(text.includes(hook.statement));mappings.push({storyId:story.storyId,hookId:hook.id,plantedChapter:chapter,expectedPayoff:hook.statement,sourceGold:`acceptance/gold/${id}.json`,sourceEvidence:hook.evidence,reviewIdentity:'Codex (AI)',reviewVerdict:'agree',reviewBasis:'Verbatim reuse of the already author-accepted seed; no new interpretation or future payoff answer.',newHumanReview:false});}
  entries=commitGold(entries,gold,text);entryChecks.push({chapterId:id,p1CommitPassed:true,nonHookPriorDataUnchanged:true});
 }
 const terminal=stateAt(validateEntries(entries)),oldTerminal=JSON.parse(previous.bytes(`acceptance/end-state/${story.storyId}.json`));
 assert.deepEqual(withoutHookSemantics(terminal),withoutHookSemantics(oldTerminal));
 for(const hook of terminal.hooks)assert.equal(hook.expectedPayoff,mappings.find(m=>m.storyId===story.storyId&&m.hookId===hook.id).expectedPayoff);
 write(`acceptance/end-state/${story.storyId}.json`,terminal);
}
assert.equal(mappings.length,9);assert.equal(entryChecks.length,9);
const roleCheck=checkHooks(root);
const development=patchLegacy({source:v1,ds09:v1,write,kind:'keeper'});
const devReference=read('labels/development-reference.json');devReference.inputOverride='development-inputs/index.json';devReference.overrideScope='R4 development only, original v1 dev AND acceptance; unchanged canonical prose/gold.';write('labels/development-reference.json',devReference);
write('labels/input-repair-review.json',{schema:'story/input-repair-review@1',date:'2026-10-30',reviewer:'Codex (AI)',humanReviewed:false,newHumanItemReview:false,sourceGoldReview:'labels/inherited-v2-review.json',sourceGoldFreezeApproval:'labels/inherited-v2-freeze-approval.json',newGoldAnnotations:0,inheritedGoldItems:219,allInheritedContentByteIdentical:true,scope:'Review all nine ID/seed transfers and actual input propagation. Existing author-approved gold and semantic judgments are inherited, never represented as a fresh human review.',mappings,entryChecks,actualKeeperInput:roleCheck,developmentInputSummary:{fixtures:development.fixtures,existingHookOccurrences:development.existingHookOccurrences,describedHookOccurrences:development.describedHookOccurrences,passed:development.passed}});
write('labels/unchanged-content.json',{source:previous.pin,files:inherited,assertion:'All 9 prose, 9 gold, 9 sentence and 3 truth files are byte-identical to v2. Removing expectedPayoff from hook objects restores all original prior-entry and terminal-state objects exactly.'});
write('labels/regression.json',{before:{dataset:'DS09 v2',actualRole:'keeper',existingHookOccurrences:18,describedHookOccurrences:0,test:'build/check-hooks.mjs against frozen v2 fails on all 18 existing references'},after:roleCheck,rootCause:'The dataset constructor omitted expectedPayoff in initial hook upserts.',repair:'Initial upsert now passes its already reviewed current seed statement as expectedPayoff. Native P1 persistence and keeper projection retain it; no input wrapper or core/schema change.'});
write('labels/annotation.json',{kind:'AI_verified_input_serialization_repair_with_inherited_author_accepted_gold',date:'2026-10-30',humanReviewed:false,authorGoldReviewInherited:true,inheritedGoldItems:219,newGoldAnnotations:0,acceptanceChapters:9,keyFacts:72,hookOperations:27,traps:27,existingHookDescriptions:'18/18',legacyDevelopmentInputs:15,legacyDevelopmentDescriptions:`${development.describedHookOccurrences}/${development.existingHookOccurrences}`});
write('LABELING.md','# DS09 state gold v3 DRAFT\n\nInput-only repair of frozen v2. All nine chapters, gold files, sentence files and three truth tables are byte-identical to v2; 219 author-accepted gold items, 72 key facts, 27 lifecycle operations and 27 traps retain their existing approval. Original v2 review and freeze approval are copied verbatim under labels/inherited-v2-*. No fresh personal human review is claimed.\n\nThe constructor now passes each initial upsert’s existing seed statement as expectedPayoff. The text is copied verbatim from that same committed chapter, without later clues or answers. Hook IDs remain story-scoped, and advance/mention/resolve still target the original IDs. Native P1 schema/validateDelta/foldBranch and the actual keeperInput carry the field. There is no runtime augmentation, duplicate hook state or product-code change.\n\nRegression: frozen v2 fails 18/18 required existing-hook descriptions. V3 passes all 18 references over the six chapter-two/three inputs; chapter one has no prior hooks. Nine complete P1 gold commits pass. After removing expectedPayoff, all prior-entry and terminal-state objects equal v2, including quantities, temporal bounds, cognition and lifecycle states.\n\nR4 development is separate from new acceptance. development-inputs/ contains 15 repaired prior-entry files covering BOTH v1 dev and original acceptance. Its index references the unchanged frozen v1 prose/gold by path and hash. Only hook upsert expectedPayoff is added; the actual keeper projection is checked for every fixture. Use these input overrides for R4, never the new acceptance stories. Frozen v1/v2 and historical runs remain unchanged.\n\nReview: Codex AI verified all nine verbatim seed mappings and propagation. Gold semantics and author approval are inherited from the frozen source, not re-labelled or claimed as newly human-reviewed. The current task explicitly authorizes publishing and local commits after checks; this is an input serialization repair with zero new gold judgments.\n\nBuild only in an unpublished draft: node build/build.mjs, then node build/check-hooks.mjs if needed. Source commits/manifests are pinned in labels/source-pins.json. Requires the repository’s frozen source versions and existing P1 runtime. No paid model, role-rule text or measurement script is used. Freeze only after the recorded checks pass.\n');
finish({id:'DS09',version:'v3',frozenAt:null,state:'verified_input_repair_pending_freeze',annotationStatus:'AI_input_verification_inherited_author_accepted_gold',sourceDataset:'DS09 v2',sourceManifestSha256:previous.pin.manifestSha256,developmentReference:devReference});
console.log(JSON.stringify({p1Commits:9,unchangedContentFiles:30,newGoldAnnotations:0,acceptanceDescriptions:'18/18',developmentFixtures:15,developmentDescriptions:`${development.describedHookOccurrences}/${development.existingHookOccurrences}`},null,2));
