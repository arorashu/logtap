import type { LogTapEvent, LogTapLevel } from "../shared/types.ts";
import { fingerprint } from "../shared/fingerprint.ts";
import { topStackFrame } from "../shared/normalize.ts";
import { BatchTransport } from "./transport.ts";
import { BreadcrumbBuffer, patchHistory } from "./breadcrumbs.ts";
import { patchConsole } from "./console.ts";
import { attachErrorListeners } from "./errors.ts";
import { patchFetch } from "./network.ts";

export type BrowserTapOptions = {
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
  clientDedupe?: boolean;
  clientDedupeWindowMs?: number;
  clientRollupIntervalMs?: number;
};

export type BrowserTap = {
  breadcrumb(name: string, data?: Record<string, unknown>): void;
  error(message: string, error?: unknown, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  flush(): Promise<void>;
  stop(): void;
};

const DEFAULT_SAMPLE: Record<LogTapLevel | "networkError", number> = {
  debug: 0,
  info: 0,
  warn: 1,
  error: 1,
  networkError: 1,
};

// simple client-side dedupe to reduce network spam
type ClientDedupeBucket = {
  fingerprint: string;
  firstSeen: number;
  lastSeen: number;
  observedCount: number;
  sentCount: number;
  suppressedCount: number;
  exemplar: LogTapEvent;
};

export function createBrowserTap(options: BrowserTapOptions): BrowserTap {
  const enabled = options.enabled !== false;

  if (!enabled) {
    return {
      breadcrumb: () => undefined,
      error: () => undefined,
      warn: () => undefined,
      flush: () => Promise.resolve(),
      stop: () => undefined,
    };
  }

  const sampleRates = { ...DEFAULT_SAMPLE, ...(options.sample ?? {}) };
  const maxBreadcrumbs = options.maxBreadcrumbs ?? 50;
  const flushIntervalMs = options.flushIntervalMs ?? 1000;
  const maxBatchSize = options.maxBatchSize ?? 20;
  const clientDedupe = options.clientDedupe !== false;
  const clientDedupeWindowMs = options.clientDedupeWindowMs ?? 60_000;
  const clientRollupIntervalMs = options.clientRollupIntervalMs ?? 1000;

  const base = {
    app: options.app,
    env: options.env,
    projectId: options.projectId,
    sessionId: options.sessionId,
    userId: options.userId,
    buildSha: options.buildSha,
    release: options.release,
  };

  const crumbs = new BreadcrumbBuffer(maxBreadcrumbs);
  const transport = new BatchTransport({ endpoint: options.endpoint, flushIntervalMs, maxBatchSize });
  transport.start();

  // Client-side dedupe protects the browser pipe, but rollups preserve counts.
  const clientBuckets = new Map<string, ClientDedupeBucket>();
  const CLIENT_MAX_DEDUPES = 500;
  const rollupTimer = clientDedupe
    ? setInterval(() => flushClientRollups(), clientRollupIntervalMs)
    : null;

  function shouldSendClientSide(event: LogTapEvent): boolean {
    if (!clientDedupe) return true;

    const fp = fingerprint(event);
    const now = Date.now();
    pruneClientBuckets(now);

    const existing = clientBuckets.get(fp);
    if (existing && now - existing.lastSeen <= clientDedupeWindowMs) {
      existing.observedCount++;
      existing.suppressedCount++;
      existing.lastSeen = now;
      existing.exemplar = event;
      return false;
    }

    if (existing) {
      flushClientRollup(existing);
      clientBuckets.delete(fp);
    }

    if (clientBuckets.size >= CLIENT_MAX_DEDUPES) {
      evictOldestClientBucket();
    }

    clientBuckets.set(fp, {
      fingerprint: fp,
      firstSeen: now,
      lastSeen: now,
      observedCount: 1,
      sentCount: 1,
      suppressedCount: 0,
      exemplar: event,
    });
    return true;
  }

  function pruneClientBuckets(now: number): void {
    for (const [fp, bucket] of clientBuckets) {
      if (now - bucket.lastSeen <= clientDedupeWindowMs) continue;
      if (bucket.suppressedCount > 0) flushClientRollup(bucket);
      clientBuckets.delete(fp);
    }
  }

  function evictOldestClientBucket(): void {
    let oldestKey: string | undefined;
    let oldestSeen = Infinity;
    for (const [fp, bucket] of clientBuckets) {
      if (bucket.lastSeen < oldestSeen) {
        oldestSeen = bucket.lastSeen;
        oldestKey = fp;
      }
    }
    if (!oldestKey) return;
    const bucket = clientBuckets.get(oldestKey);
    if (bucket && bucket.suppressedCount > 0) flushClientRollup(bucket);
    clientBuckets.delete(oldestKey);
  }

  function flushClientRollup(bucket: ClientDedupeBucket): void {
    if (bucket.suppressedCount <= 0) return;

    const exemplar = bucket.exemplar;
    transport.enqueue({
      ts: new Date().toISOString(),
      level: exemplar.level,
      kind: "rollup",
      message: "client_dedupe_rollup",
      app: exemplar.app,
      env: exemplar.env,
      projectId: exemplar.projectId,
      sessionId: exemplar.sessionId,
      userId: exemplar.userId,
      buildSha: exemplar.buildSha,
      release: exemplar.release,
      url: exemplar.url,
      route: exemplar.route,
      fingerprint: bucket.fingerprint,
      sourceMapStatus: exemplar.sourceMapStatus,
      network: exemplar.network,
      data: {
        observedCount: bucket.observedCount,
        storedCount: bucket.sentCount,
        suppressedCount: bucket.suppressedCount,
        firstSeen: new Date(bucket.firstSeen).toISOString(),
        lastSeen: new Date(bucket.lastSeen).toISOString(),
        exemplarMessage: exemplar.message,
        exemplarKind: exemplar.kind,
        stackTop: topStackFrame(exemplar.stackMapped ?? exemplar.stack),
      },
    });

    bucket.suppressedCount = 0;
  }

  function flushClientRollups(): void {
    for (const bucket of clientBuckets.values()) {
      flushClientRollup(bucket);
    }
  }

  function applySample(event: LogTapEvent): boolean {
    // never sample exceptions/rejections
    if (event.kind === "exception" || event.kind === "unhandledrejection") return true;
    const rate = event.kind === "network"
      ? sampleRates.networkError
      : sampleRates[event.level] ?? 1;
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    return Math.random() < rate;
  }

  function enqueue(event: LogTapEvent): void {
    if (!applySample(event)) return;
    if (!shouldSendClientSide(event)) return;
    transport.enqueue(event);
  }

  const cleanups: Array<() => void> = [];

  if (options.captureConsole !== false) {
    cleanups.push(patchConsole({
      ...base,
      getRoute: options.getRoute,
      onEvent: enqueue,
    }));
  }

  if (options.captureErrors !== false) {
    cleanups.push(attachErrorListeners({
      ...base,
      getRoute: options.getRoute,
      getBreadcrumbs: () => crumbs.getAll(),
      onEvent: enqueue,
    }));
  }

  if (options.captureNetwork !== false) {
    cleanups.push(patchFetch({
      ...base,
      getRoute: options.getRoute,
      getBreadcrumbs: () => crumbs.getAll(),
      ignoreUrls: [options.endpoint],
      onEvent: enqueue,
    }));
  }

  if (options.captureBreadcrumbs !== false) {
    cleanups.push(patchHistory((to) => {
      crumbs.add("route_change", { to });
    }));
  }

  return {
    breadcrumb(name, data) {
      crumbs.add(name, data);
    },

    error(message, error, data) {
      const err = error instanceof Error ? error : undefined;
      enqueue({
        ts: new Date().toISOString(),
        level: "error",
        kind: "manual",
        message,
        stack: err?.stack,
        route: options.getRoute?.(),
        url: typeof location !== "undefined" ? location.href : undefined,
        breadcrumbs: crumbs.getAll(),
        data,
        ...base,
      });
    },

    warn(message, data) {
      enqueue({
        ts: new Date().toISOString(),
        level: "warn",
        kind: "manual",
        message,
        route: options.getRoute?.(),
        url: typeof location !== "undefined" ? location.href : undefined,
        data,
        ...base,
      });
    },

    flush() {
      flushClientRollups();
      return transport.flush();
    },

    stop() {
      flushClientRollups();
      void transport.flush();
      if (rollupTimer !== null) clearInterval(rollupTimer);
      transport.stop();
      for (const cleanup of cleanups) cleanup();
    },
  };
}
