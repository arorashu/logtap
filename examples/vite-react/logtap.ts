import { createBrowserTap } from "@your-scope/logtap/browser";

export const logtap = createBrowserTap({
  endpoint: "http://localhost:4319/__logtap/ingest",
  app: "my-app",
  env: import.meta.env.MODE,
  buildSha: import.meta.env.VITE_BUILD_SHA,
  getRoute: () => location.pathname,
  enabled: import.meta.env.DEV,
});
