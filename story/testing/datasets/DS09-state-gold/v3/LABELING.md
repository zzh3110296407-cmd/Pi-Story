# DS09 state gold v3

Input-only repair of frozen v2. All nine chapters, gold files, sentence files and three truth tables are byte-identical to v2; 219 author-accepted gold items, 72 key facts, 27 lifecycle operations and 27 traps retain their existing approval. Original v2 review and freeze approval are copied verbatim under labels/inherited-v2-*. No fresh personal human review is claimed.

The constructor now passes each initial upsert’s existing seed statement as expectedPayoff. The text is copied verbatim from that same committed chapter, without later clues or answers. Hook IDs remain story-scoped, and advance/mention/resolve still target the original IDs. Native P1 schema/validateDelta/foldBranch and the actual keeperInput carry the field. There is no runtime augmentation, duplicate hook state or product-code change.

Regression: frozen v2 fails 18/18 required existing-hook descriptions. V3 passes all 18 references over the six chapter-two/three inputs; chapter one has no prior hooks. Nine complete P1 gold commits pass. After removing expectedPayoff, all prior-entry and terminal-state objects equal v2, including quantities, temporal bounds, cognition and lifecycle states.

R4 development is separate from new acceptance. development-inputs/ contains 15 repaired prior-entry files covering BOTH v1 dev and original acceptance. Its index references the unchanged frozen v1 prose/gold by path and hash. Only hook upsert expectedPayoff is added; the actual keeper projection is checked for every fixture. Use these input overrides for R4, never the new acceptance stories. Frozen v1/v2 and historical runs remain unchanged.

Review: Codex AI verified all nine verbatim seed mappings and propagation. Gold semantics and author approval are inherited from the frozen source, not re-labelled or claimed as newly human-reviewed. The current task explicitly authorizes publishing and local commits after checks; this is an input serialization repair with zero new gold judgments.

Build only in an unpublished draft: node build/build.mjs, then node build/check-hooks.mjs if needed. Source commits/manifests are pinned in labels/source-pins.json. Requires the repository’s frozen source versions and existing P1 runtime. No paid model, role-rule text or measurement script is used. Freeze only after the recorded checks pass.

Frozen 2026-10-30 under the explicit current publication/local-commit request after input checks. New input verification is AI work; original gold approval is inherited unchanged. See labels/freeze-approval.json.
