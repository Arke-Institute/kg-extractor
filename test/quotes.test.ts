/**
 * Unit tests for quote extraction
 */

import { describe, it, expect } from 'vitest';
import { extractQuote } from '../src/quotes';

describe('extractQuote', () => {
  const sampleText = `Captain Ahab stood upon his quarter-deck,
    gazing out at the vast Pacific. His ivory leg tapped against
    the wooden planks as he muttered, "I'll chase him round Good Hope,
    and round the Horn, and round the Norway Maelstrom, and round
    perdition's flames before I give him up."`;

  it('should extract quote using exact boundary markers', () => {
    const result = extractQuote(
      sampleText,
      "I'll chase him round",
      'give him up.'
    );
    expect(result).toContain("I'll chase him round Good Hope");
    expect(result).toContain("give him up.");
  });

  it('should handle flexible whitespace matching', () => {
    // The text has newlines between words, but markers use single spaces
    const result = extractQuote(
      sampleText,
      "I'll chase him round",
      'give him up.'
    );
    expect(result).toBeTruthy();
    expect(result).toContain('chase him');
  });

  it('should handle case insensitive matching', () => {
    const result = extractQuote(
      sampleText,
      'CAPTAIN AHAB STOOD',
      'his quarter-deck'
    );
    expect(result).toBeTruthy();
    expect(result?.toLowerCase()).toContain('captain ahab');
  });

  it('should return null for non-matching markers', () => {
    const result = extractQuote(
      sampleText,
      'not in the text',
      'also not present'
    );
    expect(result).toBeNull();
  });

  it('should return null when start marker not found', () => {
    const result = extractQuote(
      sampleText,
      'not present',
      'quarter-deck'
    );
    expect(result).toBeNull();
  });

  it('should return null when end marker not found', () => {
    const result = extractQuote(
      sampleText,
      'Captain Ahab',
      'not in text'
    );
    expect(result).toBeNull();
  });

  it('should return null for undefined markers', () => {
    expect(extractQuote(sampleText, undefined, 'end')).toBeNull();
    expect(extractQuote(sampleText, 'start', undefined)).toBeNull();
    expect(extractQuote(sampleText, undefined, undefined)).toBeNull();
  });

  it('should return null for empty text', () => {
    expect(extractQuote('', 'start', 'end')).toBeNull();
  });

  it('should reject quotes that are too long (likely bad match)', () => {
    // Create text with repeated phrases
    const longText = 'Start here. ' + 'x'.repeat(600) + ' End here.';
    const result = extractQuote(longText, 'Start here', 'End here');
    // Should be null because extracted quote > 500 chars
    expect(result).toBeNull();
  });

  it('should handle whitespace normalization', () => {
    const textWithWeirdWhitespace = 'The   whale   swam   quickly   through   the   water.';
    const result = extractQuote(
      textWithWeirdWhitespace,
      'whale swam',
      'through the'
    );
    expect(result).toBeTruthy();
  });
});
