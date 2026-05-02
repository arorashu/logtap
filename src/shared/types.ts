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

export type SourceMapStatus = "not_needed" | "mapped" | "missing" | "failed";

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

export type DedupeBucket = {
  fingerprint: string;
  firstSeen: number;
  lastSeen: number;
  observedCount: number;
  storedCount: number;
  suppressedCount: number;
  lastStoredAt: number;
  exemplar: LogTapEvent;
};

export type DedupeOptions = {
  enabled: boolean;
  maxBuckets: number;
  storeFirstOccurrence: boolean;
  storeAtCounts: number[];
  perFingerprintMinIntervalMs: {
    error: number;
    warn: number;
    network: number;
    default: number;
  };
  rollupIntervalMs: number;
};

export type SamplingOptions = {
  debug: number;
  info: number;
  warn: number;
  error: number;
  networkError: number;
  repeatedWarn: number;
  breadcrumbStandalone: number;
};

export type SourceMapOptions = {
  enabled: boolean;
  artifactDir?: string;
  releaseField?: "buildSha" | "release";
  stripPrefixes?: string[];
  watchDirs?: string[];
};

export type RetentionOptions = {
  maxProjectLogBytes: number;
  maxProjectEvents: number;
  maxEventAgeMs: number;
  maxAllProjectsBytes: number;
  strategy: "truncate_oldest";
};

export type SummarySection = {
  title: string;
  items: Array<Record<string, unknown>>;
};

export type SummaryProvider = {
  name: string;
  summarize(events: LogTapEvent[]): SummarySection | undefined;
};

export type LogTapServerOptions = {
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

  dedupe?: Partial<DedupeOptions>;
  sampling?: Partial<SamplingOptions>;
  sourcemaps?: SourceMapOptions;
  summaryProviders?: SummaryProvider[];
};

export type ResolvedServerOptions = {
  port: number;
  host: string;
  basePath: string;
  rootDir: string;

  maxProjectLogBytes: number;
  maxProjectEvents: number;
  maxEventAgeMs: number;
  maxAllProjectsBytes: number;
  maxEventBytes: number;
  maxBatchBytes: number;

  corsOrigins: string[];
  ingestToken?: string;
  redactFields: string[];
  ignoreMessages: RegExp[];

  dedupe: DedupeOptions;
  sampling: SamplingOptions;
  sourcemaps: SourceMapOptions;
  summaryProviders: SummaryProvider[];
};

export type ProjectSummaryJson = {
  projectId: string;
  window: string;
  start: string;
  end: string;
  totalStoredEvents: number;
  estimatedObservedEvents: number;
  errorsStored: number;
  errorsObserved: number;
  warningsStored: number;
  warningsObserved: number;
  networkFailuresStored: number;
  networkFailuresObserved: number;
  suppressedDuplicates: number;
  topErrors: TopErrorEntry[];
  recentBreadcrumbs: LogTapBreadcrumb[];
  recentNetworkFailures: NetworkFailureEntry[];
  sourceMapStatusCounts: Record<string, number>;
  logFileBytes: number;
  retentionPolicy: RetentionOptions;
  truncationLikely: boolean;
  sections?: SummarySection[];
};

export type TopErrorEntry = {
  message: string;
  fingerprint: string;
  storedCount: number;
  observedCount: number;
  suppressedCount: number;
  firstSeen: string;
  lastSeen: string;
  route?: string;
  stackTop?: string;
  sourceMapStatus?: SourceMapStatus;
};

export type NetworkFailureEntry = {
  method?: string;
  url?: string;
  status?: number;
  observedCount: number;
  fingerprint: string;
};
