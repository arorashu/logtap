# LogTap — Codex Implementation Spec

## Purpose

Build **LogTap**, a reusable, minimal-resource client-side logging harness for web development. It captures browser/client errors and warnings, ships them over HTTP to a tiny local sidecar, stores them in bounded per-project JSONL files, and exposes agent-readable summaries.

This is not a full observability platform. It is a small development component optimized for coding agents debugging frontend behavior.

## Non-goals

* Do not build a dashboard.
* Do not require Sentry, Fluent Bit, Vector, Loki, ClickHouse, Postgres, Redis, or Docker.
* Do not implement production-grade auth.
* Do not capture full request or response bodies by default.
* Do not block the host app if logging fails.
* Do not make source-map support mandatory for v0.
* Do not implement log rotation in v0. Use one bounded file per project.

## Primary use case

A developer runs a frontend app locally, on a shared VM, or in a preview environment. Browser logs are sent to LogTap. A coding agent reads the project summary and JSONL log before attempting frontend fixes.

Example flow:

```txt
Browser / client
  -> POST /__logtap/ingest
  -> LogTap sidecar
  -> .agent/logtap/projects/<project-id>/logs/client.jsonl
  -> .agent/logtap/projects/<project-id>/summaries/latest.md
  -> coding agent reads files and fixes issue
```

## Resource constraints

Target runtime environment:

```txt
CPU: 2 vCPU
RAM: 2 GB total VM memory
Disk: 2 GB available
```

LogTap target footprint:

```txt
Idle RAM: 20–60 MB preferred
Disk usage: hard capped, default 100 MB globally
CPU: near-zero idle
Database: none
Runtime server deps: none for core
```

## Language and runtime

Use **TypeScript**.

Core logic must be runtime-agnostic.

Preferred server runtime:

```txt
Bun + Bun.serve
```

Fallback server runtime:

```txt
Node.js built-in node:http
```

Rules:

* No Express.
* No database.
* No mandatory runtime dependencies for core ingest/storage/summary.
* Keep code portable enough that the same store, summary, redaction, fingerprinting, and source-map modules can be used from both Bun and Node adapters.

Browser runtime:

```txt
Plain TypeScript browser SDK
No framework dependency in core browser package
```

Optional dependency for source maps:

```txt
@jridgewell/trace-mapping
```

This must be optional and isolated behind a module boundary.

## Naming

Product name:

```txt
LogTap
```

Package:

```txt
@your-scope/logtap
```

CLI:

```bash
logtap start
logtap summary
logtap clear
logtap artifacts add
```

HTTP base path:

```txt
/__logtap
```

## Package shape

Start with one package. Avoid a monorepo unless the implementation becomes cumbersome.

Recommended layout:

```txt
logtap/
  package.json
  tsconfig.json
  src/
    browser/
      index.ts
      console.ts
      errors.ts
      network.ts
      breadcrumbs.ts
      transport.ts
    server/
      index.ts
      bun.ts
      node.ts
      ingest.ts
      store.ts
      tail.ts
      query.ts
      summary.ts
      redact.ts
      sourcemaps.ts
      artifacts.ts
      dedupe.ts
    shared/
      types.ts
      schema.ts
      normalize.ts
      fingerprint.ts
      time.ts
      bytes.ts
  bin/
    logtap.ts
  examples/
    vite-react/
    nextjs/
  AGENTS.md
  README.md
```

Exports:

```ts
import { createBrowserTap } from "@your-scope/logtap/browser";
import { createLogTapServer } from "@your-scope/logtap/server";
```

Optional future exports:

```ts
import { LogTapErrorBoundary } from "@your-scope/logtap/react";
import { attachPlaywrightLogging } from "@your-scope/logtap/playwright";
```

## Core event schema

Create a stable shared type:

