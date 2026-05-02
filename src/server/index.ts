import type {
  LogTapServerOptions,
  ResolvedServerOptions,
  DedupeOptions,
  SamplingOptions,
  SourceMapOptions,
} from "../shared/types.ts";
import { DEFAULT_DEDUPE_OPTIONS } from "./dedupe.ts";

export type { LogTapServerOptions, ResolvedServerOptions } from "../shared/types.ts";
export { buildSummary, summaryToMarkdown, writeSummaryFiles } from "./summary.ts";
export { processEvents } from "./ingest.ts";
export { DedupeEngine } from "./dedupe.ts";

const DEFAULT_SAMPLING: SamplingOptions = {
  debug: 0,
  info: 0,
  warn: 1,
  error: 1,
  networkError: 1,
  repeatedWarn: 0,
  breadcrumbStandalone: 0,
};

const DEFAULT_SOURCEMAPS: SourceMapOptions = {
  enabled: false,
  artifactDir: "artifacts",
  releaseField: "buildSha",
  stripPrefixes: [],
  watchDirs: [],
};

export function resolveOptions(opts: LogTapServerOptions = {}): ResolvedServerOptions {
  return {
    port: opts.port ?? 4319,
    host: opts.host ?? "127.0.0.1",
    basePath: opts.basePath ?? "/__logtap",
    rootDir: opts.rootDir ?? ".agent/logtap",

    maxProjectLogBytes: opts.maxProjectLogBytes ?? 25 * 1024 * 1024,
    maxProjectEvents: opts.maxProjectEvents ?? 25_000,
    maxEventAgeMs: opts.maxEventAgeMs ?? 24 * 60 * 60 * 1000,
    maxAllProjectsBytes: opts.maxAllProjectsBytes ?? 100 * 1024 * 1024,
    maxEventBytes: opts.maxEventBytes ?? 64 * 1024,
    maxBatchBytes: opts.maxBatchBytes ?? 256 * 1024,

    corsOrigins: opts.corsOrigins ?? [],
    ingestToken: opts.ingestToken,
    redactFields: opts.redactFields ?? [],
    ignoreMessages: opts.ignoreMessages ?? [],

    dedupe: { ...DEFAULT_DEDUPE_OPTIONS, ...(opts.dedupe ?? {}) } as DedupeOptions,
    sampling: { ...DEFAULT_SAMPLING, ...(opts.sampling ?? {}) },
    sourcemaps: { ...DEFAULT_SOURCEMAPS, ...(opts.sourcemaps ?? {}) },
    summaryProviders: opts.summaryProviders ?? [],
  };
}

export type LogTapServer = {
  start(): Promise<void>;
  stop(): void | Promise<void>;
  port: number;
};

export function createLogTapServer(opts: LogTapServerOptions = {}): LogTapServer {
  const resolved = resolveOptions(opts);

  // try Bun first, fall back to Node
  const isBun = typeof Bun !== "undefined";

  if (isBun) {
    let bunServer: ReturnType<typeof import("./bun.ts")["createBunServer"]> | null = null;
    return {
      port: resolved.port,
      async start() {
        const { createBunServer } = await import("./bun.ts");
        bunServer = createBunServer(resolved);
        console.log(`[LogTap] Listening on http://${resolved.host}:${resolved.port}${resolved.basePath}`);
      },
      stop() {
        bunServer?.stop();
      },
    };
  } else {
    let nodeServer: ReturnType<typeof import("./node.ts")["createNodeServer"]> | null = null;
    return {
      port: resolved.port,
      async start() {
        const { createNodeServer } = await import("./node.ts");
        nodeServer = createNodeServer(resolved);
        await nodeServer.start();
        console.log(`[LogTap] Listening on http://${resolved.host}:${resolved.port}${resolved.basePath}`);
      },
      async stop() {
        await nodeServer?.stop();
      },
    };
  }
}
