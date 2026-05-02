import * as fs from "node:fs";
import * as path from "node:path";
import type { LogTapEvent, RetentionOptions } from "../shared/types.ts";

export function projectDir(rootDir: string, projectId: string): string {
  return path.join(rootDir, "projects", projectId);
}

export function logFile(rootDir: string, projectId: string): string {
  return path.join(projectDir(rootDir, projectId), "logs", "client.jsonl");
}

export function summaryMdFile(rootDir: string, projectId: string): string {
  return path.join(projectDir(rootDir, projectId), "summaries", "latest.md");
}

export function summaryJsonFile(rootDir: string, projectId: string): string {
  return path.join(projectDir(rootDir, projectId), "summaries", "latest.json");
}

export function ensureProjectDirs(rootDir: string, projectId: string): void {
  const base = projectDir(rootDir, projectId);
  fs.mkdirSync(path.join(base, "logs"), { recursive: true });
  fs.mkdirSync(path.join(base, "summaries"), { recursive: true });
  fs.mkdirSync(path.join(base, "artifacts"), { recursive: true });
}

export function appendEvent(rootDir: string, projectId: string, event: LogTapEvent): void {
  ensureProjectDirs(rootDir, projectId);
  const file = logFile(rootDir, projectId);
  fs.appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
}

export function readEvents(rootDir: string, projectId: string): LogTapEvent[] {
  const file = logFile(rootDir, projectId);
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, "utf8");
  const events: LogTapEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as LogTapEvent);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

export function getLogFileBytes(rootDir: string, projectId: string): number {
  const file = logFile(rootDir, projectId);
  if (!fs.existsSync(file)) return 0;
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function clearProject(rootDir: string, projectId: string): void {
  const file = logFile(rootDir, projectId);
  if (fs.existsSync(file)) fs.writeFileSync(file, "", "utf8");
  const mdFile = summaryMdFile(rootDir, projectId);
  if (fs.existsSync(mdFile)) fs.unlinkSync(mdFile);
  const jsonFile = summaryJsonFile(rootDir, projectId);
  if (fs.existsSync(jsonFile)) fs.unlinkSync(jsonFile);
}

export function listProjectIds(rootDir: string): string[] {
  const dir = path.join(rootDir, "projects");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => {
    return fs.statSync(path.join(dir, name)).isDirectory();
  });
}

export function applyRetention(
  rootDir: string,
  projectId: string,
  opts: RetentionOptions,
): void {
  const file = logFile(rootDir, projectId);
  if (!fs.existsSync(file)) return;

  const content = fs.readFileSync(file, "utf8");
  const lines = content.split("\n").filter(l => l.trim());
  if (lines.length === 0) return;

  const now = Date.now();
  const maxAge = opts.maxEventAgeMs;

  // parse and filter by age
  type Parsed = { line: string; ts: number };
  const parsed: Parsed[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as { ts?: string };
      const ts = e.ts ? new Date(e.ts).getTime() : 0;
      if (maxAge > 0 && now - ts > maxAge) continue;
      parsed.push({ line, ts });
    } catch {
      // keep malformed lines (don't silently lose data)
      parsed.push({ line, ts: now });
    }
  }

  // cap by event count — keep newest
  let kept = parsed.slice(-opts.maxProjectEvents);

  // cap by bytes — keep newest
  let totalBytes = kept.reduce((s, p) => s + p.line.length + 1, 0);
  while (totalBytes > opts.maxProjectLogBytes && kept.length > 0) {
    const removed = kept.shift()!;
    totalBytes -= removed.line.length + 1;
  }

  const newContent = kept.map(p => p.line).join("\n") + (kept.length > 0 ? "\n" : "");
  // atomic-ish: write to temp then rename
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, newContent, "utf8");
  fs.renameSync(tmp, file);
}

export function applyGlobalRetention(rootDir: string, opts: RetentionOptions): void {
  const projects = listProjectIds(rootDir);
  type Entry = { projectId: string; bytes: number; mtime: number };
  const entries: Entry[] = [];

  for (const pid of projects) {
    const file = logFile(rootDir, pid);
    if (!fs.existsSync(file)) continue;
    const stat = fs.statSync(file);
    entries.push({ projectId: pid, bytes: stat.size, mtime: stat.mtimeMs });
  }

  let total = entries.reduce((s, e) => s + e.bytes, 0);
  if (total <= opts.maxAllProjectsBytes) return;

  // truncate least-recently-used first
  entries.sort((a, b) => a.mtime - b.mtime);
  for (const entry of entries) {
    if (total <= opts.maxAllProjectsBytes) break;
    const file = logFile(rootDir, entry.projectId);
    fs.writeFileSync(file, "", "utf8");
    total -= entry.bytes;
  }
}
