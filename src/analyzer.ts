import type { Token } from './types.js';

// ─── Interface ───────────────────────────────────────────────────────────────

export interface Analyzer {
  analyze(field: string, value: string): Token[];
}

// ─── Standard Analyzer ───────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'as', 'be',
  'was', 'are', 'were', 'been', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
  'not', 'no', 'nor', 'so', 'yet', 'both', 'either', 'neither',
  'if', 'then', 'else', 'when', 'where', 'while', 'although', 'though',
  'because', 'since', 'until', 'unless', 'although',
]);

/**
 * Standard analyzer:
 * - Lowercases
 * - Splits on non-word characters
 * - Filters stop words
 * - Drops pure-numeric tokens ≤ 1 char (single digits)
 */
export class StandardAnalyzer implements Analyzer {
  analyze(_field: string, value: string): Token[] {
    const text = String(value).toLowerCase();
    const rawTokens = text.match(/\b\w+\b/g) ?? [];
    const result: Token[] = [];
    let position = 0;

    for (const raw of rawTokens) {
      position++;
      if (raw.length < 2) continue;          // skip single chars
      if (STOP_WORDS.has(raw)) continue;
      result.push({ term: raw, position });
    }

    return result;
  }
}

/**
 * Keyword analyzer: no tokenization; the entire value is one term (lowercased).
 */
export class KeywordAnalyzer implements Analyzer {
  analyze(_field: string, value: string): Token[] {
    const term = String(value).toLowerCase().trim();
    if (!term) return [];
    return [{ term, position: 1 }];
  }
}

/** Factory */
export function createAnalyzer(name: 'standard' | 'keyword' | string): Analyzer {
  if (name === 'keyword') return new KeywordAnalyzer();
  return new StandardAnalyzer();
}
