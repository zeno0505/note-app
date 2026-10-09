# note-app

A local Electron project workspace built with Vue, PrimeVue, Vue Router and TypeScript.

## Local development

Use Node.js 24+, npm, Git and a desktop display. Dependencies are pinned in package-lock.json.

```sh
npm ci
npm run setup:electron
npm run check
npm start
```

`npm run check` runs type checking, unit tests, updater tests and the production build. Electron UI tests are separate and require a working desktop/sandbox environment:

```sh
npm run test:electron
npm run test:electron:update
```

Some DAG integration tests require an externally supplied, trusted Python interpreter with PyYAML and the exact pinned query script. That script and personal DAG/configuration files are not distributed here. Without both environment variables, those optional integration tests are skipped; a normal check is not evidence they passed.

```sh
DAG_QUERY_PYTHON=/absolute/trusted/python3 \
DAG_QUERY_SCRIPT=/absolute/pinned/query.py npm run check
```

The reader validates the query script's SHA-256 before use. Electron DAG fixtures additionally use NOTE_APP_PYTHON and NOTE_APP_DAG_QUERY_PATH. Tests use disposable synthetic repositories, notes and profiles. Never target personal data with a test harness.

## Scope and privacy

The application provides fictional demonstration data and explicitly configured local project sources. Personal configuration, notes, DAGs, model caches and account observations stay outside this source distribution. Connecting a source does not authorize unrelated model calls or data sharing.

The bundled public-reading example is [explicitly synthetic](docs/synthetic-public-reading.md). Its all-zero source SHA is a fixture sentinel, not a real Git commit or update target. It contains no historical model run or personal approval. Public-example AI is disabled for this sentinel; existing local results remain preserved and are marked stale against the changed input. Explicitly registered project behavior is separate. This fixture is separate from explicitly registered project data and the source-updater release manifest.

This source snapshot contains no GitHub workflows, historical reviews/screenshots, recovery bundles, personal configuration or private Git history. Historical one-off model experiment/migration scripts are not included. The remaining generator tests exercise local temporary fixtures; workflow-publication tests are not part of this distribution.

## Source-based updates

Settings checks the fixed HTTPS release feed, displays the available version/build and changelog, and prepares the exact published source only after the user's action. Preparation requires existing Node.js 24+, npm and Git. Installation requires a separate confirmation and the supported canonical macOS application identity.

See [updater boundaries](docs/source-updater.md) and the [maintainer release procedure](docs/source-release.md). Local tests do not prove public release availability, native macOS acceptance, notarization or installed-application replacement. No remote publication is implied by this snapshot.
