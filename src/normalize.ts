/**
 * Label normalization for entity deduplication
 *
 * Note: The Arke lookup API uses exact match (case-insensitive only).
 * We normalize labels before storing to ensure deduplication works.
 */

/**
 * Normalize a label for deduplication matching AND storage.
 *
 * - Lowercase
 * - Remove punctuation (except hyphens within words)
 * - Collapse whitespace
 * - Trim
 *
 * NOTE: We do NOT strip prefixes like "the", "a", "captain" because:
 * 1. It can cause semantic ambiguity (e.g., "The Pequod" vs "Pequod")
 * 2. The lookup API does exact match, so we'd lose findability
 */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')  // Remove punctuation except hyphens
    .replace(/\s+/g, ' ')       // Collapse whitespace
    .trim();
}
