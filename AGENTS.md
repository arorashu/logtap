# LogTap Contributor Guide

This repository implements LogTap, a local browser/client logging sidecar for
coding agents. Keep this file short: it is a map, not the full manual.

## Start here

- `README.md` for user-facing setup and API examples.
- `docs/spec.md` for the v0 product and implementation spec.
- `docs/oss-release.md` for public release readiness.
- `docs/future-plans/` for non-v0 ideas and exploration notes.
- `llms.txt` for LLM-facing guidance intended for agents using LogTap output.
- `src/browser/` for the browser SDK.
- `src/server/` for ingest, storage, retention, dedupe, summaries, source maps,
  and runtime adapters.
- `src/shared/` for schema, normalization, fingerprinting, project IDs, and
  shared types.
- `test/e2e.test.ts` for the client-to-sidecar path from a user application's
  point of view.

## Core invariants

- Do not add a database, dashboard, Express, or mandatory server runtime
  dependency unless `docs/spec.md` changes first.
- Preserve redaction before storage.
- Preserve bounded per-project and global retention.
- Preserve dedupe, rate-limit, and rollup safeguards.
- Keep observed/stored/suppressed counts honest in summaries.
- Never let browser logging failure break the host app.
- Keep source-map enrichment optional and non-blocking.

## Verification

Run these before handing off behavior changes:

```bash
bun test
bun run test
bunx tsc --noEmit
bun run build
```

When debugging a frontend issue with captured LogTap output, inspect:

- `.agent/logtap/projects/<project-id>/summaries/latest.md`
- `.agent/logtap/projects/<project-id>/logs/client.jsonl`
