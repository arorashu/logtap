const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDuration(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([smhd])$/);
  if (!m || !m[1] || !m[2]) throw new Error(`Invalid duration: ${s}`);
  return parseFloat(m[1]) * (UNIT_MS[m[2]] ?? 1_000);
}

export function sinceToStartMs(since: string | undefined, nowMs: number): number {
  if (!since) return 0;
  try {
    return nowMs - parseDuration(since);
  } catch {
    return 0;
  }
}
