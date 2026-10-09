# Summary UX isolated verification candidate

Source commit: `c6cf22c91e2aa19b00b6e204fbc97b682d1115b2`

Bundle prerequisite: `b8324818aee41d3c8a34b3720c802125263c885d` (available in the prior source delivery bundle)

Decode the adjacent base64 file to a binary Git bundle. Binary SHA-256: `f345bd32d33d66c54732c6dc5ba83914aac56a5ae7ae53c6548eaa5feefc6d34`.

The bundle contains exactly five commits after the prerequisite: Phase4 document review, portability/layout corrections, native layout regression, cancellation focus correction, and summary UX. It contains repository source only, no runtime artifacts, credentials, or corporate code.

This transport branch is based on public main solely to deliver the bundle. It is not the source candidate branch and must not be merged or released. Import the bundle into an isolated source checkout, verify HEAD and clean status, install locked dependencies using the existing approved setup, then run configured checks and `npm run test:electron:summary-review` after building. Use synthetic fixtures and adapters only. Do not install into the stable app path, alter release feeds, or execute real model calls.

Verified on dot Linux: 2,391 unit tests, zero skips, 79 updater checks, typecheck/build; eight summary Electron scenario groups; fourteen Phase4 Electron groups. UI/security findings were fixed and rechecked. Build evidence predates the bookkeeping commit but uses its exact product source.

Remaining product gap: linked worktree/common Git metadata support and broader task activity coverage are unresolved. This candidate is not completion of that recency goal. See `docs/reviews/summary-ux-20261009.md` and `docs/summary-backend-contract.md` in the imported source.
