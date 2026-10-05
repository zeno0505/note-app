# Bounded read-only Orca adapter preparation

Status: local Phase 1 preparation for T-008, not task/DAG completion. T-003/T-004 decisions and the parent-owned integration/quality gates remain open. No real Orca executable is installed on this dot cloud Linux machine. No real project, note, conversation, or company content was collected. The application does not enable live collection through this module alone.

## Acceptance recorded before implementation

The assigned adapter slice and information contract were read before implementation on 2026-10-02. Their requirements were not relaxed to fit these tests:

- Allow only fixed main-owned `status --json`, `project list --json`, `worktree list --limit 1000 --json`, and `worktree ps --limit 1000 --json` argv
- Bound time, cancellation, combined output, schema and list sizes; reject overlapping collection
- Preserve runtime identity, truncation, host coverage and missing mappings; never present a failed source as successful emptiness
- Immediately allowlist raw responses, including responses that may contain prompts/previews/assistant/tool bodies
- Keep activity, terminal, agent and DAG observations separate; only observed agent `done` is understood
- Verify the actual argv runner with a local temporary executable, not only stubbed spawn calls; distinguish mock from real CLI and Electron integration

Input byte hashes at implementation start:

- `note-app-adapter-slices.md` (provided task-slice input): `161834a9287e911d7464532a0eb6c545127837108f985733abbc129f16f5fb79`
- `specs/information-contract.md`: `6c62a77f03527b9f41f643371a1ea6d938ff6ba54e230236eb7ade0f82251aa9`

The four response fixtures reproduce a sanitized, observed minimum shape from Orca 1.4.217 using invented values. They are not the official complete JSON schema. Observation metadata is nullable/unknown when missing. Required internal shape is explicit: a boolean envelope `ok`, success result object, correct list arrays, and stable source row IDs. Known fields with unsupported types/inconsistencies fail validation. New fields are discarded, not treated as instructions or required fields.

## Main-only API

`src/collector/orca/index.ts` exports `createOrcaAdapter`, `parseOrcaResponse` and the typed projections/results. Instantiate one adapter in the trusted main process; never accept executable paths or commands from the renderer.

- `createOrcaAdapter({ executablePath?, timeoutMs?, maxOutputBytes? })`
- `adapter.read('status' | 'projects' | 'worktrees' | 'processes', { signal? })`
- `adapter.collect({ signal? })`

The production default executable is the fixed name `orca`; a configured executable must be a trusted absolute path. Trusted executable discovery/approval and renderer IPC authorization remain the main process's responsibility. There is no shell, arbitrary argv, command string, cwd, environment override, agent-control or file-write option in this API. Unknown query values are rejected at runtime, including prototype property names.

Defaults are 5 seconds per command and 2 MiB combined stdout/stderr. Configurable upper bounds are 60 seconds and 8 MiB. Collection uses four serial commands, so its default maximum subprocess time is roughly 20 seconds plus cancellation cleanup. A singleton adapter prevents concurrent `read`/`collect`; this is not a cross-process global lock. A caller may cancel the whole collection with an AbortSignal.

Every exit path finalizes the owned query process group, including successful JSON, invalid JSON, nonzero exit, timeout, cancellation and overflow. Cleanup begins on the root process's `exit` event rather than waiting for `close`, because same-group descendants can hold the inherited stdout/stderr pipes open. SIGTERM is followed by SIGKILL after 100 ms if live group members remain. Normal results require the direct child's `close` event plus verified group cleanup.

On Linux, cleanup inspects only `/proc/<pid>/stat` state/group/session fields to verify that no executing members remain in the query's isolated process group. Orphaned zombie/dead members cannot execute or fork and do not block completion; PID existence alone is therefore not proof of a running leak. Because procfs enumeration is not atomic, an all-zombie/no-live snapshot cannot complete cleanup until the owned group has received SIGKILL and has been observed again. Kernel-confirmed ESRCH group absence can complete earlier. On other POSIX systems, cleanup waits for group disappearance. Windows covers the direct child only. Process-tree behavior on Windows/macOS is not verified here.

Cleanup verification has a roughly 1-second bounded window (plus one bounded observation interval). If group disappearance/liveness cannot be established, the result is the safe `cleanup_unverified` failure and that runner is permanently disabled against further starts. This failure explicitly does not claim all descendants exited; it is the conservative exception to the normal completion guarantee when OS visibility or termination fails. The command deadline remains active after root exit, so inherited descriptors from an escaped process cannot hang the read forever.

Signals target only the detached process group created for that query. Unrelated process groups are not signaled. Descendants that deliberately escape the original group with setpgid/setsid/new-session behavior are outside the ownership guarantee; this adapter does not claim to track or terminate such daemons.

The parser permits at most 1,000 worktree/process rows, 10,000 project rows, 1,000 agents per row and bounded strings/ID lists. The byte limit applies before JSON parsing; direct parser calls also have an 8 MiB cap. UTF-8 decoding is strict.

## Data and privacy boundary

Success values contain only the fields declared in `types.ts`. The request envelope ID is never used as a project/worktree ID. Fields such as prompt, preview, last assistant message, tool input/name, task titles, arbitrary error text and next-step suggestions are not copied. There is no raw-response return value, log callback or persistence layer.

