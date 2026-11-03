# DS10 review defects v3

Input/source-reference repair of frozen v2, now based on committed DS09 v3. All 27 variant prose files and existing context files are byte-identical to v2; all 36 injected defect labels, line spans, classifications and 12 consistent-control labels retain their author-accepted review. This inherits all 48 existing gold decisions, not a fresh human review. Definitions and completed semantic/scope review are in the pinned DS10 v2 LABELING.md and labels/inherited-v2-review.json.

The actual prior-entry prefix is replaced with the corresponding DS09 v3 prefix. All 27 current drafts are recreated through P1 createDraft and checked to retain identical ID, basis, digest, count and text. Actual editorInput is checked for each variant: 54/54 existing-hook references have the verbatim already-reviewed seed. Removing hook expectedPayoff restores every original entry and editor input exactly. 18 later-chapter inputs change; the nine chapter-one inputs remain byte-identical. All defect/control source headers and the manifest/index now point to DS09 v3.

Separate R4 development overrides in development-inputs/ cover all 45 DS10 v1 variants across original dev AND acceptance. Their canonical v1 prose and gold are unchanged referenced files. Only prior hook upserts acquire the matching earlier gold seed; actual editor inputs are checked. These overrides are development-only and do not read the new acceptance source.

No product/schema/role-rule/measurement code, original frozen data or historical run is changed. No paid model call occurs. New serialization checks are Codex AI verification; existing author approval of unchanged gold remains the review basis. The current user explicitly requests repair, publication and local commits after checks. Source commits/manifests are pinned in labels/source-pins.json.

Build only in an unpublished draft with frozen DS09 v3 present: node build/build.mjs. Validation and review details are recorded in labels/input-repair-review.json. Freeze only after its checks pass.

Frozen 2026-10-30 under the explicit current input-repair publication/local-commit request after checks. Input verification is AI work; original gold approval is inherited unchanged. R4 consumption instructions are in DEVELOPMENT.md. See labels/freeze-approval.json.
