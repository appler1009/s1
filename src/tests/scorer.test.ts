import { describe, it, expect } from 'bun:test';
import { BM25Scorer, binarySearchPosting, wildcardToRegex } from '../scorer.js';
import type { ScoreContext, PostingsList, SegmentMeta } from '../types.js';

// ─── binarySearchPosting ──────────────────────────────────────────────────────

describe('binarySearchPosting', () => {
  const postings = [
    { docId: 0, tf: 1, pos: [1] },
    { docId: 3, tf: 2, pos: [1, 5] },
    { docId: 7, tf: 1, pos: [2] },
    { docId: 10, tf: 3, pos: [1, 3, 7] },
  ];

  it('finds a posting at the start', () => {
    expect(binarySearchPosting(postings, 0)?.docId).toBe(0);
  });

  it('finds a posting in the middle', () => {
    expect(binarySearchPosting(postings, 7)?.docId).toBe(7);
  });

  it('finds a posting at the end', () => {
    expect(binarySearchPosting(postings, 10)?.docId).toBe(10);
  });

  it('returns undefined for a missing docId', () => {
    expect(binarySearchPosting(postings, 5)).toBeUndefined();
  });

  it('returns undefined for an id below the range', () => {
    expect(binarySearchPosting(postings, -1)).toBeUndefined();
  });

  it('returns undefined for an id above the range', () => {
    expect(binarySearchPosting(postings, 999)).toBeUndefined();
  });

  it('returns undefined for an empty postings array', () => {
    expect(binarySearchPosting([], 1)).toBeUndefined();
  });

  it('returns the full posting object (tf and pos)', () => {
    const p = binarySearchPosting(postings, 3);
    expect(p?.tf).toBe(2);
    expect(p?.pos).toEqual([1, 5]);
  });
});

// ─── wildcardToRegex ──────────────────────────────────────────────────────────