```ts
export type LogTapLevel = "debug" | "info" | "warn" | "error";

export type LogTapKind =
  | "console"
  | "exception"
  | "unhandledrejection"
  | "network"
  | "breadcrumb"
  | "manual"
  | "rollup";

export type LogTapBreadcrumb = {
  ts: string;
  name: string;
  data?: Record<string, unknown>;
};

export type LogTapNetwork = {
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  requestId?: string;
};

export type SourceMapStatus =
  | "not_needed"
  | "mapped"
  | "missing"
  | "failed";

export type LogTapEvent = {
  ts: string;
  level: LogTapLevel;
  kind: LogTapKind;

  app?: string;
  env?: string;
  projectId?: string;
  sessionId?: string;
  userId?: string;
  buildSha?: string;
  release?: string;

  url?: string;
  route?: string;

  message: string;
  stack?: string;
  stackMapped?: string;
  sourceMapStatus?: SourceMapStatus;

  fingerprint?: string;

  data?: Record<string, unknown>;
  network?: LogTapNetwork;
  breadcrumbs?: LogTapBreadcrumb[];
};
```

Rules:

* Always keep `stack` if available.
* Never discard raw event data because enrichment failed.
* `stackMapped` is optional.
* `sourceMapStatus` must explain source-map enrichment outcome when sourcemaps are enabled.
* `projectId` may be provided by the client. If missing, infer it from `app` and `env`.

## Project identity

LogTap stores logs by project.

Project ID resolution:

```txt
1. event.projectId if provided
2. `${event.app}.${event.env}` if app and env exist
3. `${event.app}.dev` if only app exists
4. default.dev
```

Project IDs must be sanitized for filesystem safety:

```txt
Allowed: letters, numbers, dot, underscore, dash
Everything else: replace with underscore
Max length: 128 chars
```

## Filesystem layout

Root directory defaults to:

```txt
.agent/logtap
```

Per-project layout:

```txt
.agent/logtap/
  projects/
    <project-id>/
      config.json
      logs/
        client.jsonl
      summaries/
        latest.md
        latest.json
      artifacts/
        <build-sha-or-release>/
          manifest.json
          assets/
            app.abc123.js
            app.abc123.js.map
```

Example:

```txt
.agent/logtap/
  projects/
    billing-ui.dev/
      logs/client.jsonl
      summaries/latest.md
      summaries/latest.json
      artifacts/a82f91/
    admin-console.preview/
      logs/client.jsonl
      summaries/latest.md
      summaries/latest.json
      artifacts/f19c44/
```

## Storage and retention

Use JSONL files only.

For v0, each project gets exactly one bounded log file:

```txt
.agent/logtap/projects/<project-id>/logs/client.jsonl
```

No rotation in v0.

Default retention:

```ts
{
  maxProjectLogBytes: 25 * 1024 * 1024,
  maxProjectEvents: 25_000,
  maxEventAgeMs: 24 * 60 * 60 * 1000,
  maxAllProjectsBytes: 100 * 1024 * 1024,
  strategy: "truncate_oldest"
}
```

Rules:

* One event per line.
* Append to the project’s `client.jsonl`.
* When any project limit is exceeded, truncate oldest entries from that project file.
* When global size is exceeded, truncate least-recently-used project logs first.
* Do not delete artifacts unless explicitly implementing a separate artifact retention policy.
* Writes should be safe under normal single-process use.
* Do not guarantee multiprocess correctness in v0.

Truncation behavior:

```txt
Read lines -> keep newest lines satisfying max bytes, max events, and max age -> rewrite file atomically if practical.
```

Prefer simple correctness over clever incremental compaction.

## Dedupe, rate-limit, and sampling

Dedupe/rate-limit is required in v0. Random sampling is optional and should be conservative.

Pipeline:

```txt
ingest
  -> normalize
  -> redact
  -> fingerprint
  -> dedupe/rate-limit
  -> sample
  -> store
  -> summary
```

### Fingerprint

Every event gets a stable fingerprint.

```ts
function fingerprint(e: LogTapEvent): string {
  return [
    e.kind,
    e.level,
    normalizeMessage(e.message),
    topStackFrame(e.stackMapped ?? e.stack),
    e.route ?? "",
    e.network?.method ?? "",
    normalizeUrl(e.network?.url ?? ""),
    e.network?.status ?? "",
  ].join("|");
}
```

Message normalization:

```ts
function normalizeMessage(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hash>")
    .replace(/\b\d+\b/g, "<num>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/uuid[:= ][0-9a-f-]{20,}/gi, "uuid=<uuid>");
}
```

