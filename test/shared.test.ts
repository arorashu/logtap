import { describe, it, expect } from "vitest";
import { normalizeMessage, normalizeUrl, topStackFrame } from "../src/shared/normalize.ts";
import { fingerprint } from "../src/shared/fingerprint.ts";
import { resolveProjectId, sanitizeProjectId } from "../src/shared/project.ts";
import { parseBytes, formatBytes } from "../src/shared/bytes.ts";
import { parseDuration } from "../src/shared/time.ts";
import type { LogTapEvent } from "../src/shared/types.ts";
import { buildRedactor } from "../src/server/redact.ts";

describe("normalizeMessage", () => {
  it("replaces hex hashes", () => {
    expect(normalizeMessage("id=deadbeef123456")).toBe("id=<hash>");
  });

  it("replaces numbers", () => {
    expect(normalizeMessage("line 42 col 7")).toBe("line <num> col <num>");
  });

  it("replaces urls", () => {
    expect(normalizeMessage("see https://example.com/path?q=1")).toBe("see <url>");
  });

  it("replaces uuid values", () => {
    expect(normalizeMessage("uuid: a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe("uuid=<uuid>");
  });
});

describe("normalizeUrl", () => {
  it("redacts sensitive query params", () => {
    const u = normalizeUrl("https://api.example.com/v1?token=abc123&q=hello");
    expect(u).toContain("token=[REDACTED]");
    expect(u).toContain("q=hello");
  });

  it("normalizes path IDs", () => {
    const u = normalizeUrl("https://api.example.com/users/123/profile");
    expect(u).toContain("/<id>/profile");
  });

  it("handles invalid URLs gracefully", () => {
    expect(() => normalizeUrl("not a url")).not.toThrow();
  });

  it("returns empty string for empty input", () => {
    expect(normalizeUrl("")).toBe("");
  });
});

describe("topStackFrame", () => {
  it("returns first at-frame", () => {
    const stack = `Error: oops\n    at foo (src/foo.ts:10:5)\n    at bar (src/bar.ts:20:3)`;
    expect(topStackFrame(stack)).toBe("at foo (src/foo.ts:10:5)");
  });

  it("returns empty string for undefined", () => {
    expect(topStackFrame(undefined)).toBe("");
  });
});

describe("fingerprint", () => {
  it("is stable for identical events", () => {
    const e: LogTapEvent = {
      ts: "2024-01-01T00:00:00Z",
      level: "error",
      kind: "exception",
      message: "Cannot read property of undefined",
      stack: "    at foo (app.js:10:5)",
      route: "/checkout",
    };
    expect(fingerprint(e)).toBe(fingerprint({ ...e, ts: "2024-02-01T00:00:00Z" }));
  });

  it("differs for different messages", () => {
    const base: LogTapEvent = { ts: "", level: "error", kind: "console", message: "foo" };
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, message: "bar" }));
  });

  it("differs for different levels", () => {
    const base: LogTapEvent = { ts: "", level: "error", kind: "console", message: "oops" };
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, level: "warn" }));
  });
});

describe("resolveProjectId", () => {
  it("uses projectId if provided", () => {
    expect(resolveProjectId({ ts: "", level: "error", kind: "console", message: "x", projectId: "my-project" })).toBe("my-project");
  });

  it("uses app.env if no projectId", () => {
    expect(resolveProjectId({ ts: "", level: "error", kind: "console", message: "x", app: "billing", env: "staging" })).toBe("billing.staging");
  });

  it("uses app.dev if only app", () => {
    expect(resolveProjectId({ ts: "", level: "error", kind: "console", message: "x", app: "billing" })).toBe("billing.dev");
  });

  it("falls back to default.dev", () => {
    expect(resolveProjectId({ ts: "", level: "error", kind: "console", message: "x" })).toBe("default.dev");
  });
});

describe("sanitizeProjectId", () => {
  it("replaces unsafe characters", () => {
    expect(sanitizeProjectId("my app/v1")).toBe("my_app_v1");
  });

  it("allows dots, dashes, underscores", () => {
    expect(sanitizeProjectId("billing-ui.dev_test")).toBe("billing-ui.dev_test");
  });

  it("truncates at 128 chars", () => {
    const long = "a".repeat(200);
    expect(sanitizeProjectId(long).length).toBe(128);
  });
});

describe("parseBytes", () => {
  it("parses MB", () => expect(parseBytes("25mb")).toBe(25 * 1024 * 1024));
  it("parses KB", () => expect(parseBytes("64kb")).toBe(64 * 1024));
  it("parses raw numbers", () => expect(parseBytes("1024")).toBe(1024));
});

describe("formatBytes", () => {
  it("formats MB", () => expect(formatBytes(25 * 1024 * 1024)).toBe("25.0MB"));
  it("formats KB", () => expect(formatBytes(1024)).toBe("1.0KB"));
});

describe("parseDuration", () => {
  it("parses minutes", () => expect(parseDuration("15m")).toBe(15 * 60_000));
  it("parses hours", () => expect(parseDuration("1h")).toBe(3_600_000));
  it("parses seconds", () => expect(parseDuration("30s")).toBe(30_000));
  it("throws on invalid", () => expect(() => parseDuration("bad")).toThrow());
});

describe("redaction", () => {
  const redact = buildRedactor([]);

  it("redacts nested token fields", () => {
    const obj = { user: { token: "secret123", name: "Alice" } };
    const result = redact(obj) as Record<string, Record<string, string>>;
    expect(result["user"]?.["token"]).toBe("[REDACTED]");
    expect(result["user"]?.["name"]).toBe("Alice");
  });

  it("redacts password at any depth", () => {
    const obj = { a: { b: { password: "hunter2" } } };
    const result = redact(obj) as { a: { b: { password: string } } };
    expect(result.a.b.password).toBe("[REDACTED]");
  });

  it("redacts cookie", () => {
    const result = redact({ cookie: "session=abc" }) as Record<string, string>;
    expect(result["cookie"]).toBe("[REDACTED]");
  });

  it("does not redact unrelated fields", () => {
    const result = redact({ userId: "u123", message: "hello" }) as Record<string, string>;
    expect(result["userId"]).toBe("u123");
  });

  it("handles arrays", () => {
    const result = redact([{ token: "x" }, { token: "y" }]) as Array<Record<string, string>>;
    expect(result[0]?.["token"]).toBe("[REDACTED]");
    expect(result[1]?.["token"]).toBe("[REDACTED]");
  });

  it("redacts URL query params", () => {
    const result = normalizeUrl("https://api.example.com/?token=abc&code=123");
    expect(result).toContain("token=[REDACTED]");
    expect(result).toContain("code=[REDACTED]");
  });

  it("redacts url fields recursively", () => {
    const result = redact({
      url: "http://x.test/path?token=abc&ok=1",
      network: {
        url: "http://api.test/users/123?session=secret&ok=1",
      },
    }) as { url: string; network: { url: string } };

    expect(result.url).toBe("http://x.test/path?token=[REDACTED]&ok=1");
    expect(result.network.url).toBe("http://api.test/users/<id>?session=[REDACTED]&ok=1");
  });
});
