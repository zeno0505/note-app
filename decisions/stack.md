# Stack and development configuration — T-003

User-selected: Electron + Vue + PrimeVue + Vue Router + TypeScript. The goal is an understandable local desktop app with familiar frontend tooling. No company application code or dependencies are copied. The repository uses only upstream packages and entirely fictional fixtures.

## Installed local candidate

Pinned in package.json/package-lock.json: Electron 44.5.1, Vue 3.5.43, PrimeVue 4.5.5, Vue Router 4.6.4, TypeScript 5.9.3, Vite 7.3.6, esbuild 0.28.2, Playwright 1.63.0 and Vitest 4.1.11. Vite compiles the Vue renderer; esbuild bundles separate main and sandbox-compatible CommonJS preload entries. Package versions reflect actual installation, not the Mac's Node version.

Electron 44's upstream minimum is macOS 13 ([release notes](https://www.electronjs.org/blog/electron-44-0)). Product minimum macOS, package/signing policy and release testing remain decisions, so T-003 is not declared complete.

## Exact commands

- `npm ci` installs pinned dependencies
- `npm run setup:electron` downloads the official Electron binary (Electron 44 installer is explicit)
- `npm run typecheck` checks TypeScript/Vue
- `npm test` runs domain/security/fixture tests
- `npm run build` builds renderer/main/preload
- `npm run check` runs typecheck, unit tests and build
- `npm start` launches the built local Electron app on a desktop display
- `npm run dev` rebuilds then launches the app; no remote dev server or hot reload
- `npm run test:electron:harness` runs isolated real Electron infrastructure proof
- `npm run test:electron` runs built-product-shell Electron checks

For isolated cloud command runners use `npm --cache /tmp/note-app-npm-cache ...` and `XDG_CACHE_HOME=/tmp/note-app-cache npm run setup:electron`. A desktop display is required for Electron tests; do not replace them with browser-only tests and do not add `--no-sandbox`.

The evidence report distinguishes actually executed commands from candidates. Packaging is deliberately not advertised as supported until T-025 decisions and native verification. Playwright's Electron API is experimental; release fuses are not changed to enable tests.
