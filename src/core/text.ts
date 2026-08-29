/**
 * Truncates `value` to at most `maxChars` characters, marking the cut with the
 * given suffix so downstream consumers can detect lossy rendering.
 */
export function truncateText(value: string, maxChars: number, suffix = "..."): string {
  if (value.length <= maxChars) return value;
  const cut = Math.max(1, maxChars - suffix.length);
  return `${value.slice(0, cut)}${suffix}`;
}

/** Ranges that tokenize at roughly one token per character (CJK, Kana, Hangul, fullwidth forms). */
const DENSE_TOKEN_REGEX =
  /[\u3000-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFF60]/;

/**
 * Estimates the model-token footprint of `text` without a vendor tokenizer:
 * roughly one token per CJK/Kana/Hangul/fullwidth character and one token per
 * four other characters. Injection budgets need stable magnitudes, not exact
 * billing.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let dense = 0;
  let other = 0;
  for (const char of text) {
    if (DENSE_TOKEN_REGEX.test(char)) {
      dense += 1;
    } else {
      other += 1;
    }
  }
  return dense + Math.ceil(other / 4);
}

/**
 * Longest prefix of `text` whose token estimate stays within `budgetTokens`,
 * suffixed with `suffix`. The estimate is monotonic in prefix length, so the
 * prefix search is deterministic; text that already fits returns unchanged.
 */
export function truncateTextToTokenBudget(
  text: string,
  budgetTokens: number,
  suffix = "... [truncated]",
): string {
  if (estimateTokens(text) <= budgetTokens) return text;
  const suffixTokens = estimateTokens(suffix);
  const usable = Math.max(budgetTokens - suffixTokens, 0);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= usable) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${text.slice(0, low).trimEnd()}${suffix}`;
}
