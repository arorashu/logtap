import { readEvents } from "./store.ts";
import { sinceToStartMs } from "../shared/time.ts";
import type { LogTapEvent, LogTapLevel, LogTapKind } from "../shared/types.ts";

export type QueryParams = {
  project: string;
  level?: LogTapLevel;
  kind?: LogTapKind;
  since?: string;
  route?: string;
  fingerprint?: string;
};

export function query(rootDir: string, params: QueryParams): LogTapEvent[] {
  const events = readEvents(rootDir, params.project);
  const now = Date.now();
  const startMs = sinceToStartMs(params.since, now);

  return events.filter(e => {
    if (params.level && e.level !== params.level) return false;
    if (params.kind && e.kind !== params.kind) return false;
    if (params.route && e.route !== params.route) return false;
    if (params.fingerprint && e.fingerprint !== params.fingerprint) return false;
    if (startMs > 0) {
      const ts = new Date(e.ts).getTime();
      if (ts < startMs) return false;
    }
    return true;
  });
}
