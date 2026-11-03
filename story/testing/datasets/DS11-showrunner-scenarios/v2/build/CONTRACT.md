# DS11 v2 scenario data contract — 2026-11-01

This is a data contract for the execution session implementing plan27 S9. It is not a product implementation, a measurement result or a new role rule. Core input examples were validated against the current public core commands. The data author did not read or tune against the showrunner's role text.

## Preparation and visible context

1. A scenario is isolated: create a fresh branch/session through the normal constructors. Except DS14 E01, persist storyPrompt as the first actual author message. E01 deliberately has no story prompt and no setup; dispatch its slash command first.
2. open.constraints, open.bible and open.outline are inputs to core submitConstraints, submitBible and submitOutline, in that order. They are NOT Pi tool output records. Invoke the normal adapter mapping if an extension tool accepts another representation. Persist the successful results. Do not directly assign model state. A model-sourced fixture actor may not write author-only control records.
3. commitChapters runs a normal writeNextChapter for each supplied text, in a separate settled turn/batch. Its writer returns that text; its editor returns observations:[]; its keeper returns an otherwise empty delta proposal and the provided keeperHooks for that chapter. For each keeper hook, bind evidenceText to the unique actual numbered sentence in the keeper request; replace evidenceText with sentences:[n]. Never guess or renumber a reference. Preserve the generated commit, summary and IDs. Include the missing-page hook, so read_story(hooks) has meaningful state. This fixture profile is not an evaluation of keeper extraction.
4. A setup command goes through the actual author-command route and writes the core control/goal result. Slash-command usd maps to core budget.costUsd. A slash command must NOT also become an ordinary author-message event: commands do not start a model turn or reset the macro failure streak.
5. authorMessage adds the given author text to the branch. toolCall establishes a preceding scripted actor request and result in conversation history. Error results use {ok:false,error:{code,message,items?,hint?}}. A write_next_chapter failure must persist a valid story/macro-result@1 details envelope, so foldBranch counts the failure. For non-macro errors use the adapter's story/error@1 envelope. An erroneous setup request must have no successful side effects.
6. For a continue trigger send a system continuation, not a new ordinary author message. In particular, DS11 L and DS14 E14 would become invalid tests if a fabricated author message reset the two-failure streak.
7. Only the story prompt, actual setup history, normal dynamic control/progress context, visible tool errors/hints and the trigger are model-visible. Do NOT send the scenario JSON, expect, referenceAction, category labels, review forms, gold checks, fault schedule or this document to the measured model.

## Trigger scheduling and execution metadata

The plan28 base fields are unchanged. The optional execution object provides the minimum driver information for event-driven E2E cases:

- If trigger.at is absent, deliver the trigger immediately after setup. If trigger.at is present, execute execution.start first and wait for the named event. The target format is write_next_chapter:chapter=N:draft_request:attempt=1: intercept the first writer request of the specified chapter after its input has been assembled and its basis captured, before returning generated output. Hold the call while delivering the injection, then release it. Match chapter and attempt; do not sleep for a guessed time.
- authorMessage with a slash command is routed as a command, including during an active call. steer is immediate author interjection. followUp is queued and must not become an immediate control edit or increment the interjection sequence.
- afterTrigger is an ordered sequence of subsequent command/continuation inputs. Dispatch and persist each command before moving to the next. There is no automatic model turn between these commands.
- dialogResponses holds deterministic UI answers. For the ask_author case, withhold the answer until the driver has observed the paused-continuation assertion, then respond through the real UI/RPC dialog protocol. Persist the answer. Do not inject it as a hidden model hint.
- mode:real uses a real showrunner. DS11 internal roles are still faux, as required by plan27 S9. DS14 real cases use real internal roles for the measured writing flow. Every preparation call is faux in both datasets.
- mode:faux uses a scripted showrunner and local role outputs throughout. It cannot consume network/model credit. Use the scenario's failure profile; the script represents ordinary model actions (write, then stop/report), not a bypass of the real guard or continuation logic.
- maxShowrunnerRequests/maxChapterAttempts are protective execution bounds. Exceeding one records a failed/incomplete case; never truncate a run and label it passed. targetChapterMaximum caps the short E2E outline at three chapters.

### Deterministic profiles

- priced_calls: use deterministic local prices/reservations. Each request, including showrunner requests, reserves and reports 0.006 USD. At budget0.01 the second same-sized request must be denied before dispatch. The numbers are simulated, not actual P3 spend. Any stop notification available locally should report the budget condition without another paid request.
- local_revision: the literal role script supplies a draft with sixteen versus two rows of six, an editor major/local observation, and the correcting writer patch. With perChapterCalls=3 the recheck is the blocked fourth call. A clean three-call pipeline cannot substitute for this case.
- two_unusable_drafts: return the provided empty writer output for both format attempts of each of two macro attempts. They must actually return PARSE_FAILURE and update the normal failure counter; do not preassign a stopped state.
- one_transport_interruption: the first writer attempt has a generation-started stream interruption with no final usage. The second returns validRetryText; normal faux editor and keeper responses then finish the chapter. Use the current typed ModelPort transport-failure representation and actual call-journal/guard path. The retry needs a distinct reservation and retryOf. The test's goal is2, so it ends naturally after the recovered chapter.
- usageSnapshot: for DS11 cost questions, seed the visible accounting summary/call journal with the stated synthetic known and unknown-reserved amounts before the question. It is legitimate context, not a hidden expected answer. Preparation requests are not P3 paid calls. Do not calculate the answer from a separate live account or add unrelated execution usage.

