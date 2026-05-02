import type { LogTapEvent } from "../shared/types.ts";

type ConsoleOptions = {
  app?: string;
  env?: string;
  projectId?: string;
  sessionId?: string;
  userId?: string;
  buildSha?: string;
  release?: string;
  getRoute?: () => string | undefined;
  onEvent: (event: LogTapEvent) => void;
};

type OriginalConsole = {
  warn: typeof console.warn;
  error: typeof console.error;
};

let _capturing = false;

export function patchConsole(opts: ConsoleOptions): () => void {
  if (typeof console === "undefined") return () => undefined;

  const orig: OriginalConsole = {
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  function wrap(
    level: "warn" | "error",
    fn: (...args: unknown[]) => void,
  ): (...args: unknown[]) => void {
    return function(...args: unknown[]) {
      fn(...args); // always call original
      if (_capturing) return; // prevent recursion
      _capturing = true;
      try {
        const message = args
          .map(a => (typeof a === "string" ? a : tryStringify(a)))
          .join(" ");
        opts.onEvent({
          ts: new Date().toISOString(),
          level,
          kind: "console",
          message,
          app: opts.app,
          env: opts.env,
          projectId: opts.projectId,
          sessionId: opts.sessionId,
          userId: opts.userId,
          buildSha: opts.buildSha,
          release: opts.release,
          route: opts.getRoute?.(),
          url: typeof location !== "undefined" ? location.href : undefined,
        });
      } finally {
        _capturing = false;
      }
    };
  }

  console.warn = wrap("warn", orig.warn);
  console.error = wrap("error", orig.error);

  return () => {
    console.warn = orig.warn;
    console.error = orig.error;
  };
}

function tryStringify(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v); }
  catch { return String(v); }
}
