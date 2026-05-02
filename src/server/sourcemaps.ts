import * as fs from "node:fs";
import * as path from "node:path";
import type { LogTapEvent, SourceMapOptions } from "../shared/types.ts";

// Optional source map enrichment. The @jridgewell/trace-mapping dependency
// is dynamically imported so ingest never fails if it's missing.

type TraceMapping = {
  AnyMap: new (map: unknown) => unknown;
  originalPositionFor: (map: unknown, opts: { line: number; column: number }) => {
    source: string | null;
    line: number | null;
    column: number | null;
    name: string | null;
  };
};

let traceMapping: TraceMapping | null | "unavailable" = null;

async function getTraceMapping(): Promise<TraceMapping | null> {
  if (traceMapping === "unavailable") return null;
  if (traceMapping !== null) return traceMapping;
  try {
    traceMapping = await import("@jridgewell/trace-mapping") as TraceMapping;
    return traceMapping;
  } catch {
    traceMapping = "unavailable";
    return null;
  }
}

type StackFrame = {
  raw: string;
  filename: string;
  line: number;
  column: number;
};

function parseV8Frame(line: string): StackFrame | null {
  // "    at FnName (path/to/file.js:10:5)"
  const m = line.match(/at\s+(?:.+\s+\()?(.+):(\d+):(\d+)\)?$/);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  return { raw: line, filename: m[1], line: parseInt(m[2], 10), column: parseInt(m[3], 10) };
}

function resolveMapFile(
  artifactDir: string,
  filename: string,
  opts: SourceMapOptions,
): string | null {
  // strip known prefixes
  let relative = filename;
  for (const prefix of (opts.stripPrefixes ?? [])) {
    if (relative.startsWith(prefix)) {
      relative = relative.slice(prefix.length);
    }
  }

  // try direct <artifactDir>/<relative>.map
  const candidates = [
    path.join(artifactDir, relative + ".map"),
    path.join(artifactDir, path.basename(relative) + ".map"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // try watching dirs
  for (const watchDir of (opts.watchDirs ?? [])) {
    const c1 = path.join(watchDir, relative + ".map");
    const c2 = path.join(watchDir, path.basename(relative) + ".map");
    if (fs.existsSync(c1)) return c1;
    if (fs.existsSync(c2)) return c2;
  }

  return null;
}

export async function enrichWithSourceMaps(
  event: LogTapEvent,
  projectArtifactDir: string,
  opts: SourceMapOptions,
): Promise<LogTapEvent> {
  if (!opts.enabled) {
    return { ...event, sourceMapStatus: "not_needed" };
  }
  if (!event.stack) {
    return { ...event, sourceMapStatus: "not_needed" };
  }

  const lib = await getTraceMapping();
  if (!lib) {
    // library unavailable — leave event intact, don't fail
    return { ...event, sourceMapStatus: "missing" };
  }

  const stackLines = event.stack.split("\n");
  const mappedLines: string[] = [];
  let anyMapped = false;
  let anyMissing = false;

  for (const line of stackLines) {
    const frame = parseV8Frame(line);
    if (!frame) {
      mappedLines.push(line);
      continue;
    }

    const mapFile = resolveMapFile(projectArtifactDir, frame.filename, opts);
    if (!mapFile) {
      anyMissing = true;
      mappedLines.push(line);
      continue;
    }

    try {
      const rawMap = JSON.parse(fs.readFileSync(mapFile, "utf8"));
      const smap = new lib.AnyMap(rawMap);
      const pos = lib.originalPositionFor(smap, { line: frame.line, column: frame.column });
      if (pos.source && pos.line !== null) {
        mappedLines.push(`    at ${pos.name ?? "<anonymous>"} (${pos.source}:${pos.line}:${pos.column ?? 0})`);
        anyMapped = true;
      } else {
        mappedLines.push(line);
        anyMissing = true;
      }
    } catch {
      mappedLines.push(line);
      return { ...event, sourceMapStatus: "failed" };
    }
  }

  const sourceMapStatus = anyMapped ? "mapped" : anyMissing ? "missing" : "not_needed";
  const stackMapped = anyMapped ? mappedLines.join("\n") : undefined;

  return { ...event, stackMapped, sourceMapStatus };
}
