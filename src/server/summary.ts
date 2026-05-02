import * as fs from "node:fs";
import { readEvents, getLogFileBytes, summaryMdFile, summaryJsonFile, ensureProjectDirs } from "./store.ts";
import { sinceToStartMs } from "../shared/time.ts";
import { topStackFrame } from "../shared/normalize.ts";
import type {
  LogTapEvent,
  ProjectSummaryJson,
  TopErrorEntry,
  NetworkFailureEntry,
  RetentionOptions,
  SummaryProvider,
  SummarySection,
} from "../shared/types.ts";

const DEFAULT_RETENTION: RetentionOptions = {
  maxProjectLogBytes: 25 * 1024 * 1024,
  maxProjectEvents: 25_000,
  maxEventAgeMs: 24 * 60 * 60 * 1000,
  maxAllProjectsBytes: 100 * 1024 * 1024,
  strategy: "truncate_oldest",
};

export function buildSummary(
  rootDir: string,
  projectId: string,
  since: string | undefined,
  retention: RetentionOptions = DEFAULT_RETENTION,
  providers: SummaryProvider[] = [],
): ProjectSummaryJson {
  const allEvents = readEvents(rootDir, projectId);
  const now = Date.now();
  const startMs = sinceToStartMs(since, now);
  const windowLabel = since ?? "all";

  const events = startMs > 0
    ? allEvents.filter(e => new Date(e.ts).getTime() >= startMs)
    : allEvents;

  const start = startMs > 0 ? new Date(startMs).toISOString() : (events[0]?.ts ?? new Date().toISOString());
  const end = new Date(now).toISOString();

  // counts
  let errorsStored = 0, errorsObserved = 0;
  let warningsStored = 0, warningsObserved = 0;
  let networkFailuresStored = 0, networkFailuresObserved = 0;
  let suppressedDuplicates = 0;

  const errorGroups = new Map<string, TopErrorEntry>();
  const networkGroups = new Map<string, NetworkFailureEntry>();
  const recentBreadcrumbs: LogTapEvent["breadcrumbs"] = [];
  const sourceMapCounts: Record<string, number> = {};

  for (const e of events) {
    if (e.kind === "rollup" && e.data) {
      const d = e.data as Record<string, unknown>;
      const suppressed = typeof d["suppressedCount"] === "number" ? d["suppressedCount"] : 0;
      suppressedDuplicates += suppressed;
      const observed = typeof d["observedCount"] === "number" ? d["observedCount"] : 0;
      const stored = typeof d["storedCount"] === "number" ? d["storedCount"] : 0;
      if (e.level === "error") { errorsObserved += observed; errorsStored += stored; }
      if (e.level === "warn") { warningsObserved += observed; warningsStored += stored; }
      continue;
    }

    if (e.level === "error") {
      errorsStored++;
      errorsObserved++;
    } else if (e.level === "warn") {
      warningsStored++;
      warningsObserved++;
    }

    if (e.kind === "network" && e.network && (e.network.status ?? 0) >= 400) {
      networkFailuresStored++;
      networkFailuresObserved++;
      const nfp = e.fingerprint ?? `${e.network.method}|${e.network.url}|${e.network.status}`;
      const existing = networkGroups.get(nfp);
      if (existing) {
        existing.observedCount++;
      } else {
        networkGroups.set(nfp, {
          method: e.network.method,
          url: e.network.url,
          status: e.network.status,
          observedCount: 1,
          fingerprint: nfp,
        });
      }
    }

    if (e.level === "error" || (e.level === "warn" && e.kind !== "rollup")) {
      const fp = e.fingerprint ?? e.message;
      const existing = errorGroups.get(fp);
      if (existing) {
        existing.storedCount++;
        existing.observedCount++;
        existing.lastSeen = e.ts;
      } else {
        errorGroups.set(fp, {
          message: e.message,
          fingerprint: fp,
          storedCount: 1,
          observedCount: 1,
          suppressedCount: 0,
          firstSeen: e.ts,
          lastSeen: e.ts,
          route: e.route,
          stackTop: topStackFrame(e.stackMapped ?? e.stack),
          sourceMapStatus: e.sourceMapStatus,
        });
      }
    }

    if (e.breadcrumbs) {
      recentBreadcrumbs.push(...e.breadcrumbs);
    }

    if (e.sourceMapStatus) {
      sourceMapCounts[e.sourceMapStatus] = (sourceMapCounts[e.sourceMapStatus] ?? 0) + 1;
    }
  }

  // build top errors sorted by observed count
  const topErrors = [...errorGroups.values()]
    .sort((a, b) => b.observedCount - a.observedCount)
    .slice(0, 10);

  const recentNetworkFailures = [...networkGroups.values()]
    .sort((a, b) => b.observedCount - a.observedCount)
    .slice(0, 10);

  // deduplicate breadcrumbs — keep last 20
  const seenBreadcrumbs = recentBreadcrumbs.slice(-20);

  const logFileBytes = getLogFileBytes(rootDir, projectId);
  const truncationLikely = logFileBytes >= retention.maxProjectLogBytes * 0.9;

  const totalStored = events.filter(e => e.kind !== "rollup").length;
  const estimatedObserved = totalStored + suppressedDuplicates;

  // run custom providers
  const extraSections: SummarySection[] = [];
  for (const provider of providers) {
    const section = provider.summarize(events);
    if (section) extraSections.push(section);
  }

  return {
    projectId,
    window: windowLabel,
    start,
    end,
    totalStoredEvents: totalStored,
    estimatedObservedEvents: estimatedObserved,
    errorsStored,
    errorsObserved,
    warningsStored,
    warningsObserved,
    networkFailuresStored,
    networkFailuresObserved,
    suppressedDuplicates,
    topErrors,
    recentBreadcrumbs: seenBreadcrumbs ?? [],
    recentNetworkFailures,
    sourceMapStatusCounts: sourceMapCounts,
    logFileBytes,
    retentionPolicy: retention,
    truncationLikely,
    sections: extraSections.length > 0 ? extraSections : undefined,
  };
}

