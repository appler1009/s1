import { describe, it, expect, beforeEach } from 'bun:test';
import { MemoryIndexDirectory } from '../directory.js';
import { createIndex } from '../index.js';
import type { Schema } from '../types.js';

const schema: Schema = {
  fields: {
    id:      { type: 'keyword', store: true,  indexed: true  },
    title:   { type: 'text',    store: true,  indexed: true,  boost: 2.0 },
    body:    { type: 'text',    store: false, indexed: true  },
    snippet: { type: 'text',    store: true,  indexed: false },
    tags:    { type: 'keyword', store: true,  indexed: true,  analyzer: 'keyword' },
    url:     { type: 'keyword', store: true,  indexed: false },
  },
};

function makeIndex() {
  const dir = new MemoryIndexDirectory();
  return { dir, ...createIndex(dir, schema) };
}

// ─── Basic write + read ───────────────────────────────────────────────────────

describe('single-segment basic search', () => {
  it('finds a document by title term', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'doc-1', title: 'Hello World', body: 'Some body text' });
    await writer.commit();

    const results = await searcher.search('hello');
    expect(results).toHaveLength(1);
    expect(results[0]!.docId).toBe('doc-1');
  });

  it('returns stored fields', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'a', title: 'TypeScript rocks', url: 'https://example.com', body: 'lang' });
    await writer.commit();

    const [r] = await searcher.search('typescript');
    expect(r!.doc['title']).toBe('TypeScript rocks');
    expect(r!.doc['url']).toBe('https://example.com');
    expect(r!.doc['body']).toBeUndefined(); // body is not stored
  });

  it('returns empty when no match', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'a', title: 'Hello World' });
    await writer.commit();

    const results = await searcher.search('nonexistent');
    expect(results).toHaveLength(0);
  });

  it('scores more relevant documents higher', async () => {
    const { writer, searcher } = makeIndex();
    // 'search' appears in both title (boosted) and body
    await writer.addDocument({ id: 'high', title: 'search engine design', body: 'about search' });
    // 'search' appears only in body
    await writer.addDocument({ id: 'low',  title: 'introduction to databases', body: 'full-text search' });
    await writer.commit();

    const results = await searcher.search('search');
    expect(results[0]!.docId).toBe('high');
  });
});

// ─── Phrase queries ───────────────────────────────────────────────────────────

describe('phrase queries', () => {
  it('matches phrase', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: '1', title: 'quick brown fox' });
    await writer.addDocument({ id: '2', title: 'quick fox brown' });
    await writer.commit();

    const results = await searcher.search('"quick brown fox"');
    expect(results.map(r => r.docId)).toContain('1');
  });
});

// ─── Wildcard queries ─────────────────────────────────────────────────────────

describe('wildcard queries', () => {
  it('matches suffix wildcard', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: '1', title: 'typescript language' });
    await writer.addDocument({ id: '2', title: 'typesafe code' });
    await writer.addDocument({ id: '3', title: 'python language' });
    await writer.commit();

    const results = await searcher.search('title:types*');
    const ids = results.map(r => r.docId);
    expect(ids).toContain('1');
    expect(ids).toContain('2');
    expect(ids).not.toContain('3');
  });
});

// ─── Boolean queries ──────────────────────────────────────────────────────────

describe('boolean queries', () => {
  it('AND query requires both terms', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: '1', title: 'foo bar' });
    await writer.addDocument({ id: '2', title: 'foo baz' });
    await writer.addDocument({ id: '3', title: 'bar only' });
    await writer.commit();

    const results = await searcher.search('+foo +bar');
    const ids = results.map(r => r.docId);
    expect(ids).toContain('1');
    expect(ids).not.toContain('2');
    expect(ids).not.toContain('3');
  });

  it('NOT query excludes documents', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: '1', title: 'foo bar' });
    await writer.addDocument({ id: '2', title: 'foo baz' });
    await writer.commit();

    const results = await searcher.search('foo -bar');
    const ids = results.map(r => r.docId);
    expect(ids).toContain('2');
    expect(ids).not.toContain('1');
  });
});

// ─── Deletions ────────────────────────────────────────────────────────────────

describe('deletions (tombstones)', () => {
  it('excludes deleted documents from results', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'keep', title: 'hello world' });
    await writer.addDocument({ id: 'gone', title: 'hello world' });
    await writer.deleteById('gone');
    await writer.commit();

    const results = await searcher.search('hello');
    const ids = results.map(r => r.docId);
    expect(ids).toContain('keep');
    expect(ids).not.toContain('gone');
  });
});

// ─── Multi-segment search ─────────────────────────────────────────────────────

describe('multi-segment search', () => {
  it('merges results across segments correctly', async () => {
    const { writer, searcher } = makeIndex();

    // Segment 1
    await writer.addDocument({ id: 'seg1-doc1', title: 'alpha beta' });
    await writer.addDocument({ id: 'seg1-doc2', title: 'gamma delta' });
    await writer.commit();

    // Segment 2
    await writer.addDocument({ id: 'seg2-doc1', title: 'alpha gamma' });
    await writer.commit();

    const results = await searcher.search('alpha');
    const ids = new Set(results.map(r => r.docId));
    expect(ids.has('seg1-doc1')).toBe(true);
    expect(ids.has('seg2-doc1')).toBe(true);
    expect(ids.has('seg1-doc2')).toBe(false);
  });

  it('respects topK across segments', async () => {
    const { writer, searcher } = makeIndex();

    for (let i = 0; i < 5; i++) {
      await writer.addDocument({ id: `a-${i}`, title: 'common term here' });
      await writer.commit();
    }

    const results = await searcher.search('common', { topK: 3 });
    expect(results).toHaveLength(3);
  });
});

// ─── topK and filter ──────────────────────────────────────────────────────────

describe('topK and filter options', () => {
  it('limits results to topK', async () => {
    const { writer, searcher } = makeIndex();
    for (let i = 0; i < 10; i++) {
      await writer.addDocument({ id: `d${i}`, title: 'common' });
    }
    await writer.commit();

    const results = await searcher.search('common', { topK: 3 });
    expect(results).toHaveLength(3);
  });

  it('applies filter function', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'pass', title: 'hello world', tags: 'good' });
    await writer.addDocument({ id: 'fail', title: 'hello world', tags: 'bad' });
    await writer.commit();

    const results = await searcher.search('hello', {
      filter: doc => doc['tags'] === 'good',
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.docId).toBe('pass');
  });
});

// ─── commitThreshold auto-flush ───────────────────────────────────────────────

describe('auto-commit on threshold', () => {
  it('creates multiple segments when threshold is exceeded', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir, schema, { commitThreshold: 3 });

    for (let i = 0; i < 7; i++) {
      await writer.addDocument({ id: `d${i}`, title: `document ${i}` });
    }
    await writer.close();

    const manifest = await dir.readJson<{ segments: string[] }>('segments.json');
    // 7 docs / 3 threshold = 2 auto commits + 1 final = at least 2 segments
    expect(manifest.segments.length).toBeGreaterThanOrEqual(2);

    const results = await searcher.search('document');
    expect(results.length).toBeGreaterThanOrEqual(7);
  });
});
