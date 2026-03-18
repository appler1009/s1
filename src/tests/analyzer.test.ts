import { describe, it, expect } from 'bun:test';
import { StandardAnalyzer, KeywordAnalyzer } from '../analyzer.js';

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
  });

  it('records positions starting at 1', () => {
    const tokens = analyzer.analyze('body', 'quick brown fox');
    // positions may be non-contiguous due to stop word filtering
    expect(tokens[0]!.position).toBeGreaterThanOrEqual(1);
    expect(tokens[1]!.position).toBeGreaterThan(tokens[0]!.position);
  });

  it('handles empty string', () => {
    expect(analyzer.analyze('body', '')).toEqual([]);
  });
});

describe('KeywordAnalyzer', () => {
  const analyzer = new KeywordAnalyzer();

  it('returns single token for the whole value', () => {
    const tokens = analyzer.analyze('url', 'Hello World');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.term).toBe('hello world');
  });

  it('returns empty for empty string', () => {
    expect(analyzer.analyze('url', '')).toEqual([]);
  });
});
