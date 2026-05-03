import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import { createBrowserTap } from "../src/browser/index.ts";
import { createLogTapServer, type LogTapServer } from "../src/server/index.ts";
import { readEvents, summaryMdFile } from "../src/server/store.ts";
import type { LogTapEvent, ProjectSummaryJson } from "../src/shared/types.ts";

type ServerFixture = {
  port: number;
  rootDir: string;
  server: LogTapServer;
};

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        socket.close(() => reject(new Error("failed to allocate a test port")));
        return;
      }
      const { port } = address;
      socket.close(() => resolve(port));
    });
  });
}

async function withLogTapServer<T>(run: (fixture: ServerFixture) => Promise<T>): Promise<T> {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "logtap-e2e-"));
  const port = await getFreePort();
  const server = createLogTapServer({
    port,
    host: "127.0.0.1",
    rootDir,
    corsOrigins: ["*"],
  });

  await server.start();
  try {
    return await run({ port, rootDir, server });
  } finally {
    await server.stop();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

async function withoutSendBeacon<T>(run: () => Promise<T>): Promise<T> {
  const originalSendBeacon = navigator.sendBeacon;
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: undefined,
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: originalSendBeacon,
    });
  }
}

describe("client POV e2e", () => {
  it("sends browser rollups through HTTP and writes honest summaries", async () => {
    await withoutSendBeacon(() => withLogTapServer(async ({ port, rootDir }) => {
      const tap = createBrowserTap({
        endpoint: `http://127.0.0.1:${port}/__logtap/ingest`,
        app: "client-pov",
        env: "test",
        captureConsole: false,
        captureErrors: false,
        captureNetwork: false,
        clientRollupIntervalMs: 60_000,
      });

      try {
        for (let i = 0; i < 5; i++) {
          tap.warn("mithril render loop warning", { component: "InvoiceTable" });
        }
        await tap.flush();

        const events = readEvents(rootDir, "client-pov.test");
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
        expect(fs.existsSync(summaryMdFile(rootDir, "client-pov.test"))).toBe(true);
      } finally {
        tap.stop();
      }
    }));
  });

  it("keeps the original fingerprint when client rollups are ingested", async () => {
    await withLogTapServer(async ({ port, rootDir }) => {
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

      const events = readEvents(rootDir, "client-pov.test");
      expect(events[0]?.fingerprint).toBe("console|warn|same warning|||||");
    });
  });
});
