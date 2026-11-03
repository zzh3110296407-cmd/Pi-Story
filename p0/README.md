# Pi Story P0

This directory contains probes for the fixed Pi revision
`b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6`. Production story code starts at P1.

Run all probes with the isolated runtime under `D:\开源\test\pi-Story\p0`.
The reference Pi sources remain intact; upstream MIT text is kept in `../LICENSE.pi`. Probe code is
AGPL-3.0-only; see `LICENSE`. The root license follows the P0 plan's AGPL choice. No model key belongs in this repository.

Preparation and per-item reproduction commands are recorded in
`../docs/p0/verification-report.md`. Run output, fixtures, caches and sessions
are stored on D under the isolated runtime, never in the reference repositories.

The tested setup uses Node 24.11.0 and npm 11.6.1. Clone the pinned revision
with `git clone --revision=<commit> --no-hardlinks <reference> <test-root>/pi`
so the disposable checkout has no local branch. Run `prepare-runtime.mjs install`,
`pin-model-data.mjs`, and `prepare-runtime.mjs offline` in that order. The
reference model catalog snapshot is recorded by SHA-256 in the S0 evidence.

The repository's `p0/node_modules` and `p0/fixtures` are ignored junctions into
the D-drive runtime. They contain no committed dependencies or fixture data.
`prepare-fixtures.py` uses bundled Python 3.12 and the PyArrow 21.0.0 binary
wheel installed only under the D-drive runtime; the source project Python 3.14
does not have a compatible wheel for that pinned PyArrow version.

Automatic item entry points are `verify-offline.ts`, `verify-model.ts`,
`verify-bridge.ts`, and `verify-web.ts`. The paid entry requires the matching
`P0_REAL_APPROVED` environment value, applies item/total caps, and records every
attempt in the shared D-drive ledger. Never substitute an actual key into a
command, source file or report.
