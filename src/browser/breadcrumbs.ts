import type { LogTapBreadcrumb } from "../shared/types.ts";

export class BreadcrumbBuffer {
  private buffer: LogTapBreadcrumb[] = [];
  private max: number;

  constructor(max: number) {
    this.max = max;
  }

  add(name: string, data?: Record<string, unknown>): void {
    const crumb: LogTapBreadcrumb = { ts: new Date().toISOString(), name, data };
    this.buffer.push(crumb);
    if (this.buffer.length > this.max) {
      this.buffer.shift();
    }
  }

  getAll(): LogTapBreadcrumb[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }
}

type OriginalHistory = {
  pushState: typeof history.pushState;
  replaceState: typeof history.replaceState;
};

export function patchHistory(onNavigate: (to: string) => void): () => void {
  if (typeof window === "undefined") return () => undefined;

  const orig: OriginalHistory = {
    pushState: history.pushState.bind(history),
    replaceState: history.replaceState.bind(history),
  };

  function wrap(
    fn: typeof history.pushState,
  ): typeof history.pushState {
    return function(this: History, state, title, url) {
      fn.call(this, state, title, url);
      onNavigate(String(url ?? location.pathname));
    };
  }

  history.pushState = wrap(orig.pushState);
  history.replaceState = wrap(orig.replaceState);

  const onPopState = () => onNavigate(location.pathname);
  window.addEventListener("popstate", onPopState);

  return () => {
    history.pushState = orig.pushState;
    history.replaceState = orig.replaceState;
    window.removeEventListener("popstate", onPopState);
  };
}
