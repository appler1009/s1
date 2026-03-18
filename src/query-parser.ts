import type { QueryAST, BoolQuery, TermQuery, PhraseQuery, RangeQuery, WildcardQuery } from './types.js';

const SPECIAL_CHARS = new Set([' ', '\t', '\n', ':', '"', '(', ')', '[', ']', '^', '+', '-']);

/**
 * Hand-written recursive-descent parser for a Lucene-inspired query syntax.
 *
 * Supported syntax:
 *   term                       → simple term
 *   field:term                 → fielded term
 *   "phrase query"             → phrase
 *   field:"phrase query"       → fielded phrase
 *   term^2.0                   → boost
 *   term*                      → leading wildcard or suffix wildcard
 *   [min TO max]               → range (numeric or date string)
 *   +must -mustnot should      → boolean prefix operators
 *   term AND term              → boolean AND
 *   term OR term               → boolean OR
 *   NOT term                   → negate
 *   (nested group)             → grouping
 */
export class LuceneQueryParser {
  private pos = 0;
  private input = '';

  parse(queryStr: string): QueryAST {
    this.input = queryStr.trim();
    this.pos = 0;

    const ast = this.parseBool();
    return ast;
  }

  // ─── Grammar levels ───────────────────────────────────────────────────────

  /** Top-level: collect clauses, hoisting +/- and AND/OR into a BoolQuery. */
  private parseBool(): QueryAST {
    const clauses: Array<{ occur: 'must' | 'should' | 'mustNot'; node: QueryAST }> = [];

    while (!this.eof()) {
      this.skipWs();
      if (this.eof()) break;
      if (this.ch() === ')') break; // group terminator — let parseGroup consume it

      // Detect explicit OR connector (between two equal-priority terms)
      if (this.peek(2) === 'OR' && this.isWordBoundaryAt(this.pos + 2)) {
        this.pos += 2;
        this.skipWs();
        continue; // OR is default; just keep parsing
      }

      // Detect AND connector (force 'must' on both sides)
      if (this.peek(3) === 'AND' && this.isWordBoundaryAt(this.pos + 3)) {
        this.pos += 3;
        this.skipWs();
        // Upgrade last clause to must
        const last = clauses[clauses.length - 1];
        if (last && last.occur === 'should') last.occur = 'must';
        // Next clause also becomes must
        const node = this.parseUnary();
        clauses.push({ occur: 'must', node });
        continue;
      }

      // NOT prefix
      if (this.peek(3) === 'NOT' && this.isWordBoundaryAt(this.pos + 3)) {
        this.pos += 3;
        this.skipWs();
        const node = this.parseUnary();
        clauses.push({ occur: 'mustNot', node });
        continue;
      }

      // + / - prefix operators
      if (this.ch() === '+') {
        this.pos++;
        const node = this.parseUnary();
        clauses.push({ occur: 'must', node });
        continue;
      }
      if (this.ch() === '-') {
        this.pos++;
        const node = this.parseUnary();
        clauses.push({ occur: 'mustNot', node });
        continue;
      }

      const node = this.parseUnary();
      clauses.push({ occur: 'should', node });
    }

    if (clauses.length === 0) return { type: 'term', term: '' };
    if (clauses.length === 1 && clauses[0]!.occur === 'should') return clauses[0]!.node;

    const must: QueryAST[] = [];
    const should: QueryAST[] = [];
    const mustNot: QueryAST[] = [];

    for (const c of clauses) {
      if (c.occur === 'must') must.push(c.node);
      else if (c.occur === 'mustNot') mustNot.push(c.node);
      else should.push(c.node);
    }

    const bool: BoolQuery = { type: 'bool' };
    if (must.length) bool.must = must;
    if (should.length) bool.should = should;
    if (mustNot.length) bool.mustNot = mustNot;
    return bool;
  }

  private parseUnary(): QueryAST {
    this.skipWs();
    if (this.ch() === '(') return this.parseGroup();
    if (this.ch() === '[') return this.parseRange();
    return this.parseAtom();
  }

  private parseGroup(): QueryAST {
    this.pos++; // consume '('
    const inner = this.parseBool();
    this.skipWs();
    if (this.ch() === ')') this.pos++;

    const boost = this.parseBoost();
    if (boost !== undefined) {
      return { ...inner, boost };
    }
    return inner;
  }

  /** [min TO max] */
  private parseRange(): QueryAST {
    this.pos++; // consume '['
    this.skipWs();

    const min = this.readUntil(' ');
    this.skipWs();
    // consume 'TO'
    if (this.peek(2) === 'TO') this.pos += 2;
    this.skipWs();

    const max = this.readUntil(']');
    if (this.ch() === ']') this.pos++;

    const boost = this.parseBoost();
    const range: RangeQuery = {
      type: 'range',
      field: '_default_',
      min: min || undefined,
      max: max || undefined,
      inclusive: true,
    };
    if (boost !== undefined) range.boost = boost;
    return range;
  }

