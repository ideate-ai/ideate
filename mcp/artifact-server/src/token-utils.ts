/**
 * Rough token-count estimate using the characters/4 heuristic.
 * Accuracy: ~±50% for non-ASCII text. Upgrade to tiktoken planned in PH-056.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.floor(text.length / 4);
}
