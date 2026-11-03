# DS14 v2 — frozen, author overall accepted

Constructed and delta-checked by Codex AI on 2026-11-02; no paid calls. This is not a human item-by-item signature or an acceptance run. The author approved the checked paired candidates on2026-11-02: “整体认可，冻结并本地提交”. This frozen release records AI construction and delta self-check plus author overall acceptance under plan31 §4 /16 §3.4. See labels/author-acceptance.json; the reviewed pending form is preserved separately as the actual review snapshot. Previous frozen versions and judgments remain immutable.

All15 acceptance scenarios and their split index are byte-identical to frozen v1. The five old dev files are also unchanged; two newly written development cases bring dev to7. All cases retain @1 E2E execution. See labels/revision-v2.json for hashes.

Development reads only dev/index.json, referenced dev files, build/CONTRACT.md and build/scenario-contract.mjs. Builders/revision labels/review forms/acceptance contain gold and remain outside development input. Execute preparation through the normal extension/session constructors; the execution session verifies preparation replay and its new runner under faux providers. The supplied static/core checks do not prove RPC scheduling, automatic continuation or model behavior.

Reproduce both candidate datasets with python build/build_revision.py --repo <repository> --output <fresh-ignored-draft-root>. Never rebuild a published version. The standalone validator is development-safe; the paired validate.mjs reads acceptance and belongs to data authoring. Every delivered file except manifest itself is registered with SHA256.