  /** field:term, "phrase", term, wildcard */
  private parseAtom(): QueryAST {
    const start = this.pos;

    // Check for quoted phrase (no field prefix)
    if (this.ch() === '"') {
      const phrase = this.readPhrase();
      const slop  = this.parseSlop();
      const boost = this.parseBoost();
      const pq: PhraseQuery = { type: 'phrase', terms: phrase };
      if (slop  !== undefined) pq.slop  = slop;
      if (boost !== undefined) pq.boost = boost;
      return pq;
    }

    // Read raw token (may be "field:" prefix or bare term)
    const token = this.readToken();
    if (!token) {
      this.pos = start + 1; // skip unknown char
      return { type: 'term', term: '' };
    }

    // Check for field: separator
    if (this.ch() === ':') {
      this.pos++; // consume ':'
      const field = token;

      if (this.ch() === '"') {
        const terms = this.readPhrase();
        const slop  = this.parseSlop();
        const boost = this.parseBoost();
        const pq: PhraseQuery = { type: 'phrase', field, terms };
        if (slop  !== undefined) pq.slop  = slop;
        if (boost !== undefined) pq.boost = boost;
        return pq;
      }

      if (this.ch() === '[') {
        const range = this.parseRange() as RangeQuery;
        range.field = field;
        return range;
      }

      const term = this.readToken();
      const boost = this.parseBoost();

      if (term.includes('*') || term.includes('?')) {
        const wq: WildcardQuery = { type: 'wildcard', field, pattern: term };
        if (boost !== undefined) wq.boost = boost;
        return wq;
      }
      const tq: TermQuery = { type: 'term', field, term: term.toLowerCase() };
      if (boost !== undefined) tq.boost = boost;
      return tq;
    }

    const boost = this.parseBoost();

    if (token.includes('*') || token.includes('?')) {
      const wq: WildcardQuery = { type: 'wildcard', pattern: token.toLowerCase() };
      if (boost !== undefined) wq.boost = boost;
      return wq;
    }

    const tq: TermQuery = { type: 'term', term: token.toLowerCase() };
    if (boost !== undefined) tq.boost = boost;
    return tq;
  }

  // ─── Lexer helpers ────────────────────────────────────────────────────────

  private readPhrase(): string[] {
    this.pos++; // consume opening "
    const terms: string[] = [];
    let buf = '';

    while (!this.eof() && this.ch() !== '"') {
      if (this.ch() === ' ' || this.ch() === '\t') {
        if (buf) { terms.push(buf.toLowerCase()); buf = ''; }
      } else {
        buf += this.input[this.pos];
      }
      this.pos++;
    }
    if (buf) terms.push(buf.toLowerCase());
    if (this.ch() === '"') this.pos++; // consume closing "
    return terms;
  }

  /** Read a contiguous non-whitespace, non-special token. */
  private readToken(): string {
    let buf = '';
    while (!this.eof() && !SPECIAL_CHARS.has(this.input[this.pos]!)) {
      buf += this.input[this.pos];
      this.pos++;
    }
    return buf;
  }

  private readUntil(stop: string): string {
    let buf = '';
    while (!this.eof() && this.input[this.pos] !== stop) {
      buf += this.input[this.pos++];
    }
    return buf.trim();
  }

  /** Try to consume ~N (phrase slop); returns the slop value or undefined. */
  private parseSlop(): number | undefined {
    if (this.ch() !== '~') return undefined;
    const saved = this.pos;
    this.pos++;
    const raw = this.readToken();
    const val = parseInt(raw, 10);
    if (isNaN(val)) { this.pos = saved; return undefined; }
    return val;
  }

  /** Try to consume ^N.N or ^N; returns the boost number or undefined. */
  private parseBoost(): number | undefined {
    if (this.ch() !== '^') return undefined;
    const saved = this.pos;
    this.pos++;
    const raw = this.readToken();
    const val = parseFloat(raw);
    if (isNaN(val)) { this.pos = saved; return undefined; } // restore if not numeric
    return val;
  }

  private skipWs(): void {
    while (!this.eof() && /\s/.test(this.input[this.pos]!)) this.pos++;
  }

  private ch(): string { return this.input[this.pos] ?? ''; }

  private peek(len: number): string { return this.input.slice(this.pos, this.pos + len); }

  private eof(): boolean { return this.pos >= this.input.length; }

  private isWordBoundaryAt(idx: number): boolean {
    const c = this.input[idx];
    return c === undefined || /\s/.test(c);
  }
}
