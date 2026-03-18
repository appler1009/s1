import { describe, it, expect } from 'bun:test';
import { LuceneQueryParser } from '../query-parser.js';
import type { TermQuery, PhraseQuery, BoolQuery, WildcardQuery, RangeQuery } from '../types.js';

const parser = new LuceneQueryParser();

describe('LuceneQueryParser', () => {
  describe('term queries', () => {
    it('parses a bare term', () => {
      const ast = parser.parse('hello') as TermQuery;
      expect(ast.type).toBe('term');
      expect(ast.term).toBe('hello');
    });

    it('lowercases bare term', () => {
      expect((parser.parse('Hello') as TermQuery).term).toBe('hello');
    });

    it('parses a fielded term', () => {
      const ast = parser.parse('title:hello') as TermQuery;
      expect(ast.type).toBe('term');
      expect(ast.field).toBe('title');
      expect(ast.term).toBe('hello');
    });

    it('parses a boost', () => {
      const ast = parser.parse('hello^2.5') as TermQuery;
      expect(ast.type).toBe('term');
      expect(ast.boost).toBeCloseTo(2.5);
    });

    it('parses a fielded term with boost', () => {
      const ast = parser.parse('title:hello^3') as TermQuery;
      expect(ast.type).toBe('term');
      expect(ast.field).toBe('title');
      expect(ast.boost).toBeCloseTo(3);
    });

    it('ignores non-numeric boost — does not consume ^', () => {
      // When ^ is followed by a non-numeric token the parser restores position.
      // The '^' char is then treated as an unknown separator and 'foo' becomes
      // a second should clause, resulting in a BoolQuery.
      const ast = parser.parse('hello^foo');
      // The important invariant is that 'hello' term is still present and has no boost.
      const terms: string[] = [];
      if (ast.type === 'term') {
        expect(ast.boost).toBeUndefined();
        terms.push(ast.term);
      } else if (ast.type === 'bool') {
        for (const c of ast.should ?? []) {
          if (c.type === 'term') terms.push(c.term);
        }
      }
      expect(terms).toContain('hello');
    });

    it('returns empty term for empty query', () => {
      expect(parser.parse('').type).toBe('term');
      expect((parser.parse('') as TermQuery).term).toBe('');
    });

    it('returns empty term for whitespace-only query', () => {
      expect((parser.parse('   ') as TermQuery).term).toBe('');
    });
  });

  describe('phrase queries', () => {
    it('parses a phrase', () => {
      const ast = parser.parse('"hello world"') as PhraseQuery;
      expect(ast.type).toBe('phrase');
      expect(ast.terms).toEqual(['hello', 'world']);
    });

    it('parses a fielded phrase', () => {
      const ast = parser.parse('title:"quick brown fox"') as PhraseQuery;
      expect(ast.type).toBe('phrase');
      expect(ast.field).toBe('title');
      expect(ast.terms).toEqual(['quick', 'brown', 'fox']);
    });

    it('lowercases phrase terms', () => {
      const ast = parser.parse('"Quick Brown Fox"') as PhraseQuery;
      expect(ast.terms).toEqual(['quick', 'brown', 'fox']);
    });

    it('parses phrase slop', () => {
      const ast = parser.parse('"quick brown"~2') as PhraseQuery;
      expect(ast.slop).toBe(2);
    });

    it('slop=0 is the default when ~ is absent', () => {
      const ast = parser.parse('"quick brown"') as PhraseQuery;
      expect(ast.slop).toBeUndefined();
    });

    it('ignores ~ followed by non-numeric', () => {
      const ast = parser.parse('"quick brown"~abc') as PhraseQuery;
      expect(ast.slop).toBeUndefined();
    });

    it('parses phrase boost', () => {
      const ast = parser.parse('"quick brown"^1.5') as PhraseQuery;
      expect(ast.boost).toBeCloseTo(1.5);
    });

    it('parses phrase with both slop and boost', () => {
      const ast = parser.parse('"quick brown"~1^2') as PhraseQuery;
      expect(ast.slop).toBe(1);
      expect(ast.boost).toBe(2);
    });

    it('handles single-word phrase', () => {
      const ast = parser.parse('"hello"') as PhraseQuery;
      expect(ast.type).toBe('phrase');
      expect(ast.terms).toEqual(['hello']);
    });
  });

  describe('wildcard queries', () => {
    it('parses a suffix wildcard', () => {
      const ast = parser.parse('hel*') as WildcardQuery;
      expect(ast.type).toBe('wildcard');
      expect(ast.pattern).toBe('hel*');
    });

    it('parses a fielded wildcard', () => {
      const ast = parser.parse('title:hel*') as WildcardQuery;
      expect(ast.type).toBe('wildcard');
      expect(ast.field).toBe('title');
    });

    it('parses a ? single-char wildcard', () => {
      const ast = parser.parse('typ?') as WildcardQuery;
      expect(ast.type).toBe('wildcard');
      expect(ast.pattern).toBe('typ?');
    });

    it('lowercases wildcard pattern', () => {
      expect((parser.parse('Type*') as WildcardQuery).pattern).toBe('type*');
    });

    it('parses a wildcard with boost', () => {
      expect((parser.parse('type*^2') as WildcardQuery).boost).toBe(2);
    });
  });

  describe('boolean queries', () => {
    it('parses AND — both sides become must', () => {
      const ast = parser.parse('foo AND bar') as BoolQuery;
      expect(ast.type).toBe('bool');
      expect(ast.must).toHaveLength(2);
      expect(ast.should).toBeUndefined();
    });

    it('parses OR — both sides become should', () => {
      const ast = parser.parse('foo OR bar') as BoolQuery;
      expect(ast.type).toBe('bool');
      expect(ast.should).toHaveLength(2);
      expect(ast.must).toBeUndefined();
    });

    it('parses NOT', () => {
      const ast = parser.parse('foo NOT bar') as BoolQuery;
      expect(ast.type).toBe('bool');
      expect(ast.mustNot).toHaveLength(1);
      expect((ast.mustNot![0] as TermQuery).term).toBe('bar');
    });

    it('parses + prefix as must', () => {
      const ast = parser.parse('+foo bar') as BoolQuery;
      expect(ast.type).toBe('bool');
      expect(ast.must).toHaveLength(1);
      expect((ast.must![0] as TermQuery).term).toBe('foo');
      expect(ast.should).toHaveLength(1);
    });

    it('parses - prefix as mustNot', () => {
      const ast = parser.parse('foo -bar') as BoolQuery;
      expect(ast.type).toBe('bool');
      expect(ast.mustNot).toHaveLength(1);
      expect(ast.should).toHaveLength(1);
    });

    it('treats space-separated terms as should', () => {
      const ast = parser.parse('foo bar baz') as BoolQuery;
      expect(ast.type).toBe('bool');
      expect(ast.should).toHaveLength(3);
    });

    it('single +term wraps in BoolQuery with must (not bare TermQuery)', () => {
      const ast = parser.parse('+foo') as BoolQuery;
      expect(ast.type).toBe('bool');
      expect(ast.must).toHaveLength(1);
      expect((ast.must![0] as TermQuery).term).toBe('foo');
    });

    it('single -term wraps in BoolQuery with mustNot', () => {
      const ast = parser.parse('-foo') as BoolQuery;
      expect(ast.type).toBe('bool');
      expect(ast.mustNot).toHaveLength(1);
      expect((ast.mustNot![0] as TermQuery).term).toBe('foo');
    });

    it('standalone NOT term wraps in BoolQuery with mustNot', () => {
      const ast = parser.parse('NOT foo') as BoolQuery;
      expect(ast.type).toBe('bool');
      expect(ast.mustNot).toHaveLength(1);
      expect((ast.mustNot![0] as TermQuery).term).toBe('foo');
    });

    it('mixed AND/should: AND upgrades terms to must, remaining are should', () => {
      const ast = parser.parse('foo AND bar baz') as BoolQuery;
      expect(ast.must).toHaveLength(2);
      expect(ast.should).toHaveLength(1);
      expect((ast.should![0] as TermQuery).term).toBe('baz');
    });

    it('multiple must and mustNot clauses', () => {
      const ast = parser.parse('+foo +bar -baz') as BoolQuery;
      expect(ast.must).toHaveLength(2);
      expect(ast.mustNot).toHaveLength(1);
      expect(ast.should).toBeUndefined();
    });
  });

  describe('range queries', () => {
    it('parses a bare range', () => {
      const ast = parser.parse('[2020 TO 2024]') as RangeQuery;
      expect(ast.type).toBe('range');
      expect(ast.min).toBe('2020');
      expect(ast.max).toBe('2024');
      expect(ast.inclusive).toBe(true);
    });

    it('parses a fielded range', () => {
      const ast = parser.parse('year:[2020 TO 2024]') as RangeQuery;
      expect(ast.field).toBe('year');
      expect(ast.min).toBe('2020');
      expect(ast.max).toBe('2024');
    });
  });

  describe('grouping', () => {
    it('parses a grouped expression', () => {
      const ast = parser.parse('(foo OR bar)') as BoolQuery;
      expect(ast.type).toBe('bool');
      expect(ast.should).toHaveLength(2);
    });

    it('applies boost to a group', () => {
      const ast = parser.parse('(foo OR bar)^2') as BoolQuery;
      expect(ast.boost).toBe(2);
      expect(ast.should).toHaveLength(2);
    });

    it('grouped expression as must clause', () => {
      const ast = parser.parse('+(foo OR bar) +baz') as BoolQuery;
      expect(ast.must).toHaveLength(2);
    });
  });
});
