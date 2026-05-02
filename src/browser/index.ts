import type { LogTapEvent, LogTapLevel } from "../shared/types.ts";
import { fingerprint } from "../shared/fingerprint.ts";
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
type ClientDedupe = { fp: string; seenAt: number };

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

  // client-side dedupe: max 500 fingerprints, 60s window
  const clientSeen: ClientDedupe[] = [];
  const CLIENT_DEDUPE_WINDOW = 60_000;
  const CLIENT_MAX_DEDUPES = 500;

  function shouldSendClientSide(event: LogTapEvent): boolean {
    const fp = fingerprint(event);
    const now = Date.now();

    // prune stale entries
    const cutoff = now - CLIENT_DEDUPE_WINDOW;
    while (clientSeen.length > 0 && (clientSeen[0]?.seenAt ?? 0) < cutoff) {
      clientSeen.shift();
    }

    const existing = clientSeen.find(c => c.fp === fp);
    if (existing && now - existing.seenAt < CLIENT_DEDUPE_WINDOW) return false;

    if (clientSeen.length >= CLIENT_MAX_DEDUPES) clientSeen.shift();
    clientSeen.push({ fp, seenAt: now });
    return true;
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
      return transport.flush();
    },

    stop() {
      transport.stop();
      for (const cleanup of cleanups) cleanup();
    },
  };
}