URL normalization should remove sensitive query params and normalize obvious IDs.

### Server-side dedupe bucket

Maintain in-memory buckets per project and fingerprint.

```ts
type DedupeBucket = {
  fingerprint: string;
  firstSeen: number;
  lastSeen: number;
  observedCount: number;
  storedCount: number;
  suppressedCount: number;
  lastStoredAt: number;
  exemplar: LogTapEvent;
};
```

Default config:

```ts
dedupe: {
  enabled: true,
  maxBuckets: 5000,
  storeFirstOccurrence: true,
  storeAtCounts: [1, 10, 100, 1000, 10000],
  perFingerprintMinIntervalMs: {
    error: 10_000,
    warn: 60_000,
    network: 30_000,
    default: 60_000,
  },
  rollupIntervalMs: 60_000,
}
```

Store logic:

* Always store the first occurrence of a fingerprint.
* Store again when `observedCount` reaches one of `storeAtCounts`.
* Store again if enough time has passed according to `perFingerprintMinIntervalMs`.
* Otherwise suppress storage and increment suppressed count.

### Rollup events

Periodically emit compact rollup events for suppressed duplicates.

Example:

```json
{
  "ts": "2026-05-01T20:10:00Z",
  "level": "warn",
  "kind": "rollup",
  "message": "dedupe_rollup",
  "fingerprint": "console|warn|ResizeObserver loop|...",
  "data": {
    "observedCount": 485,
    "storedCount": 3,
    "suppressedCount": 482,
    "firstSeen": "2026-05-01T20:00:01Z",
    "lastSeen": "2026-05-01T20:10:44Z",
    "exemplarMessage": "ResizeObserver loop limit exceeded"
  }
}
```

Summary must include observed, stored, and suppressed counts.

### Sampling

Default sampling:

```ts
sampling: {
  debug: 0,
  info: 0,
  warn: 1,
  error: 1,
  networkError: 1,
  repeatedWarn: 0,
  breadcrumbStandalone: 0,
}
```

Rules:

* Do not randomly sample uncaught exceptions.
* Do not randomly sample unhandled rejections.
* Do not randomly sample first occurrence of any fingerprint.
* Prefer deterministic dedupe/rate-limit over random sampling.

## Browser SDK

### API

Implement:

```ts
type BrowserTapOptions = {
  endpoint: string;
  app?: string;
  env?: string;
  projectId?: string;
  sessionId?: string;
  userId?: string;
  buildSha?: string;
  release?: string;
  getRoute?: () => string | undefined;
  enabled?: boolean;

  captureConsole?: boolean;
  captureErrors?: boolean;
  captureNetwork?: boolean;
  captureBreadcrumbs?: boolean;

  sample?: Partial<Record<LogTapLevel | "networkError", number>>;
  maxBreadcrumbs?: number;
  flushIntervalMs?: number;
  maxBatchSize?: number;
};

export function createBrowserTap(options: BrowserTapOptions): BrowserTap;
```

BrowserTap:

```ts
type BrowserTap = {
  breadcrumb(name: string, data?: Record<string, unknown>): void;
  error(message: string, error?: unknown, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  flush(): Promise<void>;
  stop(): void;
};
```

### Defaults

```ts
{
  enabled: true,
  captureConsole: true,
  captureErrors: true,
  captureNetwork: true,
  captureBreadcrumbs: true,
  maxBreadcrumbs: 50,
  flushIntervalMs: 1000,
  maxBatchSize: 20,
  sample: {
    debug: 0,
    info: 0,
    warn: 1,
    error: 1,
    networkError: 1,
  },
}
```

### Console capture

Patch:

```txt
console.warn
console.error
```

Do not capture `console.log` by default.

Must call original console method.

Avoid recursive capture if LogTap itself logs.

### Error capture

Capture:

```txt
window.addEventListener("error", ...)
window.addEventListener("unhandledrejection", ...)
```

For errors, include:

```txt
message
stack
filename
lineno
colno
url
route
breadcrumbs
app/env/projectId/buildSha/release/sessionId
```

### Network capture

Wrap `window.fetch` if enabled.

