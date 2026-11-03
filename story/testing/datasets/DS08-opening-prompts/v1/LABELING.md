# DS08 opening prompts v1

Eight train/development prompts and twelve valid/acceptance prompts, two/three per task respectively. Only English train and valid were read; test was not accessed. Exact id/language/task_type/prompt values are retained. Source SHA-256, zero-based row index and one-based row number are recorded per prompt. MIT license text is copied with LF line endings; its original byte hash is recorded in the manifest.

Selection uses seed20261029, independent Python Random shuffles per source split and task, taking the first qualifying row. One scene-only candidate is explicitly rejected in labels/selection-audit.json. No prompt was rewritten, including source wording, proper names or stylistic references.

Each constraint is explicit and independently testable. Match T06 when the same requirement is covered without broadening/narrowing its conditions; match one-to-one, not by lexical similarity alone. Quoted starting premises are a continuation_start rather than fabricated prior prose. AuthorBible keys are technical identifiers; qualified claims remain claims. Optional examples are not mandatory separate constraints. Length metadata is not counted a second time in T06.

Development labels are AI-only. Acceptance labels were reviewed by delegated AI and their effective results were accepted by the author before freezing. Original decisions and 23 additions from the user-delegated AI review are preserved in labels/delegated-review.json; 51 changes are applied, including nine removals. This is not personal human review. Author explicitly accepted the applied delegated review and authorized freezing/local commit on 2026-10-29; see labels/freeze-authorization.json. Do not treat a JSON/schema check as semantic gold approval.

Build: use an isolated Python venv with build/requirements.txt and run `python -I build/extract_prompts.py --select`, then `node build/build.mjs`. No model requests or implementation measurement scripts are used.
