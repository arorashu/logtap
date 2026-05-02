import { createBrowserTap } from "@your-scope/logtap/browser";

export const logtap =
  typeof window !== "undefined"
    ? createBrowserTap({
        endpoint: "http://localhost:4319/__logtap/ingest",
        app: "my-next-app",
        env: process.env.NODE_ENV,
        buildSha: process.env.NEXT_PUBLIC_BUILD_SHA,
        getRoute: () => location.pathname,
        enabled: process.env.NODE_ENV === "development",
      })
    : null;