The runner counts stderr bytes but never buffers or decodes stderr. Stdout is transient and bounded: it is decoded once, parsed and immediately allowlist-projected. Transient Buffers are zeroed after use or failure; JavaScript strings/objects are garbage-collected, so this does not claim secure erasure from process memory. JSON/schema errors return static safe messages and enums rather than source fragments, OS error messages or stack traces. An observed runtime ID can accompany a safe error because it is an allowlisted source identity.

Do not log the raw child streams in a future integration. Retain only sanitized results and explicit failure reasons. No remote summary, transport or credentials are introduced.

## State, coverage and identity

- Agent state is `done | unknown`; `working`, `idle` and future strings remain unknown until supported by authorized schema evidence. Agent done is never feature done, tests passed, deployed, or DAG done
- `isActive` and `activityStatus` preserve separate Orca observations. They do not establish selection or agent execution. Terminal count/PTY flags are separate observations
- `lastOutputAt` is only an output timestamp, never a heartbeat. No DAG status is projected or derived
- Runtime state `ready`, connection state `connected` and graph state `ready` are recognized individually; unknown future strings map to unknown
- `read('status')` may successfully observe a stopped/unknown runtime. `collect()` returns explicit unavailable when the app is stopped, the runtime is not reachable, or its state is not known ready
- `collect()` requires the same non-null runtime ID on all four responses. Missing identity or a restart yields a failure; no cross-runtime join or silent retry occurs
- Stable join keys are JSON tuples `[runtimeId, hostId, instanceId]`, not path, repo name or legacy worktree ID. Equal instance IDs on different hosts remain distinct. Missing host/instance yields an unresolved join; duplicate stable identities or contradictory joined source IDs yield explicit failure
- A worktree is mapped to a project only by an explicit `projectId`. A missing/null ID stays `missing-project-id`; a supplied but absent project becomes `project-not-observed`. Matching repo IDs never invent project ownership
- Processes not matched to a discovered worktree are preserved in `unmatchedProcesses`

Each list retains `returnedCount`, nullable `totalCount`, nullable `truncated`, nullable `hostIds` and nullable `omittedHostIds`, plus `complete | partial | unknown`. An omitted host or truncated/short count is incomplete; absent metadata is unknown. Known rows cannot claim an omitted/out-of-scope host. Normal empty, partial empty, unknown coverage and failed reads remain different states.

`project list` does not require pagination metadata: it was absent in the observed envelope. Consequently a typical successful collection has unknown project coverage even if worktree/process coverage is complete; overall `complete` is false unless every source has positively complete coverage. Consumers must show each source's coverage and avoid presenting this conservative flag as collection failure.

A source command failure makes `collect()` return `ok: false`, with no replacement empty observation and no partially assembled success. The parent snapshot layer may retain a prior successful observation as stale with its original observation time. This adapter does not implement cache, polling or freshness policy; those are later T-010 work.

## Synthetic executable and integration handoff

`fixtures/orca/mock-orca.cjs` is test-only. Copy it and the four adjacent JSON fixtures to a temporary directory, prepend a trusted Node executable shebang, chmod the copy 0700, and pass that absolute copy as `executablePath`. `fixtures/orca/test-helpers.ts` performs this setup for unit/integration tests. No generic Node launcher is part of the production adapter.

The fixture records only its fixed synthetic argv and PID locally. An optional adjacent `mode.json` contains `{ "kind": "...", "query": "status|projects|worktrees|processes" }`; omitting query applies the mode to every command. Modes include `hang`, `ignore-term`, `overflow`, `stderr-overflow`, `nonzero`, `invalid-json`, `invalid-utf8`, `denied` and `runtime-change`. Lifecycle regression modes `descendant-{closed|inherited}-{success|error|invalid|hang}` spawn an actual same-group descendant that ignores SIGTERM, using closed or inherited stdio; it is synthetic and writes only a PID marker. Synthetic canary strings in adversarial tests are invented and are asserted absent from adapter output.

For a parent-owned Electron/mapping integration, set `NOTE_APP_ORCA_FIXTURE_ROOT` in the trusted test harness environment. The fixture then replaces its worktree path and legacy ID with `<root>/demo` and the corresponding synthetic repo/path ID. This is fixture behavior only; the production adapter does not read that variable or expose environment overrides. The consuming harness owns its synthetic root and does not query real Orca.

## Verification

Focused commands from the repo root:

```sh
./node_modules/.bin/vitest run --root . tests/unit/orca-parser.test.ts tests/unit/orca-runner.test.ts tests/unit/orca-lifecycle.test.ts tests/unit/orca-cleanup-failure.test.ts tests/unit/orca-cleanup-race.test.ts
./node_modules/.bin/tsc --noEmit --module esnext --moduleResolution bundler --target es2022 --strict --skipLibCheck src/collector/orca/index.ts tests/unit/orca-parser.test.ts tests/unit/orca-runner.test.ts tests/unit/orca-lifecycle.test.ts tests/unit/orca-cleanup-failure.test.ts tests/unit/orca-cleanup-race.test.ts
```

