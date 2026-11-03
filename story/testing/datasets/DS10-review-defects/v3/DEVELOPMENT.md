# R4 development input handoff

This is an input override, not new development prose or gold. Both original v1 dev/ and original acceptance/ are development-only under plan23. The frozen source files and historical runs stay unchanged.

| Role | Original prose/gold source | Replacement input index |
|---|---|---|
| Keeper | DS09-state-gold/v1, both splits | DS09-state-gold/v3/development-inputs/index.json |
| Editor | DS10-review-defects/v1, both splits | DS10-review-defects/v3/development-inputs/index.json |

Each index item has the original split, story/chapter, replacement `input` path, and canonical `prose`/`gold` references with SHA-256. Resolve `input` relative to that v3 version root. Resolve prose/gold under `story/testing/datasets/<dataset>/<version>/<path>`. Load the referenced original prose and gold, but use the replacement BranchEntry array instead of the original v1 entries file. No BranchEntry schema adaptation is needed.

The keeper index covers 15 chapters and verifies 35/35 prior-hook descriptions in actual keeperInput. The editor index covers 45 variants and verifies 105/105 in actual editorInput. Only initial hook upserts acquire expectedPayoff copied verbatim from their own already-committed v1 gold seed. Other entry content, current drafts, text, gold and classifications remain unchanged. An input contains no seed from the current/future chapter.

Use the v3 `acceptance/` directories only for the new formal retest: DS09 has nine v2-origin chapters with fixed prior-hook descriptions; DS10 has 27 corresponding variants based on DS09 v3. Do not use these new acceptance stories for R4 tuning, and do not mix either development override index into an acceptance denominator.

The old source versions remain usable for historical reproduction, including their original missing-description behavior. New development/acceptance calls have different input digests and need new run records; old records are not repaired in place. This handoff performs no paid model call and claims no new performance score.
