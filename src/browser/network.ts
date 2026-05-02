import type { LogTapEvent, LogTapBreadcrumb } from "../shared/types.ts";
import { normalizeUrl } from "../shared/normalize.ts";

type NetworkOptions = {
  app?: string;
  env?: string;
  projectId?: string;
  sessionId?: string;
  userId?: string;
  buildSha?: string;
  release?: string;
  getRoute?: () => string | undefined;
  getBreadcrumbs: () => LogTapBreadcrumb[];
  ignoreUrls?: string[];
  onEvent: (event: LogTapEvent) => void;
};

export function patchFetch(opts: NetworkOptions): () => void {
  if (typeof window === "undefined" || typeof window.fetch === "undefined") {
    return () => undefined;
  }

  const originalFetch = window.fetch.bind(window);

  const wrappedFetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const start = Date.now();
    const method = init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET");
    const rawUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
    const cleanUrl = normalizeUrl(rawUrl);

    if (shouldIgnoreUrl(rawUrl, opts.ignoreUrls)) {
      return originalFetch(input, init);
    }

    let response: Response;
    try {
      response = await originalFetch(input, init);
    } catch (err) {
      const durationMs = Date.now() - start;
      opts.onEvent({
        ts: new Date().toISOString(),
        level: "error",
        kind: "network",
        message: `fetch failed: ${method} ${cleanUrl}`,
        url: typeof location !== "undefined" ? location.href : undefined,
        route: opts.getRoute?.(),
        breadcrumbs: opts.getBreadcrumbs(),
        network: { method, url: cleanUrl, durationMs },
        app: opts.app,
        env: opts.env,
        projectId: opts.projectId,
        sessionId: opts.sessionId,
        userId: opts.userId,
        buildSha: opts.buildSha,
        release: opts.release,
      });
      throw err;
    }

    if (response.status >= 400) {
      const durationMs = Date.now() - start;
      opts.onEvent({
        ts: new Date().toISOString(),
        level: "error",
        kind: "network",
        message: `fetch ${response.status}: ${method} ${cleanUrl}`,
        url: typeof location !== "undefined" ? location.href : undefined,
        route: opts.getRoute?.(),
        breadcrumbs: opts.getBreadcrumbs(),
        network: { method, url: cleanUrl, status: response.status, durationMs },
        app: opts.app,
        env: opts.env,
        projectId: opts.projectId,
        sessionId: opts.sessionId,
        userId: opts.userId,
        buildSha: opts.buildSha,
        release: opts.release,
      });
    }

    return response;
  };
  Object.assign(wrappedFetch, originalFetch);
  window.fetch = wrappedFetch as typeof window.fetch;

  return () => {
    window.fetch = originalFetch;
  };
}

function shouldIgnoreUrl(rawUrl: string, ignoreUrls: string[] | undefined): boolean {
  if (!ignoreUrls || ignoreUrls.length === 0) return false;
  return ignoreUrls.some(ignoreUrl => rawUrl === ignoreUrl || rawUrl.startsWith(ignoreUrl));
}
