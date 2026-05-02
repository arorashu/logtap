import type { LogTapEvent, LogTapLevel, LogTapKind } from "./types.ts";

const VALID_LEVELS = new Set<LogTapLevel>(["debug", "info", "warn", "error"]);
const VALID_KINDS = new Set<LogTapKind>([
  "console", "exception", "unhandledrejection", "network", "breadcrumb", "manual", "rollup",
]);

export function isValidEvent(raw: unknown): raw is LogTapEvent {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e["message"] === "string" &&
    e["message"].length > 0 &&
    VALID_LEVELS.has(e["level"] as LogTapLevel) &&
    VALID_KINDS.has(e["kind"] as LogTapKind)
  );
}

export function coerceEvent(raw: Record<string, unknown>): LogTapEvent {
  const now = new Date().toISOString();
  return {
    ts: typeof raw["ts"] === "string" ? raw["ts"] : now,
    level: raw["level"] as LogTapLevel,
    kind: raw["kind"] as LogTapKind,
    message: raw["message"] as string,
    app: typeof raw["app"] === "string" ? raw["app"] : undefined,
    env: typeof raw["env"] === "string" ? raw["env"] : undefined,
    projectId: typeof raw["projectId"] === "string" ? raw["projectId"] : undefined,
    sessionId: typeof raw["sessionId"] === "string" ? raw["sessionId"] : undefined,
    userId: typeof raw["userId"] === "string" ? raw["userId"] : undefined,
    buildSha: typeof raw["buildSha"] === "string" ? raw["buildSha"] : undefined,
    release: typeof raw["release"] === "string" ? raw["release"] : undefined,
    url: typeof raw["url"] === "string" ? raw["url"] : undefined,
    route: typeof raw["route"] === "string" ? raw["route"] : undefined,
    stack: typeof raw["stack"] === "string" ? raw["stack"] : undefined,
    stackMapped: typeof raw["stackMapped"] === "string" ? raw["stackMapped"] : undefined,
    sourceMapStatus: raw["sourceMapStatus"] as LogTapEvent["sourceMapStatus"] | undefined,
    fingerprint: typeof raw["fingerprint"] === "string" ? raw["fingerprint"] : undefined,
    data: raw["data"] && typeof raw["data"] === "object" && !Array.isArray(raw["data"])
      ? raw["data"] as Record<string, unknown>
      : undefined,
    network: raw["network"] && typeof raw["network"] === "object"
      ? raw["network"] as LogTapEvent["network"]
      : undefined,
    breadcrumbs: Array.isArray(raw["breadcrumbs"])
      ? raw["breadcrumbs"] as LogTapEvent["breadcrumbs"]
      : undefined,
  };
}
