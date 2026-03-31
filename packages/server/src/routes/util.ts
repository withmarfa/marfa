export function parseIntParam(
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}
