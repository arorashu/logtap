# OSS Release Checklist

Use this as the release-readiness tracker for publishing LogTap.

## Required before first public release

- Choose the final npm package name. `package.json` currently uses
  `@your-scope/logtap`.
- Add `LICENSE`.
- Add package metadata: repository, homepage, bugs, keywords, author, and files.
- Decide whether published exports should point at built `dist/` files instead
  of TypeScript source files.
- Decide whether local development keeps path-based source exports or uses the
  same built package shape as public npm.
- Add CI for `bun test`, `bun run test`, `bunx tsc --noEmit`, and
  `bun run build`.
- Verify the CLI install path works from a packed tarball.
- Confirm source-map support behavior when `@jridgewell/trace-mapping` is not
  installed.
- Review README examples after the final package name is chosen.

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