export function summaryToMarkdown(s: ProjectSummaryJson): string {
  const lines: string[] = [];
  lines.push("# LogTap Client Summary");
  lines.push("");
  lines.push(`Project: ${s.projectId}`);
  lines.push(`Window: ${s.window === "all" ? "all time" : `last ${s.window}`}`);
  lines.push(`Stored events considered: ${s.totalStoredEvents}`);
  lines.push(`Observed events estimated: ${s.estimatedObservedEvents}`);
  lines.push(`Suppressed duplicates: ${s.suppressedDuplicates}`);
  lines.push(`Errors: ${s.errorsStored} stored / ${s.errorsObserved} observed`);
  lines.push(`Warnings: ${s.warningsStored} stored / ${s.warningsObserved} observed`);
  lines.push(`Network failures: ${s.networkFailuresStored} stored / ${s.networkFailuresObserved} observed`);
  lines.push(`Log file size: ${formatBytes(s.logFileBytes)}`);
  if (s.truncationLikely) lines.push("⚠ Truncation likely — oldest events may be missing");
  lines.push("");

  if (s.topErrors.length > 0) {
    lines.push("## Top errors");
    lines.push("");
    s.topErrors.forEach((e, i) => {
      lines.push(`${i + 1}. ${e.message}`);
      lines.push(`   Observed: ${e.observedCount}`);
      lines.push(`   Stored: ${e.storedCount}`);
      if (e.suppressedCount > 0) lines.push(`   Suppressed: ${e.suppressedCount}`);
      if (e.route) lines.push(`   Route: ${e.route}`);
      if (e.stackTop) lines.push(`   Stack: ${e.stackTop}`);
      if (e.sourceMapStatus && e.sourceMapStatus !== "not_needed") {
        lines.push(`   Source map: ${e.sourceMapStatus}`);
      }
      lines.push("");
    });
  }

  if (s.recentBreadcrumbs.length > 0) {
    lines.push("## Recent breadcrumbs");
    lines.push("");
    for (const b of s.recentBreadcrumbs) {
      const extra = b.data ? ` ${JSON.stringify(b.data)}` : "";
      lines.push(`- ${b.name}${extra}`);
    }
    lines.push("");
  }

  if (s.recentNetworkFailures.length > 0) {
    lines.push("## Network failures");
    lines.push("");
    for (const n of s.recentNetworkFailures) {
      lines.push(`- ${n.method ?? "?"} ${n.url ?? "?"} -> ${n.status ?? "?"}, observed ${n.observedCount} times`);
    }
    lines.push("");
  }

  if (Object.keys(s.sourceMapStatusCounts).length > 0) {
    lines.push("## Source map status");
    lines.push("");
    for (const [status, count] of Object.entries(s.sourceMapStatusCounts)) {
      lines.push(`- ${status}: ${count}`);
    }
    lines.push("");
  }

  if (s.sections) {
    for (const section of s.sections) {
      lines.push(`## ${section.title}`);
      lines.push("");
      for (const item of section.items) {
        lines.push(`- ${JSON.stringify(item)}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function writeSummaryFiles(
  rootDir: string,
  projectId: string,
  summary: ProjectSummaryJson,
  md: string,
): void {
  ensureProjectDirs(rootDir, projectId);
  fs.writeFileSync(summaryJsonFile(rootDir, projectId), JSON.stringify(summary, null, 2), "utf8");
  fs.writeFileSync(summaryMdFile(rootDir, projectId), md, "utf8");
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}