describe('wildcardToRegex', () => {
  it('matches a prefix wildcard (hel*)', () => {
    const re = wildcardToRegex('hel*');
    expect(re.test('hello')).toBe(true);
    expect(re.test('help')).toBe(true);
    expect(re.test('hel')).toBe(true);
    expect(re.test('world')).toBe(false);
  });

  it('* matches zero characters', () => {
    expect(wildcardToRegex('hel*').test('hel')).toBe(true);
  });

  it('matches a suffix wildcard (*fox)', () => {
    expect(wildcardToRegex('*fox').test('quickfox')).toBe(true);
    expect(wildcardToRegex('*fox').test('fox')).toBe(true);
  });

  it('matches a contains wildcard (*el*)', () => {
    expect(wildcardToRegex('*el*').test('hello')).toBe(true);
    expect(wildcardToRegex('*el*').test('world')).toBe(false);
  });

  it('matches a ? single-char wildcard', () => {
    const re = wildcardToRegex('hel?o');
    expect(re.test('hello')).toBe(true);
    expect(re.test('helpo')).toBe(true);
    expect(re.test('helloo')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(wildcardToRegex('hel*').test('HELlo')).toBe(true);
  });

  it('escapes regex special characters in the literal part', () => {
    // '.' in the pattern should match only a literal '.' not any character
    expect(wildcardToRegex('v1.0').test('v1.0')).toBe(true);
    expect(wildcardToRegex('v1.0').test('v1x0')).toBe(false);
  });

  it('anchors the match (no partial matches)', () => {
    expect(wildcardToRegex('hel*').test('xhello')).toBe(false);
  });
});

// ─── BM25Scorer ───────────────────────────────────────────────────────────────

function makeSegmentMeta(docCount: number, avgLength: number): SegmentMeta {
  return {
    segmentId: 'seg-000001',
    docCount,
    createdAt: new Date().toISOString(),
    fields: { title: { docCount, avgLength } },
  };
}

function makePostingsMap(
  entries: Array<{ key: string; df: number; docId: number; tf: number; pos?: number[] }>,
): Map<string, PostingsList> {
  const m = new Map<string, PostingsList>();
  for (const e of entries) {
    const existing = m.get(e.key);
    const posting = { docId: e.docId, tf: e.tf, pos: e.pos ?? [1] };
    if (existing) {
      existing.postings.push(posting);
      existing.postings.sort((a, b) => a.docId - b.docId);
    } else {
      m.set(e.key, { df: e.df, postings: [posting] });
    }
  }
  return m;
}

describe('BM25Scorer', () => {
  const scorer = new BM25Scorer();

  it('returns a positive score when the term is found', () => {
    const ctx: ScoreContext = {
      query: { type: 'term', field: 'title', term: 'hello' },
      docId: 0,
      segmentMeta: makeSegmentMeta(2, 1),
      postingsMap: makePostingsMap([{ key: 'title:hello', df: 1, docId: 0, tf: 1 }]),
      config: {},
      fieldLengths: { title: 1 },
    };
    expect(scorer.score(ctx)).toBeGreaterThan(0);
  });

  it('returns 0 when the term is absent from postingsMap', () => {
    const ctx: ScoreContext = {
      query: { type: 'term', field: 'title', term: 'missing' },
      docId: 0,
      segmentMeta: makeSegmentMeta(2, 1),
      postingsMap: makePostingsMap([{ key: 'title:hello', df: 1, docId: 0, tf: 1 }]),
      config: {},
      fieldLengths: { title: 1 },
    };
    expect(scorer.score(ctx)).toBe(0);
  });

  it('returns 0 when docId is absent from the postings list', () => {
    const ctx: ScoreContext = {
      query: { type: 'term', field: 'title', term: 'hello' },
      docId: 99,
      segmentMeta: makeSegmentMeta(2, 1),
      postingsMap: makePostingsMap([{ key: 'title:hello', df: 1, docId: 0, tf: 1 }]),
      config: {},
      fieldLengths: { title: 1 },
    };
    expect(scorer.score(ctx)).toBe(0);
  });

  it('applies per-field boost from config', () => {
    const base: ScoreContext = {
      query: { type: 'term', field: 'title', term: 'hello' },
      docId: 0,
      segmentMeta: makeSegmentMeta(2, 1),
      postingsMap: makePostingsMap([{ key: 'title:hello', df: 1, docId: 0, tf: 1 }]),
      config: {},
      fieldLengths: { title: 1 },
    };
    const boosted: ScoreContext = { ...base, config: { boost: { title: 2.0 } } };
    expect(scorer.score(boosted)).toBeCloseTo(scorer.score(base) * 2);
  });

  it('applies per-term boost from query node', () => {
    const base: ScoreContext = {
      query: { type: 'term', field: 'title', term: 'hello' },
      docId: 0,
      segmentMeta: makeSegmentMeta(2, 1),
      postingsMap: makePostingsMap([{ key: 'title:hello', df: 1, docId: 0, tf: 1 }]),
      config: {},
      fieldLengths: { title: 1 },
    };
    const boosted: ScoreContext = {
      ...base,
      query: { type: 'term', field: 'title', term: 'hello', boost: 3 },
    };
    expect(scorer.score(boosted)).toBeCloseTo(scorer.score(base) * 3);
  });

  it('shorter documents score higher (BM25 length normalisation)', () => {
    // Same term, same tf=1, same df — shorter doc should win
    const pm = makePostingsMap([
      { key: 'title:search', df: 2, docId: 0, tf: 1 },
      { key: 'title:search', df: 2, docId: 1, tf: 1 },
    ]);
    const meta = makeSegmentMeta(2, 5);

    const shortCtx: ScoreContext = {
      query: { type: 'term', field: 'title', term: 'search' },
      docId: 0, segmentMeta: meta, postingsMap: pm, config: {},
      fieldLengths: { title: 1 },  // short doc
    };
    const longCtx: ScoreContext = {
      ...shortCtx,
      docId: 1,
      fieldLengths: { title: 10 }, // long doc
    };
    expect(scorer.score(shortCtx)).toBeGreaterThan(scorer.score(longCtx));
  });

  it('higher tf yields higher score', () => {
    const pm = new Map<string, PostingsList>();
    pm.set('title:search', {
      df: 1,
      postings: [
        { docId: 0, tf: 1, pos: [1] },
        { docId: 1, tf: 5, pos: [1, 2, 3, 4, 5] },
      ],
    });
    const meta = makeSegmentMeta(2, 5);

    const lowTf: ScoreContext = {
      query: { type: 'term', field: 'title', term: 'search' },
      docId: 0, segmentMeta: meta, postingsMap: pm, config: {}, fieldLengths: { title: 5 },
    };
    const highTf: ScoreContext = { ...lowTf, docId: 1 };
    expect(scorer.score(highTf)).toBeGreaterThan(scorer.score(lowTf));
  });

  it('scores unfielded term across all matching fields', () => {
    const pm = makePostingsMap([
      { key: 'title:hello', df: 1, docId: 0, tf: 1 },
      { key: 'body:hello',  df: 1, docId: 0, tf: 1 },
    ]);
    const meta: SegmentMeta = {
      segmentId: 'seg-000001',
      docCount: 1,
      createdAt: new Date().toISOString(),
      fields: {
        title: { docCount: 1, avgLength: 1 },
        body:  { docCount: 1, avgLength: 1 },
      },
    };
    const fielded: ScoreContext = {
      query: { type: 'term', field: 'title', term: 'hello' },
      docId: 0, segmentMeta: meta, postingsMap: pm, config: {},
      fieldLengths: { title: 1, body: 1 },
    };
    const unfielded: ScoreContext = {
      ...fielded,
      query: { type: 'term', term: 'hello' },
    };
    // Unfielded sums both fields → higher than fielded (title only)
    expect(scorer.score(unfielded)).toBeGreaterThan(scorer.score(fielded));
  });

  it('sums scores for BoolQuery with multiple must-clauses', () => {
    const pm = makePostingsMap([
      { key: 'title:foo', df: 1, docId: 0, tf: 1 },
      { key: 'title:bar', df: 1, docId: 0, tf: 1 },
    ]);
    const meta = makeSegmentMeta(1, 2);
    const singleCtx: ScoreContext = {
      query: { type: 'term', field: 'title', term: 'foo' },
      docId: 0, segmentMeta: meta, postingsMap: pm, config: {},
      fieldLengths: { title: 2 },
    };
    const boolCtx: ScoreContext = {
      ...singleCtx,
      query: { type: 'bool', must: [
        { type: 'term', field: 'title', term: 'foo' },
        { type: 'term', field: 'title', term: 'bar' },
      ]},
    };
    expect(scorer.score(boolCtx)).toBeGreaterThan(scorer.score(singleCtx));
  });
});
