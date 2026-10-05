# note-app

A local Electron workspace for understandable project progress. Built with Vue, PrimeVue, Vue Router and TypeScript.

## Run

Requires Node 24+ and a desktop display. Electron 44's upstream macOS floor is 13; macOS product/package support is not yet verified.

```sh
npm ci
npm run setup:electron
npm run check
npm start
```

## Verify

```sh
npm run test:electron:harness
npm run test:electron
```

These launch actual Electron windows. Chromium sandboxing remains enabled. See [verification scope](reviews/electron-test-infrastructure.md) and [application boundaries](app/README.md).

## Current scope

The secure application shell offers explicit fictional examples and an opt-in read-only live source view. Set a trusted local startup configuration, then connect from the UI. Orca, explicitly registered note/DAG scopes, optional CodeBurn observations and an existing local summary cache use their bounded main-process readers. See [local configuration and limits](docs/live-configuration.md).

The detail view also provides bounded summary-context/provider review and explicit candidate approval/rejection with app-owned cache persistence. A separately configured note-link workflow previews exact scoped symlink and local Git-exclude changes before confirmation. These user journeys are exercised with synthetic summaries and temporary Git/notes in actual Electron.

Live agent invocation, new real AI summary generation, development delegation and macOS packaging are not enabled. Missing summaries remain missing; production transport is hard-blocked. Bounded context preparation does not establish a safe live agent filesystem boundary. A successful Linux run is not macOS verification. See [Phase 1 outcomes and remaining acceptance](reviews/phase1-outcome-status.md).

No company project data or source code is included. The upstream source is the user-provided public personal repository. Publication to main plus a feature branch and draft PR is approved, and initial main exists. Work-branch publication is still being reconciled after a stalled upload. See [repository status](decisions/repository.md).
