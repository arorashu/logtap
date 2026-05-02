import type { LogTapEvent } from "../shared/types.ts";

export type TransportOptions = {
  endpoint: string;
  flushIntervalMs: number;
  maxBatchSize: number;
};

export class BatchTransport {
  private queue: LogTapEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: TransportOptions;

  constructor(opts: TransportOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.flush(), this.opts.flushIntervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  enqueue(event: LogTapEvent): void {
    this.queue.push(event);
    if (this.queue.length >= this.opts.maxBatchSize) {
      this.flush();
    }
  }

  flush(): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve();
    const batch = this.queue.splice(0, this.opts.maxBatchSize);
    return this.send(batch);
  }

  private send(events: LogTapEvent[]): Promise<void> {
    const payload = JSON.stringify({ events });
    const endpoint = this.opts.endpoint;

    // use sendBeacon for small payloads when available
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function" &&
      payload.length < 60_000
    ) {
      try {
        const sent = navigator.sendBeacon(endpoint, new Blob([payload], { type: "application/json" }));
        if (sent) return Promise.resolve();
      } catch {
        // fall through to fetch
      }
    }

    return fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).then(() => undefined).catch(() => undefined); // fail silently
  }
}
