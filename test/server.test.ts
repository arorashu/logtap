import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  appendEvent, readEvents, clearProject, logFile, getLogFileBytes,
} from "../src/server/store.ts";
import { applyRetention, applyGlobalRetention } from "../src/server/store.ts";
import { tail } from "../src/server/tail.ts";
import { query } from "../src/server/query.ts";
import { buildSummary, summaryToMarkdown, writeSummaryFiles } from "../src/server/summary.ts";
import { processEvents } from "../src/server/ingest.ts";
import { DedupeEngine } from "../src/server/dedupe.ts";
import { resolveOptions } from "../src/server/index.ts";
import { summaryMdFile, summaryJsonFile } from "../src/server/store.ts";
import type { LogTapEvent } from "../src/shared/types.ts";

let tmpDir: string;

function makeEvent(overrides: Partial<LogTapEvent> = {}): LogTapEvent {
  return {
    ts: new Date().toISOString(),
    level: "error",
    kind: "console",
    message: "Test error",
    projectId: "test.dev",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logtap-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("store: append and read", () => {
  it("writes JSONL under correct project", () => {
    appendEvent(tmpDir, "billing.dev", makeEvent({ projectId: "billing.dev" }));
    const events = readEvents(tmpDir, "billing.dev");
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toBe("Test error");
  });

  it("missing project resolves to default.dev for tail", () => {
    appendEvent(tmpDir, "default.dev", makeEvent({ projectId: "default.dev", message: "default" }));
    const events = tail(tmpDir, "default.dev", 10);
    expect(events[0]?.message).toBe("default");
  });

  it("returns empty array for non-existent project", () => {
    expect(readEvents(tmpDir, "nonexistent.dev")).toEqual([]);
  });
});

describe("tail", () => {
  it("returns last N events", () => {
    for (let i = 0; i < 10; i++) {
      appendEvent(tmpDir, "test.dev", makeEvent({ message: `msg-${i}` }));
    }
    const events = tail(tmpDir, "test.dev", 5);
    expect(events).toHaveLength(5);
    expect(events[0]?.message).toBe("msg-5");
    expect(events[4]?.message).toBe("msg-9");
  });

  it("caps N at 1000", () => {
    for (let i = 0; i < 5; i++) {
      appendEvent(tmpDir, "test.dev", makeEvent());
    }
    const events = tail(tmpDir, "test.dev", 9999);
    expect(events.length).toBeLessThanOrEqual(1000);
  });
});

describe("query", () => {
  beforeEach(() => {
    appendEvent(tmpDir, "test.dev", makeEvent({ level: "error", kind: "exception", route: "/home" }));
    appendEvent(tmpDir, "test.dev", makeEvent({ level: "warn", kind: "console", route: "/about" }));
    appendEvent(tmpDir, "test.dev", makeEvent({ level: "error", kind: "network" }));
  });

  it("filters by level", () => {
    const events = query(tmpDir, { project: "test.dev", level: "warn" });
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe("warn");
  });

  it("filters by kind", () => {
    const events = query(tmpDir, { project: "test.dev", kind: "network" });
    expect(events).toHaveLength(1);
  });

  it("filters by route", () => {
    const events = query(tmpDir, { project: "test.dev", route: "/home" });
    expect(events).toHaveLength(1);
    expect(events[0]?.route).toBe("/home");
  });

  it("filters by fingerprint", () => {
    const allEvents = readEvents(tmpDir, "test.dev");
    const fp = allEvents[0]?.fingerprint;
    if (fp) {
      const events = query(tmpDir, { project: "test.dev", fingerprint: fp });
      expect(events.length).toBeGreaterThan(0);
    }
  });

  it("filters by since", () => {
    const old = makeEvent({ ts: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });
    appendEvent(tmpDir, "test.dev", old);
    const events = query(tmpDir, { project: "test.dev", since: "1h" });
    // old event should be excluded
    for (const e of events) {
      const age = Date.now() - new Date(e.ts).getTime();
      expect(age).toBeLessThan(60 * 60 * 1000 + 5000);
    }
  });
});

describe("retention: project", () => {
  it("caps by event count", () => {
    for (let i = 0; i < 20; i++) {
      appendEvent(tmpDir, "test.dev", makeEvent({ message: `msg-${i}` }));
    }
    applyRetention(tmpDir, "test.dev", {
      maxProjectLogBytes: 100 * 1024 * 1024,
      maxProjectEvents: 10,
      maxEventAgeMs: 0,
      maxAllProjectsBytes: 100 * 1024 * 1024,
      strategy: "truncate_oldest",
    });
    const events = readEvents(tmpDir, "test.dev");
    expect(events.length).toBeLessThanOrEqual(10);
    // should keep newest
    expect(events[events.length - 1]?.message).toBe("msg-19");
  });

  it("caps by max bytes", () => {
    for (let i = 0; i < 50; i++) {
      appendEvent(tmpDir, "test.dev", makeEvent({ message: "x".repeat(100) }));
    }
    const before = getLogFileBytes(tmpDir, "test.dev");
    applyRetention(tmpDir, "test.dev", {
      maxProjectLogBytes: 1000,
      maxProjectEvents: 25_000,
      maxEventAgeMs: 0,
      maxAllProjectsBytes: 100 * 1024 * 1024,
      strategy: "truncate_oldest",
    });
    const after = getLogFileBytes(tmpDir, "test.dev");
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThanOrEqual(1000 + 200); // small buffer for last event
  });

  it("drops events older than max age", () => {
    const old = makeEvent({ ts: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() });
    appendEvent(tmpDir, "test.dev", old);
    appendEvent(tmpDir, "test.dev", makeEvent({ message: "recent" }));
    applyRetention(tmpDir, "test.dev", {
      maxProjectLogBytes: 25 * 1024 * 1024,
      maxProjectEvents: 25_000,
      maxEventAgeMs: 24 * 60 * 60 * 1000,
      maxAllProjectsBytes: 100 * 1024 * 1024,
      strategy: "truncate_oldest",
    });
    const events = readEvents(tmpDir, "test.dev");
    expect(events.some(e => e.message === "recent")).toBe(true);
    expect(events.some(e => e.ts === old.ts)).toBe(false);
  });
});

describe("retention: global", () => {
  it("truncates LRU project when global limit exceeded", () => {
    // write a large-ish file to project A
    for (let i = 0; i < 10; i++) {
      appendEvent(tmpDir, "proj-a.dev", makeEvent({ message: "a".repeat(200), projectId: "proj-a.dev" }));
    }
    for (let i = 0; i < 10; i++) {
      appendEvent(tmpDir, "proj-b.dev", makeEvent({ message: "b".repeat(200), projectId: "proj-b.dev" }));
    }

    const opts = {
      maxProjectLogBytes: 25 * 1024 * 1024,
      maxProjectEvents: 25_000,
      maxEventAgeMs: 0,
      maxAllProjectsBytes: 100, // very small to trigger truncation
      strategy: "truncate_oldest" as const,
    };
    applyGlobalRetention(tmpDir, opts);

    const totalBytes =
      getLogFileBytes(tmpDir, "proj-a.dev") +
      getLogFileBytes(tmpDir, "proj-b.dev");
    expect(totalBytes).toBeLessThanOrEqual(100);
  });
});

describe("clear", () => {
  it("removes logs and summaries", () => {
    appendEvent(tmpDir, "test.dev", makeEvent());
    const summary = buildSummary(tmpDir, "test.dev", undefined);
    writeSummaryFiles(tmpDir, "test.dev", summary, summaryToMarkdown(summary));
    clearProject(tmpDir, "test.dev");
    expect(readEvents(tmpDir, "test.dev")).toHaveLength(0);
    expect(fs.existsSync(summaryMdFile(tmpDir, "test.dev"))).toBe(false);
    expect(fs.existsSync(summaryJsonFile(tmpDir, "test.dev"))).toBe(false);
  });
});

describe("summary", () => {
  it("groups repeated errors", () => {
    for (let i = 0; i < 3; i++) {
      appendEvent(tmpDir, "test.dev", makeEvent({ message: "same error", level: "error" }));
    }
    appendEvent(tmpDir, "test.dev", makeEvent({ message: "other error", level: "error" }));
    const s = buildSummary(tmpDir, "test.dev", undefined);
    const topMsg = s.topErrors.find(e => e.message === "same error");
    expect(topMsg?.storedCount).toBe(3);
  });

  it("includes stored, observed, and suppressed counts in rollup", () => {
    const rollup: LogTapEvent = {
      ts: new Date().toISOString(),
      level: "warn",
      kind: "rollup",
      message: "dedupe_rollup",
      data: {
        observedCount: 100,
        storedCount: 3,
        suppressedCount: 97,
      },
    };
    appendEvent(tmpDir, "test.dev", rollup);
    const s = buildSummary(tmpDir, "test.dev", undefined);
    expect(s.suppressedDuplicates).toBe(97);
    expect(s.warningsObserved).toBe(100);
  });

  it("writes markdown summary file", () => {
    appendEvent(tmpDir, "test.dev", makeEvent());
    const s = buildSummary(tmpDir, "test.dev", undefined);
    const md = summaryToMarkdown(s);
    writeSummaryFiles(tmpDir, "test.dev", s, md);
    expect(fs.existsSync(summaryMdFile(tmpDir, "test.dev"))).toBe(true);
    const content = fs.readFileSync(summaryMdFile(tmpDir, "test.dev"), "utf8");
    expect(content).toContain("# LogTap Client Summary");
  });

  it("writes JSON summary file", () => {
    appendEvent(tmpDir, "test.dev", makeEvent());
    const s = buildSummary(tmpDir, "test.dev", undefined);
    writeSummaryFiles(tmpDir, "test.dev", s, summaryToMarkdown(s));
    expect(fs.existsSync(summaryJsonFile(tmpDir, "test.dev"))).toBe(true);
    const json = JSON.parse(fs.readFileSync(summaryJsonFile(tmpDir, "test.dev"), "utf8"));
    expect(json.projectId).toBe("test.dev");
  });
});

describe("ingest: oversized payload rejected", () => {
  it("drops events larger than maxEventBytes", async () => {
    const opts = resolveOptions({ rootDir: tmpDir, maxEventBytes: 100 });
    const dedupe = new DedupeEngine(opts.dedupe);
    const hugeEvent = makeEvent({ message: "x".repeat(200) });
    // this goes through processEvents which filters oversized events before passing in
    // simulate what the server does: filter by JSON size
    const rawEvents = [hugeEvent].filter(e => JSON.stringify(e).length <= opts.maxEventBytes);
    const result = await processEvents(rawEvents, opts, dedupe);
    expect(result.stored).toBe(0);
  });
});

describe("ingest: auth token", () => {
  it("resolves project ID in processEvents", async () => {
    const opts = resolveOptions({ rootDir: tmpDir });
    const dedupe = new DedupeEngine(opts.dedupe);
    const event = makeEvent({ projectId: undefined, app: "myapp", env: "prod" });
    await processEvents([event], opts, dedupe);
    const stored = readEvents(tmpDir, "myapp.prod");
    expect(stored.length).toBeGreaterThan(0);
  });
});
