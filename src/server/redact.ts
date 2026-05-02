import { normalizeUrl } from "../shared/normalize.ts";

const DEFAULT_SENSITIVE_KEYS = new Set([
  "authorization", "cookie", "set-cookie", "password",
  "token", "secret", "apikey", "apiKey",
]);

export function buildRedactor(fields: string[]): (obj: unknown) => unknown {
  const keys = new Set([...DEFAULT_SENSITIVE_KEYS, ...fields.map(f => f.toLowerCase())]);
  return function redact(obj: unknown): unknown {
    return redactValue(obj, keys);
  };
}

function redactValue(value: unknown, keys: Set<string>): unknown {
  if (Array.isArray(value)) return value.map(v => redactValue(v, keys));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = k.toLowerCase();
      if (keys.has(normalizedKey)) {
        out[k] = "[REDACTED]";
      } else if (normalizedKey === "url" && typeof v === "string") {
        out[k] = normalizeUrl(v);
      } else {
        out[k] = redactValue(v, keys);
      }
    }
    return out;
  }
  return value;
}

export function redactUrl(url: string): string {
  return normalizeUrl(url);
}