Capture only failed requests by default:

```txt
status >= 400
network exception
```

Do not capture request body or response body by default.

Capture:

```txt
method
url with sensitive query params redacted
status
durationMs
route
```

### Breadcrumbs

Maintain in-memory ring buffer of recent breadcrumbs.

Automatic breadcrumbs:

```txt
route change if detectable by history.pushState/replaceState/popstate
manual breadcrumbs via tap.breadcrumb()
```

Do not overbuild router integration. `getRoute` is enough for v0.

Do not store every breadcrumb as a standalone event by default. Attach recent breadcrumbs to warnings/errors/network failures.

### Client-side dedupe

Client-side dedupe is optional but recommended to reduce network spam.

Keep it simple:

```txt
max fingerprints tracked: 500
dedupe window: 60s
```

The server remains authoritative for dedupe and retention.

### Transport

Implement a batching transport.

Send format:

```json
{
  "events": []
}
```

Use `navigator.sendBeacon` when available and payload is small enough. Fallback to `fetch` with `keepalive: true` where appropriate.

Transport must fail silently.

## Server

### API

Implement:

```ts
type LogTapServerOptions = {
  port?: number;
  host?: string;
  basePath?: string;
  rootDir?: string;

  maxProjectLogBytes?: number;
  maxProjectEvents?: number;
  maxEventAgeMs?: number;
  maxAllProjectsBytes?: number;
  maxEventBytes?: number;
  maxBatchBytes?: number;

  corsOrigins?: string[];
  ingestToken?: string;
  redactFields?: string[];
  ignoreMessages?: RegExp[];

  dedupe?: DedupeOptions;
  sampling?: SamplingOptions;
  sourcemaps?: SourceMapOptions;
  summaryProviders?: SummaryProvider[];
};

export function createLogTapServer(options?: LogTapServerOptions): LogTapServer;
```

Defaults:

```ts
{
  port: 4319,
  host: "127.0.0.1",
  basePath: "/__logtap",
  rootDir: ".agent/logtap",
  maxProjectLogBytes: 25 * 1024 * 1024,
  maxProjectEvents: 25_000,
  maxEventAgeMs: 24 * 60 * 60 * 1000,
  maxAllProjectsBytes: 100 * 1024 * 1024,
  maxEventBytes: 64 * 1024,
  maxBatchBytes: 256 * 1024,
  redactFields: [
    "authorization",
    "cookie",
    "set-cookie",
    "password",
    "token",
    "secret",
    "apiKey",
    "apikey"
  ]
}
```

### Endpoints

Base path defaults to `/__logtap`.

Required:

```txt
POST /__logtap/ingest
GET  /__logtap/tail?project=<project-id>&n=200
GET  /__logtap/query?project=<project-id>&level=error&since=15m
GET  /__logtap/summary?project=<project-id>&since=15m
GET  /__logtap/summary.md?project=<project-id>&since=15m
POST /__logtap/clear?project=<project-id>
GET  /__logtap/healthz
```

Optional later:

```txt
GET /__logtap/projects
GET /__logtap/export/jsonl?project=<project-id>
```

If `project` is omitted for read endpoints, use `default.dev` or the most recently active project. Prefer explicit project in docs.

### Ingest behavior

`POST /ingest` accepts:

```ts
{ events: LogTapEvent[] }
```

Also accept a single event for convenience:

```ts
LogTapEvent
```

Validation:

* Reject payloads larger than `maxBatchBytes`.
* Reject or truncate events larger than `maxEventBytes`.
* Require `level`, `kind`, and `message`.
* Add server receive timestamp if missing.
* Resolve project ID.
* Redact before storing.
* Apply ignore rules before storing.
* Compute fingerprint.
* If sourcemaps are enabled, attempt enrichment before final dedupe/storage.
* Apply dedupe/rate-limit.
* Store only if policy says to store.

Return:

```txt
204 No Content
```

On invalid payload:

```txt
400 Bad Request
```

On unauthorized token:

```txt
401 Unauthorized
```

### Tail endpoint

`GET /tail?project=<project-id>&n=200` returns the last N events as JSON:

```json
{
  "projectId": "billing-ui.dev",
  "events": []
}
```

