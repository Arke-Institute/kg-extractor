/**
 * Quote extraction utilities
 *
 * Extracts actual quotes from source text using boundary markers.
 */

/**
 * Normalize text for matching:
 * - Collapse all whitespace (including newlines) to single spaces
 * - Lowercase
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Create a regex pattern from a phrase that allows flexible whitespace matching
 */
function createFlexiblePattern(phrase: string): RegExp {
  // Escape regex special characters, then replace spaces with \s+
  const escaped = phrase
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return new RegExp(escaped, 'i');
}

/**
 * Find the position of a phrase in text with flexible whitespace matching
 * Returns the start and end indices, or null if not found
 */
function findPhrase(
  text: string,
  phrase: string
): { start: number; end: number } | null {
  if (!phrase.trim()) return null;

  const pattern = createFlexiblePattern(phrase);
  const match = pattern.exec(text);

  if (!match) return null;

  return {
    start: match.index,
    end: match.index + match[0].length,
  };
}

/**
 * Extract a quote from source text using boundary markers
 *
 * @param text - The full source text
 * @param quoteStart - First ~4 words of the quote
 * @param quoteEnd - Last ~4 words of the quote
 * @returns The extracted quote, or null if not found
 */
export function extractQuote(
  text: string,
  quoteStart: string | undefined,
  quoteEnd: string | undefined
): string | null {
  if (!quoteStart || !quoteEnd) return null;
  if (!text) return null;

  // Find start marker
  const startMatch = findPhrase(text, quoteStart);
  if (!startMatch) return null;

  // Find end marker, searching only after the start position
  const textAfterStart = text.slice(startMatch.start);
  const endMatch = findPhrase(textAfterStart, quoteEnd);
  if (!endMatch) return null;

  // Extract the quote (from start of start marker to end of end marker)
  const quoteEndPos = startMatch.start + endMatch.end;
  const extracted = text.slice(startMatch.start, quoteEndPos);

  // Sanity check - quote shouldn't be too long (likely a bad match)
  if (extracted.length > 500) {
    console.warn(
      '[quotes] Extracted quote too long, likely bad match:',
      extracted.slice(0, 100) + '...'
    );
    return null;
  }

  // Normalize whitespace in the result
  return normalizeWhitespace(extracted);
}
