/**
 * Label normalization for entity deduplication
 */

const COMMON_PREFIXES = ['the', 'a', 'an', 'captain', 'mr', 'mrs', 'dr', 'prof'];

/**
 * Normalize a label for deduplication matching.
 *
 * - Lowercase
 * - Remove common prefixes (the, a, an, captain, mr, etc.)
 * - Remove punctuation
 * - Collapse whitespace
 */
export function normalizeLabel(label: string): string {
  let normalized = label.toLowerCase().trim();

  // Remove common prefixes
  for (const prefix of COMMON_PREFIXES) {
    if (normalized.startsWith(prefix + ' ')) {
      normalized = normalized.slice(prefix.length + 1);
      break; // Only remove one prefix
    }
  }

  // Remove punctuation, collapse whitespace
  normalized = normalized
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
}
