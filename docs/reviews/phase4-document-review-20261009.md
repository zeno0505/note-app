# Phase4 document review implementation

## Approved purpose and boundary

Implement the approved inline task-related viewer, expanded reading/return, and independent Project Documents tab using the four reviewed mockups. Initial formats: Markdown with safe inert Mermaid diagrams, PNG, and read-only YAML/JSON source. Browse the verified project note root and separately, explicitly granted project source-document/review folders. Relative links, wikilinks and headings must retain missing, ambiguous, unsupported and out-of-scope distinctions. Reading must not launch an external app, run a model, execute document code, or write a source file.

Baseline: `b8324818aee41d3c8a34b3720c802125263c885d`. Existing stable Phase3 distribution is unchanged. Main merge, release feed and deployment are outside this run. Separately approved source-only delivery artifacts support isolated native verification.

## Acceptance record

- Implemented: main-owned bounded catalog/capability IDs, relationship provenance, scoped links and explicit grant/revocation
- Implemented: inline/expanded shared reader and independent Documents tab with safe navigation/state migration
- Implemented: full bounded source reading, inert constrained Mermaid, explicit unsupported-format/source fallbacks
- Configured aggregate check passed: 102 unit suites / 2,309 tests, 79 updater tests, typecheck and production build
- Independent code/security signoff: no confirmed P1/P2 blockers; 286 focused tests and all 422 source-manifest entries verified. Manifest SHA-256: `a37c9156a7df9af4641d28ea9a0b0dcef68e15601b99798a92df4605071a2975`
- Actual Linux Electron passed: generic app/security smoke, Phase4 document flow, Phase2 workspace, project onboarding, project creation, light/dark theme and synthetic updater UI
- First-pass actual Electron persona review completed; fresh-profile targeted verification passed real native folder grant/read/revoke/cancel and all three reader visibility/recovery fixes. Original first-pass findings remain preserved
- Native macOS actual helper module passed; complete installed Mac Phase4 UI coverage is not claimed

## Synthetic evidence

`tests/electron/phase4-fixture/setup.mjs` creates fictional 54-task data (29 in_review, 23 pending, 2 done), a pending T-042 document viewer, hundreds of Markdown entries, dozens of PNG files and large Markdown/YAML/DAG sources. These dimensions represent the requested workload. No private repository body or personal note is copied.

Final checks must bind their results to the current build hash and source candidate. Source mutation, external requests and model calls must be observed explicitly; a screenshot alone cannot establish these properties.

## Independent review and corrections

| Finding | Correction and required evidence |
|---|---|
| Temporary ancestor swap could expose outside filenames during path-based enumeration | Pin the opened directory and derive entry metadata from its descriptor; never fall back to unchecked canonical enumeration. Reproduce swap/restore with synthetic directories |
| Exact-file metadata could falsely report an outside file as present | Apply descriptor ownership to resolver and record-discovery presence checks as well as catalog enumeration |
| JSON formatting rounded large numeric literals and removed duplicate keys | Preserve exact JSON source, including whitespace, numeric tokens and duplicate keys |
| Recheck could release a reused child-reference capability | Retain owned capability IDs and release only genuinely new stale-response handles |
| Overlapping filename searches could discard the latest query | Serialize and coalesce pending requests; delayed-response regression |
| Old document anchors could leak into another selected file | Bind restored position to the verified document key and reset on different files |
| Expanded return control could start above the viewport | Bring the expanded reading origin/return into view and restore outer/task/list/graph positions on return |
| Selected related document could open below the visible page | Reveal and focus the reader header, retain viewer height through loading, then restore explicit anchor/history position; targeted fresh-build verification |
| A native folder picker left open beyond collector freshness could return without a proposal | Refresh observations after the picker while retaining the original project/window identity and cancellation checks; ten focused tests plus delayed native-window scenario |
| Missing-heading feedback appeared only below the source body | Expose typed anchor outcomes beside reader controls, focus the non-destructive status and offer return to the previous reading position; preserve successful anchor focus |
| Native picker cancellation had no visible outcome | Show explicit cancellation/no-change status next to the folder controls |
| Duplicate text-form heading anchors could silently select the first heading | Report ambiguity; explicit unique generated slugs remain deterministic |
| An eight-step link proof limit could hide an otherwise permitted document | Preserve the body and expose an explicit deeper-navigation limit/recovery path |

These are developer/agent findings and synthetic reproductions, not real-person usability research. Final verification must be rerun against the coherent final candidate.

## Native portability finding

