import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createBrowserTap } from "../src/browser/index.ts";
import { createLogTapServer, type LogTapServer } from "../src/server/index.ts";
import { readEvents, summaryMdFile } from "../src/server/store.ts";
import type { LogTapEvent, ProjectSummaryJson } from "../src/shared/types.ts";

let tmpDir: string;
let server: LogTapServer | undefined;
let originalSendBeacon: typeof navigator.sendBeacon | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logtap-e2e-"));
  originalSendBeacon = navigator.sendBeacon;
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: undefined,
  });
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: originalSendBeacon,
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("client POV e2e", () => {
  it("sends browser rollups through HTTP and writes honest summaries", async () => {
    const port = 45_000 + Math.floor(Math.random() * 10_000);
    server = createLogTapServer({
      port,
      host: "127.0.0.1",
      rootDir: tmpDir,
      corsOrigins: ["*"],
    });
    await server.start();

    const tap = createBrowserTap({
      endpoint: `http://127.0.0.1:${port}/__logtap/ingest`,
      app: "client-pov",
      env: "test",
      captureConsole: false,
      captureErrors: false,
      captureNetwork: false,
      clientRollupIntervalMs: 60_000,
    });

    for (let i = 0; i < 5; i++) {
      tap.warn("mithril render loop warning", { component: "InvoiceTable" });
    }
    await tap.flush();
    tap.stop();

    const events = readEvents(tmpDir, "client-pov.test");
    expect(events.filter(e => e.kind === "manual")).toHaveLength(1);
    expect(events.filter(e => e.kind === "rollup")).toHaveLength(1);

    const summaryRes = await fetch(`http://127.0.0.1:${port}/__logtap/summary?project=client-pov.test`);
    expect(summaryRes.status).toBe(200);
    const summary = await summaryRes.json() as ProjectSummaryJson;

    expect(summary.warningsStored).toBe(1);
    expect(summary.warningsObserved).toBe(5);
    expect(summary.suppressedDuplicates).toBe(4);
    expect(summary.topErrors[0]?.message).toBe("mithril render loop warning");
    expect(summary.topErrors[0]?.storedCount).toBe(1);
    expect(summary.topErrors[0]?.observedCount).toBe(5);
    expect(summary.topErrors[0]?.suppressedCount).toBe(4);
    expect(fs.existsSync(summaryMdFile(tmpDir, "client-pov.test"))).toBe(true);
  });

  it("keeps the original fingerprint when client rollups are ingested", async () => {
    const port = 45_000 + Math.floor(Math.random() * 10_000);
    server = createLogTapServer({
      port,
      host: "127.0.0.1",
      rootDir: tmpDir,
      corsOrigins: ["*"],
    });
    await server.start();

    const event: LogTapEvent = {
      ts: new Date().toISOString(),
      level: "warn",
      kind: "rollup",
      message: "client_dedupe_rollup",
      app: "client-pov",
      env: "test",
      fingerprint: "console|warn|same warning|||||",
      data: {
        observedCount: 20,
        storedCount: 1,
        suppressedCount: 19,
        exemplarMessage: "same warning",
        exemplarKind: "console",
      },
    };

    const res = await fetch(`http://127.0.0.1:${port}/__logtap/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [event] }),
    });
    expect(res.status).toBe(204);

    const events = readEvents(tmpDir, "client-pov.test");
    expect(events[0]?.fingerprint).toBe("console|warn|same warning|||||");
  });
});
