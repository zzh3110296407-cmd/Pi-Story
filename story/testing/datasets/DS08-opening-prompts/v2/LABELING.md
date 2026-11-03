# DS08 opening prompts v2

P2R new acceptance only: 12 unseen English valid prompts, three per task. Seed P2R-DS08-v2-20261030; independent string-seeded Python shuffles, first eligible rows, excluding every v1 development AND acceptance id and exact prompt. The local valid parquet alone was read; no train or test data was opened for this selection. Original id/language/task_type/prompt values and row indices are retained exactly.

Development is all of frozen v1 (both dev/ and acceptance/), referenced by manifest and per-file digest in labels/development-reference.json; no v1 data is copied into v2. v2 contains no dev directory.

Each constraint covers one independently testable explicit requirement. Preserve conditional, opening/ending, modality and quantity qualifiers. A supplied starting condition stays complete as continuation_start; no imaginary attached manuscript is assumed. Optional examples never become individually mandatory. T06 matches one-to-one when the same requirement and qualifiers are covered. Length metadata explains the same length constraint and does not add a second denominator item. Source requests for Reddit posts/guides keep their requested form.

Every authorBible label identifies authorGivenPart with a literal quote. A generated Bible item is user-sourced only when ALL substantive content is author-given. A seed plus model-added age, motives, mechanisms or geography is model-sourced; preserve the author-given component in a given_fact ledger item. Technical fixture keys are not author-given names. Prompt/game facts are annotated only as source premises, without importing outside lore.

AI construction/annotation and delegated AI review; the author accepted the applied result for freezing on 2026-10-30. The review covers all 230 items (159 constraints); JSON/schema checks do not imply gold approval.

Reproduce selection with an isolated Python venv under testing/exec/, pyarrow pinned in build/requirements.txt, python -I build/extract_prompts.py; then node build/build.mjs. Build scripts and source records are manifest-listed. No project role rules, paid models or measurement scripts were used.

Delegated Codex AI reviewed all original 219 items: 183 agreed and 36 changed. All changes, 13 reviewed additions and two removals are applied; effective labels are 159 constraints + 59 authorBible + 12 length = 230. Original labels, decisions, reasons and proposals remain in labels/delegated-review.json. Optional or routes are not separately mandatory. Approximate is true only for explicit about/roughly/around wording; target phrasing alone does not imply an outside-range allowance. This is not personal human review; the author explicitly accepted the corrected result for freezing; see labels/freeze-approval.json.
