import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Window } from "happy-dom";
import { createBrowserTap } from "../src/browser/index.ts";
import { BreadcrumbBuffer } from "../src/browser/breadcrumbs.ts";
import { patchConsole } from "../src/browser/console.ts";
import { attachErrorListeners } from "../src/browser/errors.ts";
import { patchFetch } from "../src/browser/network.ts";
import type { LogTapEvent } from "../src/shared/types.ts";

if (typeof window === "undefined") {
  const win = new Window({ url: "http://localhost/" }) as unknown as Window & typeof globalThis;
  globalThis.window = win.window as Window & typeof globalThis.window;
  globalThis.document = win.document;
  globalThis.location = win.location;
  globalThis.history = win.history;
  globalThis.navigator = win.navigator;
  globalThis.ErrorEvent = win.ErrorEvent;
  globalThis.PromiseRejectionEvent = win.PromiseRejectionEvent;
  globalThis.window.fetch = globalThis.fetch.bind(globalThis) as typeof globalThis.window.fetch;
}

const captured: LogTapEvent[] = [];

let originalFetch: typeof globalThis.fetch;
let originalWindowFetch: typeof window.fetch;
let originalSendBeacon: typeof navigator.sendBeacon;
let originalConsoleWarn: typeof console.warn;
let originalConsoleError: typeof console.error;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalWindowFetch = window.fetch;
  originalSendBeacon = navigator.sendBeacon;
  originalConsoleWarn = console.warn;
  originalConsoleError = console.error;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.fetch = originalWindowFetch;
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: originalSendBeacon,
  });
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
});

function makeOptions() {
  return {
    endpoint: "http://localhost:4319/__logtap/ingest",
    app: "test-app",
    env: "test",
  };
}

describe("BreadcrumbBuffer", () => {
  it("caps at max length", () => {
    const buf = new BreadcrumbBuffer(3);
    buf.add("a");
    buf.add("b");
    buf.add("c");
    buf.add("d"); // should evict "a"
    const all = buf.getAll();
    expect(all).toHaveLength(3);
    expect(all[0]?.name).toBe("b");
    expect(all[2]?.name).toBe("d");
  });

  it("getAll returns copy", () => {
    const buf = new BreadcrumbBuffer(10);
    buf.add("x");
    const a = buf.getAll();
    const b = buf.getAll();
    expect(a).not.toBe(b);
  });
});

describe("patchConsole", () => {
  it("calls original console.warn", () => {
    const original = vi.fn();
    const origWarn = console.warn;
    console.warn = original;

    const events: LogTapEvent[] = [];
    const unpatch = patchConsole({ onEvent: e => events.push(e) });
    console.warn("hello");
    unpatch();
    console.warn = origWarn;

    expect(original).toHaveBeenCalledWith("hello");
  });

  it("calls original console.error", () => {
    const original = vi.fn();
    const origError = console.error;
    console.error = original;

    const events: LogTapEvent[] = [];
    const unpatch = patchConsole({ onEvent: e => events.push(e) });
    console.error("err");
    unpatch();
    console.error = origError;

    expect(original).toHaveBeenCalledWith("err");
  });

  it("produces a warn event", () => {
    const origWarn = console.warn;
    const events: LogTapEvent[] = [];
    const unpatch = patchConsole({ onEvent: e => events.push(e) });
    console.warn("test warning");
    unpatch();
    console.warn = origWarn;

    expect(events.some(e => e.level === "warn" && e.message.includes("test warning"))).toBe(true);
  });

  it("produces an error event", () => {
    const origError = console.error;
    const events: LogTapEvent[] = [];
    const unpatch = patchConsole({ onEvent: e => events.push(e) });
    console.error("test error");
    unpatch();
    console.error = origError;

    expect(events.some(e => e.level === "error")).toBe(true);
  });
});

