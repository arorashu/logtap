# Future Plan: Chrome DevTools Protocol Adapter

Status: future exploration, not v0 scope.

## Context

The browser SDK runs inside the page JavaScript realm. It captures page-level
signals such as patched `console.warn` / `console.error`, `window.error`,
`window.unhandledrejection`, wrapped `fetch` failures, manual events, and
breadcrumbs.

Some Chrome diagnostics never pass through those page APIs. Chrome can report
messages directly to DevTools from the renderer or browser process, including:

- `postMessage` security diagnostics
- autofocus/browser intervention warnings
- deprecation and intervention messages
- iframe, worker, or cross-origin diagnostics
- failed non-fetch resources visible in the Network panel
- CORS, mixed-content, certificate, and browser security issues

LogTap being silent for those classes does not mean the SDK is broken. It means
those diagnostics are outside the browser SDK capture surface.

## Product Shape

Do not build a general CDP query tool. Agents that already have live CDP access
can query Chrome directly for deep inspection.

The useful LogTap layer is an optional CDP ingest adapter:

```bash
logtap start \
  --root .agent/logtap \
  --port 4319 \
  --cdp http://127.0.0.1:9222 \
  --project my-ui.dev
```

The adapter would listen to selected Chrome DevTools Protocol streams, normalize
events into the LogTap event schema, redact sensitive data, dedupe repeated
diagnostics, retain bounded JSONL history, and produce agent-readable summaries.

CDP is the live microscope. LogTap is the lab notebook.

## Value Over Direct CDP

- Persistent history after refreshes, tab closes, crashes, or previous agent
  runs.
- Cross-session continuity for "what has been going wrong recently?"
- Count-preserving dedupe for noisy renderer/browser diagnostics.
- Stable project-scoped files under `.agent/logtap/projects/<project-id>/`.
- One normalized schema for browser SDK events, CDP logs, network failures,
  source-map status, breadcrumbs, and manual app events.
- Low-noise defaults for agents: warnings/errors, failed network, browser
  issues, no bodies.
- Agent handoff: one run can capture, another run can inspect summaries later.
- Possible source-map/artifact integration for CDP runtime exceptions.

## Candidate CDP Domains

- `Runtime`: console API calls and thrown exceptions.
- `Log`: browser log entries.
- `Audits`: DevTools issues such as deprecations, CORS, mixed content, and
  browser interventions.
- `Network`: request failures, blocked requests, failed resources, and timing.
- `Page`: lifecycle, frame navigation, and page errors.
- `Target`: iframes, workers, and service workers.
- `Security`: certificate and mixed-content signals.
- `Performance`: optional high-level metrics, not default v0 behavior.

## Default Capture Policy

Default on:

- Runtime exceptions
- console warnings/errors from attached targets
- browser log warnings/errors
- DevTools audit/issues
- failed network requests and blocked resources

Default off:

- request bodies
- response bodies
- all successful network traffic
- screenshots
- full traces
- DOM snapshots
- coverage/profiling data

The adapter should be conservative by default. It should collect enough to make
agent debugging effective without becoming a general browser telemetry dump.

## Event Shape

Likely event kind:

```ts
kind: "devtools"
```

Example:

```json
{
  "ts": "2026-05-03T12:00:00.000Z",
  "level": "warn",
  "kind": "devtools",
  "message": "Autofocus processing was blocked because a document already has a focused element.",
  "projectId": "my-ui.dev",
  "url": "http://localhost:5173/settings",
  "route": "/settings",
  "data": {
    "source": "chrome.log",
    "category": "rendering",
    "frameUrl": "http://localhost:5173/settings"
  }
}
```

Network failures can probably keep `kind: "network"` with a `data.source` such
as `cdp.network`, so existing network summaries continue to work.

## `postMessage` Notes

There are narrower browser-SDK-level options:

- patch `window.postMessage`
- patch `Window.prototype.postMessage`
- patch `MessagePort.prototype.postMessage`
- patch `BroadcastChannel.prototype.postMessage`
- listen to `message` and `messageerror`

These can capture app-level sends and receives, but they do not provide DevTools
parity. They can miss isolated worlds, extensions, browser internals, cross-origin
iframe internals, and renderer-injected diagnostics. They also risk exposing
sensitive message payloads unless redaction and payload limits are strict.

If implemented, app-level `postMessage` capture should be a separate optional
browser SDK feature, not the main answer to DevTools-only diagnostics.

## Open Questions

- Should CDP attachment live in core, or a separate optional package/export?
- How should LogTap choose the right tab/target when multiple tabs are attached?
- How should project identity be inferred from URL, target title, app metadata,
  or explicit CLI flags?
- How should iframes and workers be attributed to routes and projects?
- Should `kind: "devtools"` be added to the stable schema, or should events map
  into existing `console`, `exception`, and `network` kinds with `data.source`?
- What summary sections should be added for browser diagnostics?
- What minimum CDP setup should be documented for local Chrome?

## Non-goals

- Do not replace direct CDP tools used by agents for live inspection.
- Do not capture request or response bodies by default.
- Do not make CDP required for LogTap's browser SDK path.
- Do not build a browser automation framework.
- Do not turn LogTap into a full observability platform.