Linux supports descriptor-bound paths through `/proc/self/fd`. A separate synthetic native macOS probe found that `/dev/fd/N` cannot enumerate directory children: Node and Electron Node mode returned `ENOTDIR`/`ENOENT`. Therefore the implementation must not claim Mac support from the Linux path or fall back to path-based enumeration.

A subsequent Mac probe confirmed the configured trusted Python can enumerate an inherited open directory descriptor using `os.scandir(fd)` and no-follow entry metadata under parent-directory swap/replacement. The exact bundled product module then passed seven synthetic checks under both Node 26.10.0 and actual Electron 44.5.1 browser-main / Node 24.21.0, with `ELECTRON_RUN_AS_NODE` unset and an explicit disposable profile. These checks cover 313-file enumeration, nested no-follow metadata, parent replacement, changed child inode, symlink rejection, pre-cancellation and explicit bounds. Temporary files/profile were removed; installed app data was unchanged. Module SHA-256: `9b6cae6f168ae1dd8614ccbe1b136f8bb0c3d889a327a27f3b0da98ae19b2d35`. This is native module evidence, not a claim that the complete Phase4 installed Mac UI was exercised. The helper reads metadata only, executes no document content, and performs no network/model/source-write actions.

## Mermaid compatibility

[Exact supported Mermaid syntax](../phase4-safe-mermaid.md) describes constrained flowchart/graph nodes, edges, groups and class-name text. Source CSS is not applied and this is visibly disclosed. ER diagrams and unsupported syntax remain full source. The previously sampled three DAG blocks were structurally checked without copying their private labels or bodies; all three parse after group/class/line-break support. Synthetic tests mirror those syntax families and graph dimensions.

## Explicit reading limits

- Text: 8 MiB maximum, full source or explicit size error; no silent text truncation
- Catalog: up to 5,000 examined names per bounded search, 24 levels, 128 entries per page; partial results are labeled
- Roots: project note root plus at most seven separately confirmed document/review roots
- Linked-document proof chain: eight steps; the permitted body remains readable when deeper link derivation is blocked
- Links stay within the current approved root. A relative link that exits it remains out-of-scope even when another folder was separately granted; select that folder explicitly in Documents
- Wikilinks check only current-document-relative/current-root-relative candidates, plus the verified note-root vault prefix. Ambiguous matches require a choice; no basename or vault scan
- Block anchors retain source text with an unsupported-position notice; missing/ambiguous headings do not silently select a different target
- YAML and JSON remain source. Dedicated PDF/CSV/SQL editors and executable HTML/Slidev are outside the initial scope

## Verification artifact delivery exception

The standalone synthetic metadata probe and its README were explicitly approved for transfer through a separate public delivery branch after Library materialization failed on the Mac. Only those two safe generated files were published, at delivery commit `9d473cf2f7e4726099226b354d986b39aeb29325`. The feature implementation, main branch, release feed and deployment were not published by this step. Probe SHA-256: `0c5a786dca0afb27b3b024cc48c5d1f35bfec7bcdb869dc6a9508b7405afd555`.

## Runtime evidence notes

The final production build fingerprint is `b97020f4cdb26e69425263a4b3ae9ec5063bc30f0157bcba64443abbef2003f4`; main bundle SHA-256 is `53502328a471b10ac83df18409120f595195ecb3fecd3894861917177226a409`. Synthetic dimensions: 54 tasks, 555,458-byte Markdown, 2,366,435-byte DAG, 2,067,953-byte YAML, 313 review Markdown files and 63 PNGs. Full end markers and exact source hashes are asserted. This is representative synthetic evidence, not a copy or full audit of private repositories.

The final Phase4 flow observes zero model subprocesses, zero HTTP(S) document requests, unchanged original note and separately granted source-folder bytes, and complete test-owned process/fixture cleanup. It checks paginated scope discovery, ambiguous/missing/out-of-scope links, snapshot drift and explicit reread, full source views, 19-node/19-edge/3-group inert SVG, ER fallback, independent zero-task browsing, and revocation. A scripted native-picker response with a real 41-second window hide/show tests freshness recovery; the independent persona separately tests the real native picker.

At 200% Electron zoom, Playwright's screenshot path returned a blank image while DOM assertions passed. This image is retained as a tooling failure, not visual acceptance. Electron `capturePage` and a separate original native-desktop capture showed the real wrapped reader controls, heading, acceptance text and table at a 760-pixel window width. Native scrolling was exercised; no product rendering patch was required. Screenshot waits and the optional native-observation pause are bounded so failed evidence capture cannot indefinitely postpone test cleanup.