Coverage includes exact argv, invalid query rejection without spawn, valid observed envelopes, omitted project pagination, optional metadata, adversarial unknown payloads, schema/count/host inconsistencies, UTF-8 errors, missing executable/OS denial, remote access denial, nonzero exit, timeout/SIGKILL, cancellation, overlap, stdout/stderr overflow, explicit empty/partial/missing mapping, cross-host identity isolation, runtime restart and failed refresh.

The final focused result and source manifest are recorded below. This is mock CLI real-process verification on Linux. It is not real Orca, macOS integration, packaged app verification or a declaration of T-008 done. The parent owns the actual Electron adapter integration and its evidence. This module adds no user-visible UI, so no duplicate screenshot was generated for the unit-only slice.

## Lifecycle correction and final evidence

An independent review after the initial 67-test run found that root-process close did not finalize live same-group descendants on normal/error returns. The prior direct-child-only evidence was insufficient. The runner was corrected to finalize the owned group on every exit path. A subsequent review caught a non-atomic procfs enumeration race, which was then corrected by requiring hard termination plus reobservation before trusting a no-live snapshot. Those earlier passes are superseded by the verification below.

Actual-process regressions now cover closed/inherited stdio descendants across successful JSON, nonzero exit, invalid JSON, timeout and cancellation, plus unrelated-group survival. A deterministic fork-after-enumeration regression also verifies that a successor omitted from a stale procfs list is hard-killed and reobserved before completion. A separate test keeps spawn and signals real while making liveness inspection unavailable; it verifies bounded safe failure and no subsequent spawn from that runner. Linux process-state assertions check that descendants are absent or nonexecuting zombies before normal/error results return.

Observed/report time: 2026-10-02 18:00 UTC. Both focused commands exited 0: **80 tests passed (5 files); strict TypeScript passed**. The runner output used the executor-local wall clock; the report time uses the conversation UTC clock. No failing focused tests remain. The parent must rerun its Electron integration against these corrected source bytes.

Final source SHA-256 manifest (documentation excluded to avoid self-reference):

```text
1a6593aade7e3c0955c86df9a1e70ae243daf3ef25ebe8fb3762797840f3f947  fixtures/orca/mock-orca.cjs
56e26b80822cc1a615f4cf210f90b032da2c84a1657cd469f7d9a4272dfc587a  fixtures/orca/processes.json
fc79886ef563270c2f12b3cacdcf1eaa93c8458b42164f0c81cbf7559e1c627b  fixtures/orca/projects.json
65a5e1f6133a5d6223134adea3e698131341f6c3bd17581e7f8fefd2ba7378a1  fixtures/orca/status.json
aedcd707dfab202294aa2520a6a4ed955bc8e9f43c799a1702622c20f034e638  fixtures/orca/test-helpers.ts
af828c384d5eea329b72965400a972c9ae6bd27a0838bba9469d94d51c1df056  fixtures/orca/worktrees.json
cd9437884027b98a6908dc6cb6d5409dd8d3cab03ef46ec1550914a7f88ffd86  src/collector/orca/adapter.ts
32a205bfb8e4208a4b6328b4c8a4e7b45e760db03a9524c5b0c832f6d4077714  src/collector/orca/commands.ts
74148c46e400b7d9f6c57174feb4f61dba76c80eed05063b8379acd0fe3dc7ae  src/collector/orca/errors.ts
71d726f00142848ed21d7363af85e30130f09a9ba6ede86757614f93c3a80efa  src/collector/orca/index.ts
a947e1b1c40d987273e219ffb8e9d39f9b224fb6084df1a71430d9a332577b65  src/collector/orca/parser.ts
70f20bfbb6847cdbec485fe04166ff8a5ec8fc3a9a94087d8ed853a2fcb3fcf9  src/collector/orca/process-group.ts
c718d32e4e237656a1d1bc35ee41cb0e59aacff1406d243d881c60c61cd67cec  src/collector/orca/runner.ts
2bab3b2a21d01cdca46bf3879528209e0ec60ff9419fcf895741333fc317320b  src/collector/orca/types.ts
d10926d4d30f8f09139b475c37c72e3f20bea5991924a4d306a77a33ce254152  tests/unit/orca-cleanup-failure.test.ts
a58901f85257379dc57526c1f3491ecb203bf756e235f91474956cdf0e412606  tests/unit/orca-cleanup-race.test.ts
0488a906f7d89782b14a76a45e4d563cb2b3cb769772d21dd68ecf590bd08231  tests/unit/orca-lifecycle.test.ts
618270224bffa5bd1267441fd9653fdc64e764916a3f94c0c1aadb65d863a79f  tests/unit/orca-parser.test.ts
de0a5c7f28a668ec218c0c8c74a98c19eeeafe27a647fdc85c961a0f9b1ad3cb  tests/unit/orca-runner.test.ts

```

## Final actual Electron evidence

See `reviews/collector-verification.md` for the exact clean code commit, final real Linux Electron fixture-integration commands/results, screenshots actually inspected and remaining scope limits. This is not real Orca or native Mac verification.
