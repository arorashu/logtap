import type { LogTapEvent, DedupeBucket, DedupeOptions } from "../shared/types.ts";
import { fingerprint as computeFingerprint } from "../shared/fingerprint.ts";
import { topStackFrame } from "../shared/normalize.ts";

export const DEFAULT_DEDUPE_OPTIONS: DedupeOptions = {
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
};

export class DedupeEngine {
  private buckets = new Map<string, Map<string, DedupeBucket>>();
  private opts: DedupeOptions;

  constructor(opts: DedupeOptions = DEFAULT_DEDUPE_OPTIONS) {
    this.opts = opts;
  }

  shouldStore(event: LogTapEvent, projectId: string): boolean {
    if (!this.opts.enabled) return true;

    const fp = event.fingerprint ?? computeFingerprint(event);
    const projectBuckets = this.getProjectBuckets(projectId);
    const now = Date.now();

    let bucket = projectBuckets.get(fp);
    if (!bucket) {
      // first occurrence
      if (projectBuckets.size >= this.opts.maxBuckets) {
        this.evictOldest(projectBuckets);
      }
      bucket = {
        fingerprint: fp,
        firstSeen: now,
        lastSeen: now,
        observedCount: 1,
        storedCount: 0,
        suppressedCount: 0,
        lastStoredAt: 0,
        exemplar: event,
      };
      projectBuckets.set(fp, bucket);

      if (this.opts.storeFirstOccurrence) {
        bucket.storedCount++;
        bucket.lastStoredAt = now;
        return true;
      }
      return false;
    }

    bucket.observedCount++;
    bucket.lastSeen = now;
    bucket.exemplar = event;

    // store at milestone counts
    if (this.opts.storeAtCounts.includes(bucket.observedCount)) {
      bucket.storedCount++;
      bucket.lastStoredAt = now;
      return true;
    }

    // store if min interval elapsed
    const minInterval = this.minIntervalFor(event);
    if (now - bucket.lastStoredAt >= minInterval) {
      bucket.storedCount++;
      bucket.lastStoredAt = now;
      return true;
    }

    bucket.suppressedCount++;
    return false;
  }

  getBucket(projectId: string, fp: string): DedupeBucket | undefined {
    return this.buckets.get(projectId)?.get(fp);
  }

  getRollups(projectId: string): LogTapEvent[] {
    const projectBuckets = this.buckets.get(projectId);
    if (!projectBuckets) return [];
    const now = Date.now();
    const rollups: LogTapEvent[] = [];

    for (const [fp, bucket] of projectBuckets) {
      if (bucket.suppressedCount === 0) continue;
      if (now - bucket.lastSeen > this.opts.rollupIntervalMs * 2) continue;

      rollups.push({
        ts: new Date().toISOString(),
        level: bucket.exemplar.level,
        kind: "rollup",
        message: "dedupe_rollup",
        app: bucket.exemplar.app,
        env: bucket.exemplar.env,
        projectId: bucket.exemplar.projectId,
        sessionId: bucket.exemplar.sessionId,
        userId: bucket.exemplar.userId,
        buildSha: bucket.exemplar.buildSha,
        release: bucket.exemplar.release,
        url: bucket.exemplar.url,
        route: bucket.exemplar.route,
        network: bucket.exemplar.network,
        sourceMapStatus: bucket.exemplar.sourceMapStatus,
        fingerprint: fp,
        data: {
          observedCount: bucket.observedCount,
          storedCount: bucket.storedCount,
          suppressedCount: bucket.suppressedCount,
          firstSeen: new Date(bucket.firstSeen).toISOString(),
          lastSeen: new Date(bucket.lastSeen).toISOString(),
          exemplarMessage: bucket.exemplar.message,
          exemplarKind: bucket.exemplar.kind,
          stackTop: topStackFrame(bucket.exemplar.stackMapped ?? bucket.exemplar.stack),
        },
      });
      // reset suppressed count after rollup
      bucket.suppressedCount = 0;
    }
    return rollups;
  }

  private getProjectBuckets(projectId: string): Map<string, DedupeBucket> {
    let m = this.buckets.get(projectId);
    if (!m) {
      m = new Map();
      this.buckets.set(projectId, m);
    }
    return m;
  }

  private minIntervalFor(event: LogTapEvent): number {
    if (event.kind === "network") return this.opts.perFingerprintMinIntervalMs.network;
    if (event.level === "error") return this.opts.perFingerprintMinIntervalMs.error;
    if (event.level === "warn") return this.opts.perFingerprintMinIntervalMs.warn;
    return this.opts.perFingerprintMinIntervalMs.default;
  }

  private evictOldest(buckets: Map<string, DedupeBucket>): void {
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [k, b] of buckets) {
      if (b.lastSeen < oldestTime) {
        oldestTime = b.lastSeen;
        oldestKey = k;
      }
    }
    if (oldestKey) buckets.delete(oldestKey);
  }
}
