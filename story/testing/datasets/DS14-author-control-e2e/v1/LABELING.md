# DS14-author-control-e2e v1 — frozen, author accepted

Identity: Codex / GPT-6, AI construction, labeling and self-check. English synthetic fiction; source requirements: plans28 and29 (2026-11-01). License: AGPL-3.0-only under the repository. No third-party fiction, private material or paid model call was used. The author accepted all47 acceptance scenarios and authorized freezing on2026-11-01: “整体认可，冻结并本地提交”. This is AI construction and self-check plus author overall acceptance, not personal human item-by-item review. See labels/author-acceptance.json.

Development and acceptance have different story families. DS11 has15 development and32 acceptance scenarios across A–M; DS14 has5 development variants and15 acceptance cases (10real,5faux). Only this dataset's indexed files are consumed; the totals above describe the paired delivery.

Read build/CONTRACT.md before implementing the driver. The first action, argument paths, negative conditions, timed controls, UI answers, faux profiles, no-gold-in-prompt rule and driver probes are all specified there. A failed observed check is not an inapplicable item. Missing measurements are incomplete, not success.

labels/static-validation.json contains actual offline core preparation results, not P3 product acceptance. The paired67-case validation used114 real core commits and342 local faux role calls, zero paid calls. All source commands and feasible update/patch reference actions were checked. Real RPC/command adapters, auto-continuation, interjection scheduling, U7 retry and model behavior still require the execution session's suites.

Rebuild both datasets into a new ignored draft root from the copied build/build_scenarios.py with --output-root. Then run build/validate.mjs with the paired root and an output JSON path. Do not run the builder into a frozen dataset path. build/pack_review.py is the review packaging source and uses the work-in-progress root; source it only in the data-authoring session, not during development tuning. Scripts contain acceptance definitions and must not be read by developers before acceptance.

This completev1 is frozen after author acceptance. All scenario and split-index bytes match the reviewed draft and original J1 development pins. See labels/freeze-verification.json. Only datasets/DS11-*, datasets/DS14-* and the testing index belong to this release. Old versions, P2 judgments and unrelated work stay unchanged. Future J3 depends on P3 runs and separate author acceptance.