Two old harness assumptions were corrected without changing product behavior: the generic app test's obsolete 18-method preload allowlist became an exact source-verified 75-method allowlist with additional hidden-property/symbol/nonfunction rejection; and the document test now reopens a related document after first catalog consent intentionally invalidates the previous scope-bound capability.

## Independent targeted result

A separate fresh-profile agent-operated native UI pass completed the real folder picker, exact folder review/acknowledgement, `source-review.md` reading, and revocation. Revocation removed the granted root, matching result and open source body; the retained query showed zero results. Passive main-process picker metadata separately recorded two cancellations and then the exact successful synthetic path. This does not rewrite the first-pass picker observation or establish its original cause.

The corrected related-card click exposed reader actions immediately. Requirements/review loading retained geometry and loaded content remained visible without extra outer-page scrolling. Missing-heading feedback appeared beside reader controls with source-preservation wording and recovery actions. Task return, keyboard close and original trigger focus worked. A minor residual is awkward wrapping in the folder scope confirmation at the tested normal width; no grant/scope information was lost and it did not block the observed flow. This is not a real-person study or screen-reader/accessibility certification.

Both persona profiles observed zero model calls and HTTP requests and were removed after verified app/process cleanup. The final targeted pass contains 40 original screenshots; the original pass contains 60.

## Source delivery and distribution status

The separately approved Phase4 source transfer uses a prerequisite-bounded Git bundle with public baseline `b8324818aee41d3c8a34b3720c802125263c885d`. Its provenance must identify the exact source commit/tree and bundle hash; the delivery-branch commit is not the build source. The approved delivery is limited to the bundle and provenance for isolated Mac testing, without dependencies, build output, private data, release feed or deployment. Version remains `0.1.1` because no application distribution/update is produced in this run. Complete installed Mac Phase4 UI verification remains distinct from the already-passed native metadata module probe.

## Native Mac follow-up correction

The first isolated Mac run of source `cc93b2af` exposed 23 test-fixture failures despite the Linux check passing: 12 catalog tests lacked the native metadata transport; eight runtime tests used a nonexistent synthetic interpreter or Linux-only I/O interception; two direct-read tests supplied a noncanonical temporary root; and one ancestry-bound test used the synthetic interpreter. Those fixtures now exercise the real configured trusted interpreter and descriptor transport with canonical temporary roots and platform-independent stalled-handle assertions. No failed Mac checks are skipped and product root/capability security is unchanged. Native retesting, not Linux success alone, determines their Mac result.

The synthetic Electron Python logging wrapper previously dropped inherited descriptor 3. It now forwards that descriptor only for the fixed isolated metadata invocation after verifying it is a directory; normal DAG queries do not inherit it. Metadata logs are distinct from DAG-query logs. Cleanup now checks actual PID liveness outside Linux and uses the current 12-argument DAG transport's snapshot-directory field, rather than treating absent `/proc` or the final shape flag as cleanup evidence. New actual-subprocess regressions cover forwarding, missing-descriptor rejection, nonforwarding and cleanup contracts.

The Mac screenshot also showed severe single-character wrapping in the grant proposal, superseding the initial cloud pass's minor-wrap classification. The cause was the global horizontal `.notice` flex style. Proposal and revocation content now have a scoped single-column layout, independently wrapping paths and non-shrinking action buttons that stack at narrow widths. Source/consent semantics are unchanged. This correction must be visually retested in the native app before declaring the issue closed.

## Picker cancellation focus follow-up

The isolated native Mac retest of `db6abd8` passed the original 23 failing checks, 79 updater checks, typecheck/build and 13 Electron scenarios. The grant layout passed at 760px and 200% zoom. Native cancellation of the folder picker revealed one remaining focus defect: the disabled initiating button lost focus to the HTML root. The component now restores that button only after re-enabling it, when the same project view is still active/current and no newer control has focus. Cancellation still grants no folder. Renderer regressions cover both initiators, HTML/body focus, inactive/stale/removed views and competing focus; actual native Mac confirmation remains required for the correction.

The earlier Linux/Mac test counts are precisely reconciled: Linux registers 2,333 cases; Mac registers 2,319 because the 14 Linux descriptor-path catalog cases are not applicable there (the inherited-fd catalog cases still run). Mac passed 2,305 and skipped 14 pre-existing Linux-only procfs cases: one cleanup-failure, one cleanup-race, eleven Orca lifecycle, and one update-source case. These are platform skips, not optional Python omissions. The first default-parallel Mac run had one synthetic writer startup timeout; the isolated writer suite passed all 27 cases, and the complete run with two workers passed. That resource-sensitive run is disclosed separately from product behavior.