describe("attachErrorListeners", () => {
  it("captures error events from window", () => {
    const events: LogTapEvent[] = [];
    const detach = attachErrorListeners({
      getBreadcrumbs: () => [],
      onEvent: e => events.push(e),
    });

    const errorEvent = new ErrorEvent("error", {
      message: "something broke",
      error: new Error("something broke"),
    });
    window.dispatchEvent(errorEvent);
    detach();

    expect(events.some(e => e.kind === "exception" && e.message === "something broke")).toBe(true);
  });

  it("captures unhandled rejection events", () => {
    if (typeof PromiseRejectionEvent === "undefined") {
      // happy-dom does not implement PromiseRejectionEvent; skip gracefully
      return;
    }
    const events: LogTapEvent[] = [];
    const detach = attachErrorListeners({
      getBreadcrumbs: () => [],
      onEvent: e => events.push(e),
    });

    const rejEvent = new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.reject("oops"),
      reason: new Error("rejected"),
    });
    window.dispatchEvent(rejEvent);
    detach();

    expect(events.some(e => e.kind === "unhandledrejection")).toBe(true);
  });
});

describe("patchFetch", () => {
  it("captures 500 responses", async () => {
    const originalFetch = window.fetch;
    const events: LogTapEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 })) as unknown as typeof window.fetch;

    const unpatch = patchFetch({
      getBreadcrumbs: () => [],
      onEvent: e => events.push(e),
    });

    await window.fetch("http://api.test/fail?token=abc");
    unpatch();
    window.fetch = originalFetch;

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("network");
    expect(events[0]?.network?.url).toBe("http://api.test/fail?token=[REDACTED]");
  });

  it("captures thrown network errors", async () => {
    const originalFetch = window.fetch;
    const events: LogTapEvent[] = [];
    window.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof window.fetch;

    const unpatch = patchFetch({
      getBreadcrumbs: () => [],
      onEvent: e => events.push(e),
    });

    await expect(window.fetch("http://api.test/fail")).rejects.toThrow("offline");
    unpatch();
    window.fetch = originalFetch;

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("network");
    expect(events[0]?.message).toContain("fetch failed");
  });

  it("does not capture LogTap transport endpoint failures", async () => {
    const originalFetch = window.fetch;
    const events: LogTapEvent[] = [];
    window.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 })) as unknown as typeof window.fetch;

    const unpatch = patchFetch({
      getBreadcrumbs: () => [],
      ignoreUrls: ["http://localhost:4319/__logtap/ingest"],
      onEvent: e => events.push(e),
    });

    await window.fetch("http://localhost:4319/__logtap/ingest");
    unpatch();
    window.fetch = originalFetch;

    expect(events).toHaveLength(0);
  });
});

describe("disabled BrowserTap", () => {
  it("sends nothing when enabled=false", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const tap = createBrowserTap({ ...makeOptions(), enabled: false });
    tap.error("should not send");
    await tap.flush();
    tap.stop();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("standalone breadcrumbs not sent by default", () => {
  it("breadcrumb() does not enqueue a network event", async () => {
    const sent: LogTapEvent[] = [];
    const fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      if (typeof body === "string") {
        const parsed = JSON.parse(body) as { events: LogTapEvent[] };
        sent.push(...parsed.events);
      }
      return new Response(null, { status: 204 });
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const tap = createBrowserTap({
      ...makeOptions(),
      captureConsole: false,
      captureErrors: false,
      captureNetwork: false,
    });
    tap.breadcrumb("test_crumb", { x: 1 });
    await tap.flush();
    tap.stop();

    // breadcrumb itself should not appear as a sent event
    expect(sent.every(e => e.kind !== "breadcrumb")).toBe(true);
  });
});

describe("client dedupe rollups", () => {
  it("sends duplicate counts as rollup events", async () => {
    const sent: LogTapEvent[] = [];
    const originalSendBeacon = navigator.sendBeacon;
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: undefined,
    });
    const fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      if (typeof body === "string") {
        const parsed = JSON.parse(body) as { events: LogTapEvent[] };
        sent.push(...parsed.events);
      }
      return new Response(null, { status: 204 });
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const tap = createBrowserTap({
      ...makeOptions(),
      captureConsole: false,
      captureErrors: false,
      captureNetwork: false,
      clientRollupIntervalMs: 60_000,
    });

    for (let i = 0; i < 5; i++) {
      tap.warn("same render warning");
    }
    await tap.flush();
    tap.stop();

    const rollup = sent.find(e => e.kind === "rollup");
    expect(sent.filter(e => e.kind === "manual")).toHaveLength(1);
    expect(rollup?.message).toBe("client_dedupe_rollup");
    expect((rollup?.data as Record<string, number>)?.["suppressedCount"]).toBe(4);
    expect((rollup?.data as Record<string, number>)?.["observedCount"]).toBe(5);

    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: originalSendBeacon,
    });
  });
});
