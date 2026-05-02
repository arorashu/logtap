import { readEvents } from "./store.ts";
import type { LogTapEvent } from "../shared/types.ts";

export function tail(rootDir: string, projectId: string, n: number): LogTapEvent[] {
  const events = readEvents(rootDir, projectId);
  const capped = Math.min(n, 1000);
  return events.slice(-capped);
}
