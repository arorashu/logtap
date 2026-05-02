import type { LogTapEvent, ResolvedServerOptions } from "../shared/types.ts";
import { isValidEvent, coerceEvent } from "../shared/schema.ts";
import { resolveProjectId } from "../shared/project.ts";
import { fingerprint } from "../shared/fingerprint.ts";
import { buildRedactor } from "./redact.ts";
import { appendEvent, applyRetention, applyGlobalRetention } from "./store.ts";
import { projectDir } from "./store.ts";
import { DedupeEngine } from "./dedupe.ts";
import { enrichWithSourceMaps } from "./sourcemaps.ts";
import * as path from "node:path";

export async function processEvents(
  rawEvents: unknown[],
  opts: ResolvedServerOptions,
  dedupe: DedupeEngine,
): Promise<{ stored: number; dropped: number }> {
  const redact = buildRedactor(opts.redactFields);
  let stored = 0;
  let dropped = 0;

  for (const raw of rawEvents) {
    if (!isValidEvent(raw)) {
      dropped++;
      continue;
    }

    let event = coerceEvent(raw as Record<string, unknown>);

    // add server timestamp if missing
    if (!event.ts) event = { ...event, ts: new Date().toISOString() };

    // apply ignore rules
    const ignored = opts.ignoreMessages.some(re => re.test(event.message));
    if (ignored) { dropped++; continue; }

    // resolve project
    const projectId = resolveProjectId(event);
    event = { ...event, projectId };

    // redact
    event = redact(event) as LogTapEvent;

    // Rollups carry the exemplar fingerprint they summarize.
    const fp = event.kind === "rollup" && event.fingerprint
      ? event.fingerprint
      : fingerprint(event);
    event = { ...event, fingerprint: fp };

    // source map enrichment
    if (opts.sourcemaps.enabled && event.stack) {
      const artifactDir = opts.sourcemaps.artifactDir ?? "artifacts";
      const releaseKey = opts.sourcemaps.releaseField ?? "buildSha";
      const release = event[releaseKey];
      if (release) {
        const dir = path.isAbsolute(artifactDir)
          ? path.join(artifactDir, release, "assets")
          : path.join(projectDir(opts.rootDir, projectId), artifactDir, release, "assets");
        try {
          event = await enrichWithSourceMaps(event, dir, opts.sourcemaps);
        } catch {
          event = { ...event, sourceMapStatus: "failed" };
        }
      } else {
        event = { ...event, sourceMapStatus: "missing" };
      }
    }

    if (event.kind !== "rollup") {
      const firstOccurrence = opts.dedupe.enabled && !dedupe.getBucket(projectId, fp);

      // dedupe
      const shouldStore = dedupe.shouldStore(event, projectId);
      if (!shouldStore) { dropped++; continue; }

      // sampling (after dedupe); first occurrence of a fingerprint is always kept.
      if (!firstOccurrence && !shouldSample(event, opts)) { dropped++; continue; }
    }

    appendEvent(opts.rootDir, projectId, event);
    stored++;

    // retention after each write (lightweight: only if file grew)
    applyRetention(opts.rootDir, projectId, {
      maxProjectLogBytes: opts.maxProjectLogBytes,
      maxProjectEvents: opts.maxProjectEvents,
      maxEventAgeMs: opts.maxEventAgeMs,
      maxAllProjectsBytes: opts.maxAllProjectsBytes,
      strategy: "truncate_oldest",
    });
  }

  // global retention check
  applyGlobalRetention(opts.rootDir, {
    maxProjectLogBytes: opts.maxProjectLogBytes,
    maxProjectEvents: opts.maxProjectEvents,
    maxEventAgeMs: opts.maxEventAgeMs,
    maxAllProjectsBytes: opts.maxAllProjectsBytes,
    strategy: "truncate_oldest",
  });

  return { stored, dropped };
}

function shouldSample(event: LogTapEvent, opts: ResolvedServerOptions): boolean {
  const s = opts.sampling;
  // never randomly sample uncaught exceptions or unhandled rejections
  if (event.kind === "exception" || event.kind === "unhandledrejection") return true;

  const rate = (() => {
    if (event.kind === "network") return s.networkError;
    if (event.level === "debug") return s.debug;
    if (event.level === "info") return s.info;
    if (event.level === "warn") return s.warn;
    if (event.level === "error") return s.error;
    return 1;
  })();

  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return Math.random() < rate;
}
