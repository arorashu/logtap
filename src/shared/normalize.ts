const SENSITIVE_QUERY_PARAMS = new Set([
  "token", "secret", "key", "password", "code", "auth", "session",
]);

export function normalizeMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/uuid[:=\s]+[0-9a-f-]{20,}/gi, "uuid=<uuid>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hash>")
    .replace(/\b\d+\b/g, "<num>");
}

export function normalizeUrl(rawUrl: string): string {
  if (!rawUrl) return "";
  try {
    const u = new URL(rawUrl);
    // normalize path IDs before reconstructing
    const normalizedPath = u.pathname
      .replace(/\/[0-9a-f]{8,}/gi, "/<hash>")
      .replace(/\/\d+(?=\/|$)/g, "/<id>");

    // rebuild query string without URL-encoding our replacement tokens
    const parts: string[] = [];
    for (const [key, value] of u.searchParams.entries()) {
      const redacted = SENSITIVE_QUERY_PARAMS.has(key.toLowerCase()) ? "[REDACTED]" : value;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(redacted).replace(/%5B/g, "[").replace(/%5D/g, "]")}`);
    }
    const qs = parts.length > 0 ? "?" + parts.join("&") : "";
    return `${u.protocol}//${u.host}${normalizedPath}${qs}`;
  } catch {
    return rawUrl.replace(/[?#].*$/, "");
  }
}

export function topStackFrame(stack: string | undefined): string {
  if (!stack) return "";
  const lines = stack.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("Error:") && (trimmed.startsWith("at ") || trimmed.includes("@"))) {
      return trimmed.slice(0, 200);
    }
  }
  return lines[0]?.trim().slice(0, 200) ?? "";
}
