import { describe, it, expect } from 'bun:test';
import { StandardAnalyzer, KeywordAnalyzer, createAnalyzer } from '../analyzer.js';

describe('StandardAnalyzer', () => {
  const analyzer = new StandardAnalyzer();

  it('lowercases and tokenizes', () => {
    const tokens = analyzer.analyze('title', 'Hello World');
    expect(tokens.map(t => t.term)).toEqual(['hello', 'world']);
  });

  it('removes stop words', () => {
    const tokens = analyzer.analyze('body', 'the quick brown fox');
    const terms = tokens.map(t => t.term);
    expect(terms).not.toContain('the');
    expect(terms).toContain('quick');
    expect(terms).toContain('brown');
    expect(terms).toContain('fox');
  });

  it('drops single-character tokens', () => {
    const tokens = analyzer.analyze('body', 'a x hello');
    const terms = tokens.map(t => t.term);
    expect(terms).not.toContain('a');
    expect(terms).not.toContain('x');
    expect(terms).toContain('hello');
  });

  it('drops single-digit numeric tokens', () => {
    const tokens = analyzer.analyze('body', '5 hello 42');
    const terms = tokens.map(t => t.term);
    expect(terms).not.toContain('5');
    expect(terms).toContain('hello');
    expect(terms).toContain('42');
  });

  it('records positions starting at 1', () => {
    const tokens = analyzer.analyze('body', 'quick brown fox');
    expect(tokens[0]!.position).toBe(1);
    expect(tokens[1]!.position).toBe(2);
    expect(tokens[2]!.position).toBe(3);
  });

  it('position gaps reflect filtered stop words', () => {
    // "the" is at position 1 (filtered), "quick" at 2, "brown" at 3
    const tokens = analyzer.analyze('body', 'the quick brown');
    expect(tokens[0]!.term).toBe('quick');
    expect(tokens[0]!.position).toBe(2);
    expect(tokens[1]!.term).toBe('brown');
    expect(tokens[1]!.position).toBe(3);
  });

  it('position gaps reflect filtered single-char tokens', () => {
    // "a" (pos 1, filtered), "quick" (pos 2), "b" (pos 3, filtered), "fox" (pos 4)
    const tokens = analyzer.analyze('body', 'a quick b fox');
    expect(tokens[0]!.term).toBe('quick');
    expect(tokens[0]!.position).toBe(2);
    expect(tokens[1]!.term).toBe('fox');
    expect(tokens[1]!.position).toBe(4);
  });

  it('handles empty string', () => {
    expect(analyzer.analyze('body', '')).toEqual([]);
  });

  it('handles whitespace-only string', () => {
    expect(analyzer.analyze('body', '   ')).toEqual([]);
  });

  it('handles all-stop-word input', () => {
    expect(analyzer.analyze('body', 'the and or')).toEqual([]);
  });

  it('handles non-ASCII unicode characters by splitting on word boundaries', () => {
    // \b\w+\b matches ASCII word chars; unicode chars are boundary-split as non-word
    const tokens = analyzer.analyze('body', 'hello world');
    expect(tokens.map(t => t.term)).toEqual(['hello', 'world']);
  });

  it('the field parameter is ignored (same output for any field)', () => {
    const t1 = analyzer.analyze('title', 'hello world');
    const t2 = analyzer.analyze('body', 'hello world');
    expect(t1).toEqual(t2);
  });

  it('numbers with 2+ digits are kept', () => {
    const tokens = analyzer.analyze('body', '2024 v10');
    const terms = tokens.map(t => t.term);
    expect(terms).toContain('2024');
    expect(terms).toContain('v10');
  });
});

describe('KeywordAnalyzer', () => {
  const analyzer = new KeywordAnalyzer();

  it('returns the entire value as one lowercased token', () => {
    const tokens = analyzer.analyze('url', 'Hello World');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.term).toBe('hello world');
  });

  it('returns empty for empty string', () => {
    expect(analyzer.analyze('url', '')).toEqual([]);
  });

  it('returns empty for whitespace-only string', () => {
    expect(analyzer.analyze('url', '   ')).toEqual([]);
  });

  it('preserves special characters inside the token', () => {
    const tokens = analyzer.analyze('code', 'v1.2.3-beta');
    expect(tokens[0]!.term).toBe('v1.2.3-beta');
  });

  it('position is always 1', () => {
    const tokens = analyzer.analyze('id', 'some-value');
    expect(tokens[0]!.position).toBe(1);
  });

  it('the field parameter is ignored', () => {
    const t1 = analyzer.analyze('a', 'hello');
    const t2 = analyzer.analyze('b', 'hello');
    expect(t1).toEqual(t2);
  });
});

describe('createAnalyzer factory', () => {
  it('returns StandardAnalyzer for "standard"', () => {
    expect(createAnalyzer('standard')).toBeInstanceOf(StandardAnalyzer);
  });

  it('returns KeywordAnalyzer for "keyword"', () => {
    expect(createAnalyzer('keyword')).toBeInstanceOf(KeywordAnalyzer);
  });

  it('returns StandardAnalyzer for unknown names', () => {
    expect(createAnalyzer('unknown')).toBeInstanceOf(StandardAnalyzer);
  });
});
