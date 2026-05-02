import type { LogTapEvent } from "./types.ts";

export function resolveProjectId(event: LogTapEvent): string {
  if (event.projectId) return sanitizeProjectId(event.projectId);
  if (event.app && event.env) return sanitizeProjectId(`${event.app}.${event.env}`);
  if (event.app) return sanitizeProjectId(`${event.app}.dev`);
  return "default.dev";
}

export function sanitizeProjectId(id: string): string {
  return id
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 128);
}
