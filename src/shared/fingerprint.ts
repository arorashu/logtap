import type { LogTapEvent } from "./types.ts";
import { normalizeMessage, normalizeUrl, topStackFrame } from "./normalize.ts";

export function fingerprint(e: LogTapEvent): string {
  return [
    e.kind,
    e.level,
    normalizeMessage(e.message),
    topStackFrame(e.stackMapped ?? e.stack),
    e.route ?? "",
    e.network?.method ?? "",
    normalizeUrl(e.network?.url ?? ""),
    e.network?.status ?? "",
  ].join("|");
}
