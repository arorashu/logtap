# LogTap

A minimal, resource-efficient client-side logging harness for web development. It captures browser errors and warnings, ships them to a local sidecar, stores them in bounded JSONL files, and exposes agent-readable summaries.

## What it is not

- Not a full observability platform
- No dashboard
- No database (Sentry, ClickHouse, Postgres, etc.)
- Not for production-scale deployments
- Does not capture request/response bodies by default

## Quickstart: Vite + React

```ts
// src/logtap.ts
import { createBrowserTap } from "@your-scope/logtap/browser";

export const logtap = createBrowserTap({
  endpoint: "http://localhost:4319/__logtap/ingest",
  app: "my-app",
  env: import.meta.env.MODE,
  buildSha: import.meta.env.VITE_BUILD_SHA,
  getRoute: () => location.pathname,
  enabled: import.meta.env.DEV,
});
```

```ts
// src/main.tsx
import "./logtap";
```

Manual breadcrumb:
```ts
logtap.breadcrumb("checkout.submit.clicked", { plan: "pro" });
```

Manual error:
```ts
try {
  await submitCheckout();
} catch (err) {
  logtap.error("checkout.submit.failed", err, { plan: "pro" });
  throw err;
}
```

## Quickstart: generic browser app

```html
<script type="module">
  import { createBrowserTap } from "https://cdn.example.com/logtap/browser.js";
  window.logtap = createBrowserTap({
    endpoint: "http://localhost:4319/__logtap/ingest",
    app: "my-site",
  });
</script>
```

## Start the Bun server

```bash
bun run bin/logtap.ts start --port 4319 --root .agent/logtap
```

Or with source-map support:
```bash
bun run bin/logtap.ts start --dist ./dist --sourcemaps
```

## Node fallback

If Bun is not available, the server automatically falls back to Node.js `node:http`. No extra configuration needed — the `createLogTapServer()` function detects the runtime.

## Read tail and summary

```bash
# last 200 events for a project
bun run bin/logtap.ts tail --project billing-ui.dev

# only errors
bun run bin/logtap.ts tail --project billing-ui.dev --level error

# summary (last 15 minutes)
bun run bin/logtap.ts summary --project billing-ui.dev --since 15m

# summary as JSON
bun run bin/logtap.ts summary --project billing-ui.dev --json
```

HTTP endpoints:
```
GET  /__logtap/tail?project=billing-ui.dev&n=200
GET  /__logtap/query?project=billing-ui.dev&level=error&since=15m
GET  /__logtap/summary?project=billing-ui.dev&since=15m
GET  /__logtap/summary.md?project=billing-ui.dev&since=15m
POST /__logtap/clear?project=billing-ui.dev
GET  /__logtap/healthz
```

## Project organization

Logs are organized by project ID under `.agent/logtap/`:

```
.agent/logtap/
  projects/
    billing-ui.dev/
      logs/client.jsonl
      summaries/latest.md
      summaries/latest.json
      artifacts/<build-sha>/
    admin-console.preview/
      logs/client.jsonl
      ...
```

Project ID resolution order:
1. `event.projectId` if provided
2. `${event.app}.${event.env}` if both present
3. `${event.app}.dev` if only app present
4. `default.dev`

## Retention policy

Default limits (configurable):
- Per-project: 25 MB / 25,000 events / 24 hours
- Global: 100 MB across all projects
- Strategy: truncate oldest entries when a limit is exceeded
- No log rotation in v0 — one bounded file per project

## Dedupe and rate-limit

LogTap uses server-side deduplication to avoid flooding the JSONL file with identical errors:

- First occurrence of any fingerprint is always stored
- Stored again at milestone counts: 1, 10, 100, 1000, 10000
- Stored again after minimum intervals: 10s (errors), 60s (warnings), 30s (network)
- Suppressed duplicates are summarized in periodic rollup events
- Summary always shows observed vs stored vs suppressed counts

Client-side deduplication (enabled by default, count-preserving):
- Max 500 fingerprints tracked
- 60-second window
- First occurrence is sent immediately
- Suppressed repeats are counted and sent as compact rollup events
- Summaries preserve observed/stored/suppressed counts

## Resource footprint

- Idle RAM: ~20–60 MB
- Disk: hard capped at 100 MB globally (default)
- CPU: near-zero at idle
- No database, no external services

## Security and redaction

Before storing, LogTap recursively redacts fields with sensitive names:
`authorization`, `cookie`, `set-cookie`, `password`, `token`, `secret`, `apiKey`

URL query parameters are also redacted:
`token`, `secret`, `key`, `password`, `code`, `auth`, `session`

To add custom redacted fields:
```ts
createLogTapServer({ redactFields: ["mySecretField"] });
```

No auth is required by default. To enable token auth:
```ts
createLogTapServer({ ingestToken: "your-secret-token" });
// client must send: Authorization: Bearer your-secret-token
```

## Source-map artifacts

Register build artifacts for mapped stack traces:

```bash
bun run bin/logtap.ts artifacts add ./dist \
  --project billing-ui.dev \
  --build-sha "$GIT_SHA"
```

Artifacts are stored at:
```
.agent/logtap/projects/<project-id>/artifacts/<build-sha>/assets/
```

The `@jridgewell/trace-mapping` package is an optional dependency. If not installed, source-map enrichment is skipped and `sourceMapStatus` is set to `missing`.

## Example agent workflow

1. Frontend shows an error. Agent starts debugging.
2. Agent reads `.agent/logtap/projects/billing-ui.dev/summaries/latest.md`
3. Summary shows: 9 occurrences of `Cannot read properties of undefined` on `/checkout`, stack top `src/components/PlanCard.tsx:44`
4. Agent reads the specific component and fixes the null check.
5. Agent verifies no new errors appear in `logs/client.jsonl` after the fix.

## Programmatic API

```ts
import { createLogTapServer } from "@your-scope/logtap/server";

const server = createLogTapServer({
  port: 4319,
  rootDir: ".agent/logtap",
  maxProjectLogBytes: 25 * 1024 * 1024,
  maxAllProjectsBytes: 100 * 1024 * 1024,
  corsOrigins: ["http://localhost:5173"],
  sourcemaps: { enabled: false },
});

await server.start();
```