Driver guard probes in E02/E09/E14 are separate, labelled driver_probe events after the measured behavior is observed. They must never be attributed to the model or included as T04 invalid model calls. They do not send an ordinary author message, reset failure counters or add successful writes.

## Actions and checks

The first action means the first emitted tool call in order, or a final natural-language reply if there is no tool call. Reasoning text and a brief tool preamble do not outrank the tool action. For a parallel tool batch keep the actual emitted order; never choose a later acceptable call as the first.

acceptable is an OR of admissible first actions. argsMatch constrains only required fields; paths such as chapters[0].n use dot fields and numeric array indices, with exact primitive equality. Other fields still must satisfy the actual domain validation and written program/judge checks. A reason must be nonempty where required. The canonical patch_outline argument is chapters (12 §3.3, core.patchOutline), not the illustrative patches path in plan28's generic example. Bible changes use the core value/card mapping in12; description cannot silently overwrite an existing post-commit field.

forbidden and programChecks remain independent conditions. A first acceptable action does not excuse a forbidden later write. DS11 stops after capturing that first action/tool result; E2E continues until its specified stop/goal. Natural-language programChecks are explicit requirements for the S9 driver, keyed by case ID; they are not a string expression evaluator. Record each check's observed input/result so the test is reproducible. judgeChecks require semantic judgment and evidence, including committed prose for control effects. A program check that cannot be observed is incomplete, not an automatic pass.

referenceAction is one feasible core-valid action for fixture auditing, not the only valid wording or complete acceptable set. Its presence does not authorize exposing it to the measured model or exact-string grading a semantic change.

T02 counts all32 acceptance cases twice. T03's error subset is G/H/I/J/L, twelve cases per repetition. A legitimate stop/reply is an applicable success/failure judgment, not NA. An unobserved channel or genuinely absent dimension is recorded separately from an incorrect action. DS14 S09 requires every applicable check in each of the15 cases; a missing observation or missing case cannot be removed from the denominator.

## Release and limits

Development has15 DS11 cases and5 DS14 variants; acceptance has32 DS11 cases and15 DS14 cases. Distinct original fictional families are used across splits. They are not taken from DS08 v2. The texts are intentionally short preparation fixtures and do not claim literary-quality or long-context coverage.

J1 exposes only dev/index.json, its referenced dev files and this contract. Execution-session developers must not read acceptance, complete review forms or generator source during tuning; generator source contains acceptance definitions. For this v2, unchanged cases inherit v1 author acceptance; the author explicitly authorized the scoped H01 correction and release. AI delta review and the exact authorization are in labels/author-acceptance.json and labels/review.json. No new personal item-by-item human review is claimed. Register every file hash and commit only authorized paths. Never append acceptance files to an already frozen development version.

The bundled validator exercises the real core preparation commands and commits with scripted local ports. It does not run P3 RPC notifications, UI scheduling, automatic continuation, provider requests or new U7 retry logic. Those are future execution-suite observations, not validation claims made by this dataset.

## DS11 v2 H01 correction and driver boundary

Only development and acceptance H01 change: replace the tiny global USD cap with /budget perChapterCalls=3, and specify that the preceding BUDGET_EXHAUSTED concerns the chapter workflow's call allowance. Story text, trigger, mode, execution bounds and every action/judge gold condition are unchanged; the other45 scenario files are byte-identical to v1. DS14 remains v1.

H is an offline next-action fixture under28 §2: its preparation toolCall is a scripted prior failed result, appended with the normal error/macro envelope under item5 above. It is not a newly executed failure, a global exhausted-budget state or an automatic-continuation test. Do not replace that scripted history with a live failing macro, clear a runtime stop flag, impersonate an author budget increase, disable the guard or exempt the main-agent request. A live failure's runtime stopping behavior belongs to the execution suites, including DS14 E10.

After preparation, the scenario policy is exactly {perChapterCalls:3}; no tiny global USD cap remains. The measurement continuation must pass the normal main-agent before_provider_request reservation. Suite-wide and run-wide fee limits remain enforced. If they cannot admit the request, preserve the blocked/incomplete observation and obtain no T02/T03 model decision; do not call it model success, model failure or not_applicable, and do not silently reduce the formal sample requirement.

The local regression uses a positive simulated0.006USD main-agent reservation, reproduces the v1 denial and admits both v2 fixtures without altering any guard outcome or runtime stop flag. Its scripted replies prove dispatch feasibility only. The real showrunner's report/stop decision remains to be measured and judged in P3-SCEN. No additional paid reporting request is authorized after a genuinely exhausted global budget. The deterministic global-budget coverage stays in unchanged DS14 E09.

For development, read only this contract and dev/index.json plus its referenced dev cases. Do not read acceptance, full review metadata or any build/validation source during tuning. The scripts load acceptance for data validation. On product freeze under27 S11, run all32 acceptance cases twice from one pinned DS11 v2 version; keep previous v1 runs as history and do not mix versions into an unlabelled result.
