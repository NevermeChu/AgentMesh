/**
 * Truncates `value` to at most `maxChars` characters, marking the cut with the
 * given suffix so downstream consumers can detect lossy rendering.
 */
export function truncateText(value: string, maxChars: number, suffix = "..."): string {
  if (value.length <= maxChars) return value;
  const cut = Math.max(1, maxChars - suffix.length);
  return `${value.slice(0, cut)}${suffix}`;
}
