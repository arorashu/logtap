import type { ResolvedServerOptions } from "../shared/types.ts";
import { processEvents } from "./ingest.ts";
import { tail } from "./tail.ts";
import { query } from "./query.ts";
import { buildSummary, summaryToMarkdown, writeSummaryFiles } from "./summary.ts";
import { clearProject, listProjectIds } from "./store.ts";
import { DedupeEngine } from "./dedupe.ts";

export function createBunServer(opts: ResolvedServerOptions) {
  const dedupe = new DedupeEngine(opts.dedupe);
  const base = opts.basePath.replace(/\/$/, "");

  // periodic rollup flush
  const rollupInterval = setInterval(() => {
    for (const pid of listProjectIds(opts.rootDir)) {
      const rollups = dedupe.getRollups(pid);
      for (const r of rollups) {
        import("./store.ts").then(({ appendEvent }) => appendEvent(opts.rootDir, pid, r));
      }
    }
  }, opts.dedupe.rollupIntervalMs);
  rollupInterval.unref?.();

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,

    async fetch(req: Request) {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const method = req.method.toUpperCase();

      // CORS preflight
      if (method === "OPTIONS") {
        return corsResponse(new Response(null, { status: 204 }), opts, req);
      }

      // auth
      if (opts.ingestToken) {
        const auth = req.headers.get("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
        if (token !== opts.ingestToken) {
          return corsResponse(new Response("Unauthorized", { status: 401 }), opts, req);
        }
      }

      // healthz
      if (pathname === `${base}/healthz`) {
        return corsResponse(json({ ok: true }), opts, req);
      }

      // ingest
      if (pathname === `${base}/ingest` && method === "POST") {
        const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
        if (contentLength > opts.maxBatchBytes) {
          return corsResponse(new Response("Payload too large", { status: 400 }), opts, req);
        }

        let body: unknown;
        try {
          const text = await req.text();
          if (text.length > opts.maxBatchBytes) {
            return corsResponse(new Response("Payload too large", { status: 400 }), opts, req);
          }
          body = JSON.parse(text);
        } catch {
          return corsResponse(new Response("Invalid JSON", { status: 400 }), opts, req);
        }

        let rawEvents: unknown[];
        if (Array.isArray((body as Record<string, unknown>)?.["events"])) {
          rawEvents = (body as { events: unknown[] }).events;
        } else if (body && typeof body === "object" && !Array.isArray(body)) {
          rawEvents = [body];
        } else {
          return corsResponse(new Response("Invalid payload", { status: 400 }), opts, req);
        }

        // truncate oversized individual events
        rawEvents = rawEvents.filter(e => {
          const size = JSON.stringify(e).length;
          return size <= opts.maxEventBytes;
        });

        await processEvents(rawEvents, opts, dedupe);
        return corsResponse(new Response(null, { status: 204 }), opts, req);
      }

      // tail
      if (pathname === `${base}/tail` && method === "GET") {
        const projectId = url.searchParams.get("project") ?? "default.dev";
        const n = Math.min(parseInt(url.searchParams.get("n") ?? "200", 10), 1000);
        const events = tail(opts.rootDir, projectId, n);
        return corsResponse(json({ projectId, events }), opts, req);
      }

      // query
      if (pathname === `${base}/query` && method === "GET") {
        const projectId = url.searchParams.get("project") ?? "default.dev";
        const events = query(opts.rootDir, {
          project: projectId,
          level: (url.searchParams.get("level") ?? undefined) as never,
          kind: (url.searchParams.get("kind") ?? undefined) as never,
          since: url.searchParams.get("since") ?? undefined,
          route: url.searchParams.get("route") ?? undefined,
          fingerprint: url.searchParams.get("fingerprint") ?? undefined,
        });
        return corsResponse(json({ projectId, events }), opts, req);
      }

      // summary JSON
      if (pathname === `${base}/summary` && method === "GET") {
        const projectId = url.searchParams.get("project") ?? "default.dev";
        const since = url.searchParams.get("since") ?? undefined;
        const retention = {
          maxProjectLogBytes: opts.maxProjectLogBytes,
          maxProjectEvents: opts.maxProjectEvents,
          maxEventAgeMs: opts.maxEventAgeMs,
          maxAllProjectsBytes: opts.maxAllProjectsBytes,
          strategy: "truncate_oldest" as const,
        };
        const summary = buildSummary(opts.rootDir, projectId, since, retention, opts.summaryProviders);
        const md = summaryToMarkdown(summary);
        writeSummaryFiles(opts.rootDir, projectId, summary, md);
        return corsResponse(json(summary), opts, req);
      }

      // summary markdown
      if (pathname === `${base}/summary.md` && method === "GET") {
        const projectId = url.searchParams.get("project") ?? "default.dev";
        const since = url.searchParams.get("since") ?? undefined;
        const retention = {
          maxProjectLogBytes: opts.maxProjectLogBytes,
          maxProjectEvents: opts.maxProjectEvents,
          maxEventAgeMs: opts.maxEventAgeMs,
          maxAllProjectsBytes: opts.maxAllProjectsBytes,
          strategy: "truncate_oldest" as const,
        };
        const summary = buildSummary(opts.rootDir, projectId, since, retention, opts.summaryProviders);
        const md = summaryToMarkdown(summary);
        writeSummaryFiles(opts.rootDir, projectId, summary, md);
        return corsResponse(new Response(md, {
          status: 200,
          headers: { "Content-Type": "text/markdown; charset=utf-8" },
        }), opts, req);
      }

      // clear
      if (pathname === `${base}/clear` && method === "POST") {
        const projectId = url.searchParams.get("project") ?? "default.dev";
        clearProject(opts.rootDir, projectId);
        return corsResponse(new Response(null, { status: 204 }), opts, req);
      }

      // projects list
      if (pathname === `${base}/projects` && method === "GET") {
        const projects = listProjectIds(opts.rootDir);
        return corsResponse(json({ projects }), opts, req);
      }

      return corsResponse(new Response("Not Found", { status: 404 }), opts, req);
    },

    error(err: unknown) {
      console.error("[LogTap] Server error:", err);
      return new Response("Internal Server Error", { status: 500 });
    },
  });

  return {
    server,
    stop() {
      clearInterval(rollupInterval);
      server.stop();
    },
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function corsResponse(res: Response, opts: ResolvedServerOptions, req: Request): Response {
  if (opts.corsOrigins.length === 0) return res;
  const origin = req.headers.get("origin") ?? "";
  const allowed = opts.corsOrigins.includes("*") || opts.corsOrigins.includes(origin);
  if (!allowed) return res;
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", origin || "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(res.body, { status: res.status, headers });
}
