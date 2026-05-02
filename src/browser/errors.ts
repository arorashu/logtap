import type { LogTapEvent, LogTapBreadcrumb } from "../shared/types.ts";

type ErrorOptions = {
  app?: string;
  env?: string;
  projectId?: string;
  sessionId?: string;
  userId?: string;
  buildSha?: string;
  release?: string;
  getRoute?: () => string | undefined;
  getBreadcrumbs: () => LogTapBreadcrumb[];
  onEvent: (event: LogTapEvent) => void;
};

export function attachErrorListeners(opts: ErrorOptions): () => void {
  if (typeof window === "undefined") return () => undefined;

  const base = {
    app: opts.app,
    env: opts.env,
    projectId: opts.projectId,
    sessionId: opts.sessionId,
    userId: opts.userId,
    buildSha: opts.buildSha,
    release: opts.release,
  };

  const onError = (e: ErrorEvent) => {
    opts.onEvent({
      ts: new Date().toISOString(),
      level: "error",
      kind: "exception",
      message: e.message || "Unknown error",
      stack: e.error?.stack,
      url: location.href,
      route: opts.getRoute?.(),
      breadcrumbs: opts.getBreadcrumbs(),
      data: {
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
      },
      ...base,
    });
  };

  const onUnhandledRejection = (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    const message =
      reason instanceof Error ? reason.message : String(reason ?? "Unhandled rejection");
    const stack = reason instanceof Error ? reason.stack : undefined;

    opts.onEvent({
      ts: new Date().toISOString(),
      level: "error",
      kind: "unhandledrejection",
      message,
      stack,
      url: location.href,
      route: opts.getRoute?.(),
      breadcrumbs: opts.getBreadcrumbs(),
      ...base,
    });
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
