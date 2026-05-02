import { describe, it, expect, vi, beforeEach } from "vitest";
import { DedupeEngine } from "../src/server/dedupe.ts";
import { fingerprint } from "../src/shared/fingerprint.ts";
import type { LogTapEvent } from "../src/shared/types.ts";

function makeEvent(overrides: Partial<LogTapEvent> = {}): LogTapEvent {
  return {
    ts: new Date().toISOString(),
    level: "error",
    kind: "exception",
    message: "Test error",
    ...overrides,
  };
}

describe("DedupeEngine", () => {
  let engine: DedupeEngine;

  beforeEach(() => {
    engine = new DedupeEngine({
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
    });
  });

  it("stores first occurrence", () => {
    const event = makeEvent();
    expect(engine.shouldStore(event, "test.dev")).toBe(true);
  });

  it("suppresses repeated event within min interval", () => {
    const event = makeEvent();
    engine.shouldStore(event, "test.dev"); // first — stored
    expect(engine.shouldStore(event, "test.dev")).toBe(false); // second — suppressed
  });

  it("stores again at count threshold", () => {
    const event = makeEvent();
    engine.shouldStore(event, "test.dev"); // count 1 — stored

    // advance to count 10
    for (let i = 0; i < 8; i++) {
      engine.shouldStore(event, "test.dev"); // counts 2-9 — suppressed
    }
    const result = engine.shouldStore(event, "test.dev"); // count 10 — stored
    expect(result).toBe(true);
  });

  it("stores again after min interval has elapsed", () => {
    vi.useFakeTimers();
    const event = makeEvent({ level: "error" });
    engine.shouldStore(event, "test.dev");
    vi.advanceTimersByTime(11_000); // past 10s error interval
    expect(engine.shouldStore(event, "test.dev")).toBe(true);
    vi.useRealTimers();
  });

  it("uses network min interval for network errors", () => {
    vi.useFakeTimers();
    const event = makeEvent({
      level: "error",
      kind: "network",
      network: { method: "GET", url: "http://api.test/fail", status: 500 },
    });

    engine.shouldStore(event, "test.dev");
    vi.advanceTimersByTime(11_000);
    expect(engine.shouldStore(event, "test.dev")).toBe(false);
    vi.advanceTimersByTime(20_000);
    expect(engine.shouldStore(event, "test.dev")).toBe(true);
    vi.useRealTimers();
  });

  it("rollup event includes suppressed count", () => {
    const event = makeEvent({ level: "warn" });
    engine.shouldStore(event, "test.dev"); // stored
    engine.shouldStore(event, "test.dev"); // suppressed
    engine.shouldStore(event, "test.dev"); // suppressed

    const fp = event.fingerprint ?? fingerprint(event);
    const bucket = engine.getBucket("test.dev", fp);
    expect(bucket?.suppressedCount).toBeGreaterThan(0);
  });

  it("getRollups returns rollup events for suppressed duplicates", () => {
    vi.useFakeTimers();
    const event = makeEvent({ level: "warn" });
    engine.shouldStore(event, "test.dev");
    engine.shouldStore(event, "test.dev");
    engine.shouldStore(event, "test.dev");

    // advance past rollup window for "recent" check
    vi.advanceTimersByTime(30_000);

    const rollups = engine.getRollups("test.dev");
    expect(rollups.length).toBeGreaterThan(0);
    expect(rollups[0]?.kind).toBe("rollup");
    expect((rollups[0]?.data as Record<string, number>)?.["suppressedCount"]).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("summary reflects rollup counts via suppressedCount in bucket", () => {
    const event = makeEvent();
    engine.shouldStore(event, "test.dev"); // 1st
    engine.shouldStore(event, "test.dev"); // suppressed
    engine.shouldStore(event, "test.dev"); // suppressed

    const fp = event.fingerprint ?? fingerprint(event);
    const bucket = engine.getBucket("test.dev", fp);
    expect(bucket?.suppressedCount).toBe(2);
    expect(bucket?.observedCount).toBe(3);
    expect(bucket?.storedCount).toBe(1);
  });
});
