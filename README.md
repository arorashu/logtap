# LogTap

[![CI](https://github.com/arorashu/logtap/actions/workflows/ci.yml/badge.svg)](https://github.com/arorashu/logtap/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

LogTap is a local-first browser logging harness for frontend development. It captures client-side errors, warnings, failed network requests, and manual breadcrumbs, then writes bounded JSONL logs and compact summaries under `.agent/logtap`.

It is designed for developers and coding agents debugging UI projects without setting up a hosted observability stack.

## What LogTap Captures

- `console.warn` and `console.error`
- uncaught browser errors
- unhandled promise rejections
- failed `fetch` calls and non-2xx/3xx responses
- manual warnings, errors, and breadcrumbs
- source-map enriched stack frames when artifacts are registered
- observed vs stored duplicate counts for noisy error loops

## What It Is Not

- Not a production observability platform
- No hosted service
- No dashboard
- No database
- No request or response body capture by default

## Status

LogTap is in early OSS release shape. GitHub installation works today. npm package publication is planned, but the package is not assumed to be published yet.

The browser SDK can be bundled by Vite, Next.js, webpack and similar tools. The `logtap` CLI currently uses Bun as its runtime.

## Install

With Bun, install from GitHub:

```bash
bun add github:arorashu/logtap
```

With npm, GitHub installation is possible if Bun is available on `PATH`, because Git installs run the package `prepare` build:

```bash
npm install github:arorashu/logtap
```

After npm publication, the package will install as:

```bash
npm install @arorashu/logtap
```

For local development against a checkout, use a path dependency such as:

```bash
bun add ../logtap
```

## Start The Sidecar

Add a script to the UI project's `package.json`:

```json
{
  "scripts": {
    "logtap": "logtap"
  }
}
```

Start LogTap from the UI project root:

```bash
bun run logtap start --port 4319 --root .agent/logtap
```

npm users can run the same script as:

```bash
npm run logtap -- start --port 4319 --root .agent/logtap
```

Enable source-map support by pointing LogTap at a build output directory:

```bash
bun run logtap start --port 4319 --root .agent/logtap --dist ./dist --sourcemaps
```

## Add The Browser SDK

Vite example:

```ts
// src/logtap.ts
import { createBrowserTap } from "@arorashu/logtap/browser";

export const logtap = createBrowserTap({
  endpoint: "http://localhost:4319/__logtap/ingest",
  app: "my-app",
  env: import.meta.env.MODE,
  buildSha: import.meta.env.VITE_BUILD_SHA,
  getRoute: () => location.pathname,
  enabled: import.meta.env.DEV,
});
```

Import it once near the app entry point:

```ts
// src/main.tsx
import "./logtap";
```

client-side

```ts
"use client";

import { createBrowserTap } from "@arorashu/logtap/browser";

export const logtap = createBrowserTap({
  endpoint: "http://localhost:4319/__logtap/ingest",
  app: "my-next-app",
  env: process.env.NODE_ENV,
  buildSha: process.env.NEXT_PUBLIC_BUILD_SHA,
  getRoute: () => location.pathname,
  enabled: process.env.NODE_ENV === "development",
});
```

## Manual Events

```ts
logtap.breadcrumb("checkout.submit.clicked", { plan: "pro" });
```

```ts
try {
  await submitCheckout();
} catch (err) {
  logtap.error("checkout.submit.failed", err, { plan: "pro" });
  throw err;
}
```

## Read Logs

The examples below use Bun. If you use npm scripts, replace `bun run logtap` with `npm run logtap --`.

```bash
# last 200 events for a project
bun run logtap tail --project my-app.development

# only errors
bun run logtap tail --project my-app.development --level error

# summary for the last 15 minutes
bun run logtap summary --project my-app.development --since 15m

# summary as JSON
bun run logtap summary --project my-app.development --json
```

HTTP endpoints:

```text
GET  /__logtap/healthz
POST /__logtap/ingest
GET  /__logtap/tail?project=my-app.development&n=200
GET  /__logtap/query?project=my-app.development&level=error&since=15m
GET  /__logtap/summary?project=my-app.development&since=15m
GET  /__logtap/summary.md?project=my-app.development&since=15m
GET  /__logtap/projects
POST /__logtap/clear?project=my-app.development
```

## Storage Layout

Logs are organized by project ID under the configured root:

```text
.agent/logtap/
  projects/
    my-app.development/
      logs/client.jsonl
      summaries/latest.md
      summaries/latest.json
      artifacts/<build-sha>/
```

Project ID resolution order:

1. `event.projectId` if provided
2. `${event.app}.${event.env}` if both are provided
3. `${event.app}.dev` if only `app` is provided
4. `default.dev`

## Dedupe And Retention

LogTap protects both the browser and the local sidecar from noisy loops while preserving counts.

Client-side dedupe is enabled by default:

- first occurrence is sent immediately
- repeated events inside the 60-second window are counted locally
- compact rollup events report observed, stored, and suppressed counts
- up to 500 fingerprints are tracked on the client

Server-side dedupe is also enabled:

- first occurrence of each fingerprint is stored
- milestone counts are stored at 1, 10, 100, 1000, and 10000
- minimum store intervals are 10s for errors, 60s for warnings, and 30s for network events
- suppressed duplicates are summarized in rollup events

Default retention limits:

- per project: 25 MB, 25,000 events, or 24 hours
- global: 100 MB across all projects
- strategy: truncate oldest entries when a limit is exceeded

Set browser-side limits in `createBrowserTap`. These control batching, sampling, breadcrumbs, and client dedupe before events leave the page:

```ts
createBrowserTap({
  endpoint: "http://localhost:4319/__logtap/ingest",
  app: "my-app",
  maxBatchSize: 20,
  maxBreadcrumbs: 50,
  flushIntervalMs: 1000,
  clientDedupeWindowMs: 60_000,
  clientRollupIntervalMs: 1000,
  sample: {
    warn: 1,
    error: 1,
    networkError: 1,
  },
});
```

Set server-side limits on the sidecar. These control accepted payload size and stored log retention:

```bash
bun run logtap start \
  --root .agent/logtap \
  --max-project-size 25MB \
  --max-total-size 100MB
```

```ts
createLogTapServer({
  rootDir: ".agent/logtap",
  maxProjectLogBytes: 25 * 1024 * 1024,
  maxProjectEvents: 25_000,
  maxEventAgeMs: 24 * 60 * 60 * 1000,
  maxAllProjectsBytes: 100 * 1024 * 1024,
  maxEventBytes: 64 * 1024,
  maxBatchBytes: 256 * 1024,
});
```

## Security And Redaction

Before storage, LogTap recursively redacts sensitive fields:

```text
authorization, cookie, set-cookie, password, token, secret, apiKey
```

Sensitive URL query parameters are redacted too:

```text
token, secret, key, password, code, auth, session
```

Add custom redacted fields on the server:

```ts
import { createLogTapServer } from "@arorashu/logtap/server";

createLogTapServer({
  redactFields: ["mySecretField"],
});
```

Enable ingest auth when exposing the sidecar beyond local development:

```ts
createLogTapServer({
  ingestToken: "your-secret-token",
});
```

Clients must send `Authorization: Bearer your-secret-token` when token auth is enabled.

## Source Maps

Register build artifacts for mapped stack traces:

```bash
bun run logtap artifacts add ./dist \
  --project my-app.development \
  --build-sha "$GIT_SHA"
```

Artifacts are stored at:

```text
.agent/logtap/projects/<project-id>/artifacts/<build-sha>/assets/
```

`@jridgewell/trace-mapping` is an optional dependency. If it is unavailable, source-map enrichment is skipped and events are still ingested with `sourceMapStatus` set accordingly.

## Programmatic Server API

```ts
import { createLogTapServer } from "@arorashu/logtap/server";

const server = createLogTapServer({
  port: 4319,
  rootDir: ".agent/logtap",
  corsOrigins: ["http://localhost:5173"],
  sourcemaps: { enabled: false },
});

await server.start();
```

## Documentation

- [docs/spec.md](docs/spec.md): v0 product and implementation spec
- [docs/future-plans](docs/future-plans): planned experiments and non-v0 ideas
- [examples](examples): framework-specific browser setup snippets
- [llms.txt](llms.txt): compact guide for coding agents using LogTap output

## Development

```bash
bun install
bun test
bun run test
bun run typecheck
bun run build
```

CI runs the same test, typecheck, and build commands on pushes and pull requests.