Default N: 200.

Hard max N: 1000.

### Query endpoint

Support minimal filters:

```txt
project
level
kind
since
route
fingerprint
```

Examples:

```txt
GET /__logtap/query?project=billing-ui.dev&level=error&since=15m
GET /__logtap/query?project=billing-ui.dev&kind=network&since=1h
```

Keep implementation simple: read recent JSONL lines and filter in memory.

### Summary endpoint

The summary is deterministic aggregation, not LLM-generated.

`GET /summary?project=<project-id>&since=15m` returns JSON.

`GET /summary.md?project=<project-id>&since=15m` returns markdown and writes the same markdown to:

```txt
.agent/logtap/projects/<project-id>/summaries/latest.md
```

JSON summary should also be written to:

```txt
.agent/logtap/projects/<project-id>/summaries/latest.json
```

Summary should include:

```txt
projectId
window
start time
end time
total stored events considered
estimated observed events
errors stored count
errors observed count
warnings stored count
warnings observed count
network failures stored count
network failures observed count
suppressed duplicate count
top grouped errors
recent breadcrumbs
recent failed network requests
source-map status counts
log file bytes
retention policy
whether truncation likely occurred
```

Top errors should include:

```txt
message
fingerprint
storedCount
observedCount
suppressedCount
firstSeen
lastSeen
route
stackTop
sourceMapStatus
```

Markdown output should be concise and optimized for agents.

Example:

```md
# LogTap Client Summary

Project: billing-ui.dev
Window: last 15 minutes
Stored events considered: 184
Observed events estimated: 666
Suppressed duplicates: 482
Errors: 3 stored / 12 observed
Warnings: 17 stored / 502 observed
Network failures: 2 stored / 2 observed

## Top errors

1. Cannot read properties of undefined (reading 'id')
   Observed: 9
   Stored: 2
   Suppressed: 7
   Route: /checkout
   Stack: src/components/PlanCard.tsx:44

## Recent breadcrumbs

- route_change /pricing -> /checkout
- clicked_checkout_button
- selected_plan pro
- submit_checkout_form

## Network failures

- POST /api/checkout -> 500, observed 2 times
```

### SummaryProvider extension

Implement an extension point, but do not require any custom provider.

```ts
export type SummarySection = {
  title: string;
  items: Array<Record<string, unknown>>;
};

export type SummaryProvider = {
  name: string;
  summarize(events: LogTapEvent[]): SummarySection | undefined;
};
```

Built-in providers:

```txt
ErrorsSummaryProvider
NetworkSummaryProvider
ConsoleWarningsSummaryProvider
BreadcrumbSummaryProvider
SourceMapStatusSummaryProvider
RetentionSummaryProvider
```

## Redaction

Before writing events, recursively redact fields whose key matches configured sensitive names.

Default sensitive keys:

```txt
authorization
cookie
set-cookie
password
token
secret
apiKey
apikey
```

Replacement value:

```txt
[REDACTED]
```

Also redact common sensitive query parameters in URLs:

```txt
token
secret
key
password
code
auth
session
```

## Source maps

Source-map support is optional, but the schema and artifact layout must support it from v0.

LogTap does not obtain source maps from the browser at runtime. The client sends build identity and raw stack traces. The server maps stack frames using local build artifacts.

### Options

```ts
type SourceMapOptions = {
  enabled: boolean;
  artifactDir?: string;
  releaseField?: "buildSha" | "release";
  stripPrefixes?: string[];
  watchDirs?: string[];
};
```

Defaults:

```ts
{
  enabled: false,
  artifactDir: "artifacts",
  releaseField: "buildSha",
  stripPrefixes: [],
  watchDirs: []
}
```

`artifactDir` is relative to the project directory unless absolute.

### Artifact layout

```txt
.agent/logtap/projects/<project-id>/artifacts/<buildSha-or-release>/
  manifest.json
  assets/
    main.a82f91.js
    main.a82f91.js.map
```

### Artifact registration

Canonical command:

```bash
logtap artifacts add ./dist --project billing-ui.dev --build-sha "$GIT_SHA"
```

Expected behavior:

* Copy JS and map files from dist into the project artifact directory.
* Preserve relative paths where practical.
* Do not copy large unrelated assets.
* Generate a LogTap artifact manifest.
* Ingest Vite manifest if present.

Artifact manifest example:

```json
{
  "buildSha": "abc123",
  "assets": {
    "assets/app.abc123.js": {
      "file": "assets/app.abc123.js",
      "map": "assets/app.abc123.js.map"
    }
  }
}
```

### Watch-dir convenience

Support or stub:

```bash
logtap start --dist ./dist --sourcemaps
```

Meaning:

```txt
- watch ./dist
- index JS/map files
- use sourceMappingURL inference
- associate with current buildSha if configured or infer best effort
```

### Source-map resolution order

When an event has a stack:

```txt
1. Registered artifacts by buildSha/release
2. Watched artifact directories
3. sourceMappingURL inference inside known artifact/watch directories
```

Resolution steps:

1. Parse generated stack frames.
2. Identify generated asset filename, line, and column.
3. Locate matching `.map` file.
4. Map generated line/column to original source position.
5. Set `stackMapped` if mapping succeeds.
6. Set `sourceMapStatus` to one of:

   * `mapped`
   * `missing`
   * `failed`
   * `not_needed`

Never fail ingestion if mapping fails.

## CLI

Implement a CLI named `logtap`.

Commands:

```bash
logtap start --port 4319 --root .agent/logtap --max-project-size 25mb --max-total-size 100mb
```

```bash
logtap start --dist ./dist --sourcemaps
```

```bash
logtap tail --project billing-ui.dev --level error
```

```bash
logtap summary --project billing-ui.dev --since 15m
```

```bash
logtap clear --project billing-ui.dev
```

```bash
logtap artifacts add ./dist --project billing-ui.dev --build-sha abc123
```

Minimum v0 commands:

```txt
start
summary
clear
artifacts add may be stubbed or implemented
```

## AGENTS.md

Create an `AGENTS.md` with this content:

```md
# LogTap Agent Instructions

When debugging frontend issues, inspect LogTap output before changing code.

Find the relevant project under:

.agent/logtap/projects/<project-id>/

Read these files first:

- summaries/latest.md
- logs/client.jsonl

Use the summary to identify:

- top client errors
- repeated warnings
- failed network requests
- recent breadcrumbs before failure
- mapped source file/line if available
- observed vs stored event counts
- suppressed duplicate counts

Prefer fixing root causes over suppressing warnings.

Do not remove logging, retention, dedupe, rate-limit, or redaction safeguards unless explicitly asked.

If source-map mapping failed, inspect the raw stack and verify artifact configuration.
```

## README requirements

README must include:

* What LogTap is
* What it is not
* Quickstart for Vite/React
* Quickstart for generic browser app
* How to start the Bun server
* How to use Node fallback if implemented
* How to read tail and summary
* Project organization
* Retention policy
* Dedupe/rate-limit behavior
* Resource footprint goals
* Security/redaction notes
* Source-map artifact notes
* Example Codex/agent workflow

## Example usage

### Server

```ts
import { createLogTapServer } from "@your-scope/logtap/server";

const server = createLogTapServer({
  port: 4319,
  rootDir: ".agent/logtap",
  maxProjectLogBytes: 25 * 1024 * 1024,
  maxAllProjectsBytes: 100 * 1024 * 1024,
  sourcemaps: {
    enabled: false,
  },
});

await server.start();
```

### Browser

```ts
import { createBrowserTap } from "@your-scope/logtap/browser";

export const logtap = createBrowserTap({
  endpoint: "http://localhost:4319/__logtap/ingest",
  app: "billing-ui",
  env: import.meta.env.MODE,
  projectId: "billing-ui.dev",
  buildSha: import.meta.env.VITE_BUILD_SHA,
  getRoute: () => location.pathname,
  enabled: import.meta.env.DEV,
});
```

Manual breadcrumb:

