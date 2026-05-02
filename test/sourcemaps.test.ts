import { describe, it, expect } from "vitest";
import { enrichWithSourceMaps } from "../src/server/sourcemaps.ts";
import type { LogTapEvent } from "../src/shared/types.ts";

function makeEvent(overrides: Partial<LogTapEvent> = {}): LogTapEvent {
  return {
    ts: new Date().toISOString(),
    level: "error",
    kind: "exception",
    message: "Test error",
    stack: "Error: test\n    at foo (app.abc123.js:1:100)",
    ...overrides,
  };
}

describe("sourcemaps", () => {
  it("disabled sourcemaps sets sourceMapStatus to not_needed", async () => {
    const event = makeEvent();
    const result = await enrichWithSourceMaps(event, "/nonexistent", { enabled: false });
    expect(result.sourceMapStatus).toBe("not_needed");
    expect(result.stackMapped).toBeUndefined();
  });

  it("missing map file sets sourceMapStatus to missing or unavailable", async () => {
    const event = makeEvent();
    const result = await enrichWithSourceMaps(event, "/nonexistent/assets", { enabled: true });
    // either missing (lib present) or missing (lib unavailable — returns missing too)
    expect(["missing", "not_needed"]).toContain(result.sourceMapStatus);
  });

  it("event without stack sets sourceMapStatus to not_needed", async () => {
    const event = makeEvent({ stack: undefined });
    const result = await enrichWithSourceMaps(event, "/nonexistent", { enabled: true });
    expect(result.sourceMapStatus).toBe("not_needed");
  });

  it("never fails ingestion even when map resolution throws", async () => {
    const event = makeEvent();
    await expect(
      enrichWithSourceMaps(event, "/nonexistent", { enabled: true })
    ).resolves.toBeDefined();
  });
});
