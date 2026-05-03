# OSS Release Checklist

Use this as the release-readiness tracker for publishing LogTap.

## Ready for GitHub sharing

- Package name is `@arorashu/logtap`.
- MIT license is included.
- Package metadata points at `github.com/arorashu/logtap`.
- Exports point at built `dist/` JavaScript and declaration files.
- `prepare` builds the package for Git installs.
- CI runs `bun test`, `bun run test`, `bun run typecheck`, and `bun run build`.
- Local packed tarball verification passes for npm install, server import,
  browser import, and CLI help.
- Local packed tarball verification also starts the programmatic Node server
  fallback successfully.

## Required before npm publish

- Create the GitHub repository and verify the metadata URLs.
- Confirm source-map support behavior when `@jridgewell/trace-mapping` is not
  installed.
- Decide whether the Bun-powered CLI is acceptable for npm users, or whether to
  add a Node-compatible CLI entry point.
- Run a final README pass after the first GitHub URL exists.

## Documentation shape

- `README.md`: public quickstart and overview.
- `docs/spec.md`: v0 implementation spec.
- `AGENTS.md`: contributor map for agents working on this repository.
- `llms.txt`: compact guidance for agents using LogTap logs in app projects.

## Release invariants

- No database.
- No dashboard.
- No required server framework dependency.
- Redaction happens before storage.
- Per-project and global retention stay bounded.
- Dedupe and rollups preserve observed/stored/suppressed counts.
- Browser logging failure never breaks the host application.