```ts
logtap.breadcrumb("checkout.submit.clicked", {
  plan: "pro",
});
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

## Testing requirements

Use Vitest.

Required tests:

### Shared

* message normalization
* URL normalization
* fingerprint stability
* project ID resolution and sanitization
* redaction of nested objects
* URL query redaction
* byte parsing helpers

### Browser

* console.warn/error capture calls original console
* window error event produces event
* unhandled rejection produces event
* fetch wrapper captures 500 response
* fetch wrapper captures thrown network error
* breadcrumbs ring buffer caps length
* disabled tap sends nothing
* standalone breadcrumbs are not sent by default

### Server

* ingest writes JSONL under correct project
* missing project resolves to default.dev
* oversized payload rejected
* tail returns last N events for project
* query filters by level/kind/since/route/fingerprint
* summary groups repeated errors
* summary includes observed, stored, and suppressed counts
* summary markdown is written to project summary path
* summary JSON is written to project summary path
* single-file retention caps project bytes
* retention caps project event count
* retention drops events older than max age
* global retention caps all project log bytes
* clear removes logs and summaries for project
* unauthorized token rejected when token is configured

### Dedupe/rate-limit

* first occurrence is stored
* repeated event within interval is suppressed
* repeated event at count threshold is stored
* rollup event includes suppressed count
* summary reflects rollup counts

### Source maps

* disabled sourcemaps do nothing
* missing sourcemap sets status `missing`
* failed parse sets status `failed`
* successful mapping sets `stackMapped` and status `mapped`
* registered artifacts are preferred over watch-dir artifacts

Source-map tests may be skipped until optional dependency is wired, but stubs should exist.

## Acceptance criteria

v0 is complete when:

* `logtap start` launches a local HTTP server on port 4319, preferably using Bun.
* Node fallback exists or is clearly deferred.
* Browser SDK can send console errors, window errors, unhandled rejections, failed fetches, manual breadcrumbs, and manual errors.
* Events are written as JSONL to `.agent/logtap/projects/<project-id>/logs/client.jsonl`.
* Project ID resolution works.
* Per-project and global disk usage are bounded by config.
* No rotated log files are used in v0.
* Dedupe/rate-limit stores first occurrence, suppresses repeats, and emits rollups.
* `/__logtap/tail` returns recent events for a project.
* `/__logtap/summary` returns JSON summary for a project.
* `/__logtap/summary.md` returns markdown and writes project `summaries/latest.md`.
* Summary includes observed vs stored vs suppressed counts.
* No database is required.
* No runtime server dependency is required for core.
* Source-map fields exist in the schema.
* Source-map implementation is either working behind an optional module or clearly stubbed without breaking ingestion.
* README and AGENTS.md exist.

## Implementation phases

### Phase 1 — Core server and project-scoped storage

* Types
* Project ID resolution
* Redaction
* JSONL append store
* Single-file retention by bytes/events/age
* Global retention cap
* Bun server adapter
* `/healthz`, `/ingest`, `/tail`, `/clear`

### Phase 2 — Browser SDK

* Transport
* Console capture
* Error capture
* Unhandled rejection capture
* Fetch failure capture
* Breadcrumbs

### Phase 3 — Dedupe and rate-limit

* Fingerprinting
* In-memory dedupe buckets
* Store thresholds
* Per-fingerprint min intervals
* Rollup events

### Phase 4 — Summary

* Query recent events
* Group/fingerprint errors
* Network failure summary
* Breadcrumb summary
* Retention summary
* Observed/stored/suppressed counts
* JSON summary endpoint/file
* Markdown summary endpoint/file

### Phase 5 — CLI and docs

* `logtap start`
* `logtap summary`
* `logtap clear`
* README
* AGENTS.md
* Vite example

### Phase 6 — Optional source maps

* Artifact layout
* Artifact add command
* Dist watch option
* Stack frame parser
* `@jridgewell/trace-mapping` integration
* Mapped stack output

## Design constraints for Codex

* Keep code boring and inspectable.
* Avoid dependency creep.
* Prefer small pure functions.
* Avoid clever async abstractions.
* Do not introduce a database.
* Do not add a UI.
* Do not add log rotation in v0.
* Keep all files agent-readable.
* Keep raw logs even if enrichment fails.
* Never let logging failure break the host app.
* Make dedupe honest: summaries must show observed vs stored vs suppressed events.

