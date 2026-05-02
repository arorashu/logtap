const UNITS: [string, number][] = [
  ["tb", 1024 ** 4],
  ["gb", 1024 ** 3],
  ["mb", 1024 ** 2],
  ["kb", 1024],
];

export function parseBytes(s: string): number {
  const lower = s.trim().toLowerCase();
  for (const [suffix, mult] of UNITS) {
    if (lower.endsWith(suffix)) {
      return parseFloat(lower.slice(0, -suffix.length)) * mult;
    }
  }
  const n = parseInt(lower, 10);
  if (isNaN(n)) throw new Error(`Invalid byte string: ${s}`);
  return n;
}

export function formatBytes(n: number): string {
  for (const [suffix, mult] of UNITS) {
    if (n >= mult) return `${(n / mult).toFixed(1)}${suffix.toUpperCase()}`;
  }
  return `${n}B`;
}
