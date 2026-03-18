import { describe, it, expect } from 'bun:test';
import { LuceneQueryParser } from '../query-parser.js';
import type { TermQuery, PhraseQuery, BoolQuery, WildcardQuery } from '../types.js';

const parser = new LuceneQueryParser();

describe('LuceneQueryParser', () => {
  describe('term queries', () => {
    it('parses a bare term', () => {
      const ast = parser.parse('hello') as TermQuery;
      expect(ast.type).toBe('term');
      expect(ast.term).toBe('hello');
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
  });

  describe('wildcard queries', () => {
    it('parses a wildcard term', () => {
      const ast = parser.parse('hel*') as WildcardQuery;
      expect(ast.type).toBe('wildcard');
      expect(ast.pattern).toBe('hel*');
    });

    it('parses a fielded wildcard', () => {
      const ast = parser.parse('title:hel*') as WildcardQuery;
      expect(ast.type).toBe('wildcard');
      expect(ast.field).toBe('title');
    });
  });

  describe('boolean queries', () => {
    it('parses AND', () => {
      const ast = parser.parse('foo AND bar') as BoolQuery;
      expect(ast.type).toBe('bool');
      expect(ast.must).toHaveLength(2);
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
    });

    it('parses - prefix as mustNot', () => {
      const ast = parser.parse('foo -bar') as BoolQuery;
      expect(ast.type).toBe('bool');
      expect(ast.mustNot).toHaveLength(1);
    });

    it('treats space-separated terms as should', () => {
      const ast = parser.parse('foo bar baz') as BoolQuery;
      expect(ast.type).toBe('bool');
      expect(ast.should).toHaveLength(3);
    });
  });

  describe('range queries', () => {
    it('parses a range', () => {
      const ast = parser.parse('[2020 TO 2024]');
      expect(ast.type).toBe('range');
    });
  });
});
