import * as http from "node:http";
import * as url from "node:url";
import type { ResolvedServerOptions } from "../shared/types.ts";
import { processEvents } from "./ingest.ts";
import { tail } from "./tail.ts";
import { query } from "./query.ts";
import { buildSummary, summaryToMarkdown, writeSummaryFiles } from "./summary.ts";
import { clearProject, listProjectIds } from "./store.ts";
import { DedupeEngine } from "./dedupe.ts";

export function createNodeServer(opts: ResolvedServerOptions) {
  const dedupe = new DedupeEngine(opts.dedupe);
  const base = opts.basePath.replace(/\/$/, "");

  const rollupInterval = setInterval(() => {
    for (const pid of listProjectIds(opts.rootDir)) {
      const rollups = dedupe.getRollups(pid);
      for (const r of rollups) {
        import("./store.ts").then(({ appendEvent }) => appendEvent(opts.rootDir, pid, r));
      }
    }
  }, opts.dedupe.rollupIntervalMs);
  rollupInterval.unref();

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url ?? "/", true);
    const pathname = parsed.pathname ?? "/";
    const qs = parsed.query as Record<string, string | undefined>;
    const method = (req.method ?? "GET").toUpperCase();

    function setcors(): void {
      if (opts.corsOrigins.length === 0) return;
      const origin = (req.headers["origin"] as string | undefined) ?? "";
      const allowed = opts.corsOrigins.includes("*") || opts.corsOrigins.includes(origin);
      if (!allowed) return;
      // Specific Origin → enable credentials (sendBeacon always sends
      // cookies, so without ACAC=true the preflight fails). ACAC=true
      // is incompatible with ACAO=* so only pair them when we have a
      // concrete origin.
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Vary", "Origin");
      } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }

    function sendJson(data: unknown, status = 200): void {
      setcors();
      const body = JSON.stringify(data);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    }

    function send(body: string, status = 200, contentType = "text/plain"): void {
      setcors();
      res.writeHead(status, { "Content-Type": contentType });
      res.end(body);
    }

    if (method === "OPTIONS") {
      setcors();
      res.writeHead(204);
      res.end();
      return;
    }

    if (opts.ingestToken) {
      const auth = (req.headers["authorization"] ?? "") as string;
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
      if (token !== opts.ingestToken) {
        send("Unauthorized", 401);
        return;
      }
    }

    if (pathname === `${base}/healthz`) {
      sendJson({ ok: true });
      return;
    }

    if (pathname === `${base}/ingest` && method === "POST") {
      let bodyStr = "";
      for await (const chunk of req) {
        bodyStr += chunk;
        if (bodyStr.length > opts.maxBatchBytes) {
          send("Payload too large", 400);
          return;
        }
      }
      let body: unknown;
      try { body = JSON.parse(bodyStr); }
      catch { send("Invalid JSON", 400); return; }

      let rawEvents: unknown[];
      if (Array.isArray((body as Record<string, unknown>)?.["events"])) {
        rawEvents = (body as { events: unknown[] }).events;
      } else if (body && typeof body === "object" && !Array.isArray(body)) {
        rawEvents = [body];
      } else {
        send("Invalid payload", 400);
        return;
      }

      rawEvents = rawEvents.filter(e => JSON.stringify(e).length <= opts.maxEventBytes);
      await processEvents(rawEvents, opts, dedupe);
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === `${base}/tail` && method === "GET") {
      const projectId = qs["project"] ?? "default.dev";
      const n = Math.min(parseInt(qs["n"] ?? "200", 10), 1000);
      const events = tail(opts.rootDir, projectId, n);
      sendJson({ projectId, events });
      return;
    }

    if (pathname === `${base}/query` && method === "GET") {
      const projectId = qs["project"] ?? "default.dev";
      const events = query(opts.rootDir, {
        project: projectId,
        level: qs["level"] as never,
        kind: qs["kind"] as never,
        since: qs["since"],
        route: qs["route"],
        fingerprint: qs["fingerprint"],
      });
      sendJson({ projectId, events });
      return;
    }

    if (pathname === `${base}/summary` && method === "GET") {
      const projectId = qs["project"] ?? "default.dev";
      const retention = {
        maxProjectLogBytes: opts.maxProjectLogBytes,
        maxProjectEvents: opts.maxProjectEvents,
        maxEventAgeMs: opts.maxEventAgeMs,
        maxAllProjectsBytes: opts.maxAllProjectsBytes,
        strategy: "truncate_oldest" as const,
      };
      const summary = buildSummary(opts.rootDir, projectId, qs["since"], retention, opts.summaryProviders);
      const md = summaryToMarkdown(summary);
      writeSummaryFiles(opts.rootDir, projectId, summary, md);
      sendJson(summary);
      return;
    }

    if (pathname === `${base}/summary.md` && method === "GET") {
      const projectId = qs["project"] ?? "default.dev";
      const retention = {
        maxProjectLogBytes: opts.maxProjectLogBytes,
        maxProjectEvents: opts.maxProjectEvents,
        maxEventAgeMs: opts.maxEventAgeMs,
        maxAllProjectsBytes: opts.maxAllProjectsBytes,
        strategy: "truncate_oldest" as const,
      };
      const summary = buildSummary(opts.rootDir, projectId, qs["since"], retention, opts.summaryProviders);
      const md = summaryToMarkdown(summary);
      writeSummaryFiles(opts.rootDir, projectId, summary, md);
      send(md, 200, "text/markdown; charset=utf-8");
      return;
    }

    if (pathname === `${base}/clear` && method === "POST") {
      const projectId = qs["project"] ?? "default.dev";
      clearProject(opts.rootDir, projectId);
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === `${base}/projects` && method === "GET") {
      sendJson({ projects: listProjectIds(opts.rootDir) });
      return;
    }

    send("Not Found", 404);
  });

  return {
    server,
    start(): Promise<void> {
      return new Promise(resolve => server.listen(opts.port, opts.host, resolve));
    },
    stop(): Promise<void> {
      clearInterval(rollupInterval);
      return new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    },
  };
}
