import { describe, it, expect } from 'bun:test';
import { MemoryIndexDirectory } from '../directory.js';
import { createIndex } from '../index.js';

function makeIndex() {
  const dir = new MemoryIndexDirectory();
  return {
    dir,
    ...createIndex(dir, {
      analyzers: { id: 'keyword', tags: 'keyword' },
      noStore:   ['body'],
      noIndex:   ['url', 'snippet'],
      boost:     { title: 2.0 },
    }),
  };
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

  it('returns stored fields, omits noStore fields', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'a', title: 'TypeScript rocks', url: 'https://example.com', body: 'lang' });
    await writer.commit();

    const [r] = await searcher.search('typescript');
    expect(r!.doc['title']).toBe('TypeScript rocks');
    expect(r!.doc['url']).toBe('https://example.com');   // stored via noIndex
    expect(r!.doc['body']).toBeUndefined();               // noStore: indexed only
  });

  it('returns empty when no match', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'a', title: 'Hello World' });
    await writer.commit();

    expect(await searcher.search('nonexistent')).toHaveLength(0);
  });

  it('scores more relevant documents higher', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'high', title: 'search engine design', body: 'about search' });
    await writer.addDocument({ id: 'low',  title: 'introduction to databases', body: 'full-text search' });
    await writer.commit();

    const results = await searcher.search('search');
    expect(results[0]!.docId).toBe('high');
  });
});

// ─── noStore / noIndex ────────────────────────────────────────────────────────

describe('noStore and noIndex behaviour', () => {
  it('noStore field is searchable but absent from results', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir, { noStore: ['body'] });

    await writer.addDocument({ id: '1', body: 'searchable content' });
    await writer.commit();

    const results = await searcher.search('searchable');
    expect(results).toHaveLength(1);
    expect(results[0]!.doc['body']).toBeUndefined();
  });

  it('noIndex field is stored but not searchable', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir, { noIndex: ['url'] });

    await writer.addDocument({ id: '1', title: 'hello', url: 'https://example.com' });
    await writer.commit();

    // searching on url term should find nothing (not indexed)
    const byUrl = await searcher.search('url:example');
    expect(byUrl).toHaveLength(0);

    // but the url value appears in the stored doc
    const byTitle = await searcher.search('hello');
    expect(byTitle[0]!.doc['url']).toBe('https://example.com');
  });
});

// ─── Phrase queries ───────────────────────────────────────────────────────────

describe('phrase queries', () => {
  it('matches exact phrase by position', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: '1', title: 'quick brown fox' });
    await writer.addDocument({ id: '2', title: 'quick fox brown' }); // wrong order
    await writer.commit();

    const results = await searcher.search('"quick brown fox"');
    const ids = results.map(r => r.docId);
    expect(ids).toContain('1');
    expect(ids).not.toContain('2'); // "quick fox brown" doesn't match the phrase order
  });

  it('matches phrase with slop', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: '1', title: 'quick brown fox' });
    await writer.addDocument({ id: '2', title: 'quick very brown fox' }); // 1 word gap
    await writer.addDocument({ id: '3', title: 'quick slow safe brown fox' }); // 2 word gap
    await writer.commit();

    const slop1 = await searcher.search('"quick brown"~1');
    const ids1 = slop1.map(r => r.docId);
    expect(ids1).toContain('1');
    expect(ids1).toContain('2');
    expect(ids1).not.toContain('3'); // gap=2 exceeds slop=1

    // slop=0 requires adjacency
    const slop0 = await searcher.search('"quick brown"');
    const ids0 = slop0.map(r => r.docId);
    expect(ids0).toContain('1');
    expect(ids0).not.toContain('2');
  });

  it('phrase in should clause enforces position order', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: '1', title: 'quick brown fox' });
    await writer.addDocument({ id: '2', title: 'quick fox brown' }); // wrong order
    await writer.commit();

    // "quick brown" is a should clause here; it must still position-check
    const results = await searcher.search('"quick brown" OR "lazy dog"');
    const ids = results.map(r => r.docId);
    expect(ids).toContain('1');
    expect(ids).not.toContain('2');
  });

  it('stop word in phrase does not prevent matching', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir);
    await writer.addDocument({ id: '1', title: 'the quick brown fox' });
    await writer.commit();

    // "the" is a stop word; phrase should match with correct position gaps
    const results = await searcher.search('"the quick brown"');
    expect(results.map(r => r.docId)).toContain('1');
  });
});

// ─── Range queries ────────────────────────────────────────────────────────────

describe('range queries', () => {
  it('throws a helpful error', async () => {
    const { searcher } = makeIndex();
    await expect(searcher.search('[2020 TO 2024]')).rejects.toThrow(
      'Range queries ([min TO max]) are not yet implemented',
    );
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
  it('excludes deleted documents from results (same segment)', async () => {
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

  it('cross-segment deletion: tombstone in later segment excludes doc in earlier segment', async () => {
    const { writer, searcher } = makeIndex();

    await writer.addDocument({ id: 'keep', title: 'hello world' });
    await writer.addDocument({ id: 'gone', title: 'hello world' });
    await writer.commit(); // seg 1: both docs

    await writer.deleteById('gone');
    await writer.commit(); // seg 2: tombstone only

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

    await writer.addDocument({ id: 'seg1-doc1', title: 'alpha beta' });
    await writer.addDocument({ id: 'seg1-doc2', title: 'gamma delta' });
    await writer.commit();

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

    expect(await searcher.search('common', { topK: 3 })).toHaveLength(3);
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

    expect(await searcher.search('common', { topK: 3 })).toHaveLength(3);
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
    const { writer, searcher } = createIndex(dir, {}, { commitThreshold: 3 });

    for (let i = 0; i < 7; i++) {
      await writer.addDocument({ id: `d${i}`, title: `document ${i}` });
    }
    await writer.close();

    const manifest = await dir.readJson<{ segments: string[] }>('segments.json');
    expect(manifest.segments.length).toBeGreaterThanOrEqual(2);

    const results = await searcher.search('document');
    expect(results.length).toBeGreaterThanOrEqual(7);
  });
});

// ─── Writer lifecycle guards ───────────────────────────────────────────────────

describe('writer lifecycle', () => {
  it('throws on addDocument after close()', async () => {
    const { writer } = makeIndex();
    await writer.addDocument({ id: '1', title: 'hello' });
    await writer.close();
    await expect(writer.addDocument({ id: '2', title: 'world' }))
      .rejects.toThrow('IndexWriter has been closed');
  });

  it('throws on commit() after close()', async () => {
    const { writer } = makeIndex();
    await writer.close();
    await expect(writer.commit()).rejects.toThrow('IndexWriter has been closed');
  });

  it('second close() is a no-op', async () => {
    const { writer } = makeIndex();
    await writer.addDocument({ id: '1', title: 'hello' });
    await writer.close();
    await expect(writer.close()).resolves.toBeUndefined();
  });
});

// ─── Keyword analyzer term collision ─────────────────────────────────────────

describe('keyword analyzer — special characters', () => {
  it('distinguishes terms that differ only by special characters', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir, { analyzers: { code: 'keyword' } });

    // Use '.' and '_' — both are non-query-operator chars that previously
    // both sanitized to '_', causing a filename collision and broken postings.
    await writer.addDocument({ id: 'a', code: 'v1.0' });
    await writer.addDocument({ id: 'b', code: 'v1_0' });
    await writer.commit();

    const byDot        = await searcher.search('code:v1.0');
    const byUnderscore = await searcher.search('code:v1_0');

    expect(byDot.map(r => r.docId)).toEqual(['a']);
    expect(byUnderscore.map(r => r.docId)).toEqual(['b']);
  });
});

// ─── mustNot-only queries (single-clause parseBool fix) ───────────────────────

describe('mustNot-only queries', () => {
  it('standalone NOT term excludes matching documents', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'java-doc', title: 'java programming' });
    await writer.addDocument({ id: 'ts-doc',   title: 'typescript programming' });
    await writer.commit();

    // Before the fix, "NOT java" returned a bare TermQuery and matched java-doc.
    const results = await searcher.search('NOT java');
    const ids = results.map(r => r.docId);
    expect(ids).not.toContain('java-doc');
    // ts-doc has no must clause to satisfy, so it returns 0 score — typical Lucene
    // behaviour for mustNot-only is no results unless there are also positive clauses.
    // We just verify the negation is honoured.
    expect(ids).not.toContain('java-doc');
  });

  it('minus prefix alone excludes matching documents', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'java-doc', title: 'java programming' });
    await writer.addDocument({ id: 'ts-doc',   title: 'typescript rocks' });
    await writer.commit();

    const results = await searcher.search('typescript -java');
    const ids = results.map(r => r.docId);
    expect(ids).toContain('ts-doc');
    expect(ids).not.toContain('java-doc');
  });
});

// ─── Boosting ─────────────────────────────────────────────────────────────────

describe('boosting', () => {
  it('field boost promotes matches in boosted field', async () => {
    const dir = new MemoryIndexDirectory();
    // title is boosted 3x; body matches should rank lower
    const { writer, searcher } = createIndex(dir, { noStore: ['body'], boost: { title: 3.0 } });

    await writer.addDocument({ id: 'title-match', title: 'search',  body: 'other content' });
    await writer.addDocument({ id: 'body-match',  title: 'other',   body: 'search content' });
    await writer.commit();

    const results = await searcher.search('search');
    expect(results[0]!.docId).toBe('title-match');
  });

  it('term boost (^N) raises a specific term score', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'high', title: 'typescript' });
    await writer.addDocument({ id: 'low',  title: 'javascript' });
    await writer.commit();

    // Without boost both should appear; with boost typescript should be first
    const results = await searcher.search('typescript^5 OR javascript');
    expect(results[0]!.docId).toBe('high');
  });
});

// ─── TF > 1 ───────────────────────────────────────────────────────────────────

describe('term frequency > 1', () => {
  it('document with repeated term scores higher than one with a single occurrence', async () => {
    const { writer, searcher } = makeIndex();
    // 'search' appears 5 times in high, once in low
    await writer.addDocument({ id: 'high', title: 'search search search search search' });
    await writer.addDocument({ id: 'low',  title: 'search framework overview here now' });
    await writer.commit();

    const results = await searcher.search('search');
    expect(results[0]!.docId).toBe('high');
  });
});

// ─── Non-string field types ───────────────────────────────────────────────────

describe('non-string field indexing', () => {
  it('indexes a numeric field and finds it by term search', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'doc', year: 2024 });
    await writer.commit();

    const results = await searcher.search('year:2024');
    expect(results.map(r => r.docId)).toContain('doc');
  });

  it('indexes a Date field and finds it via ISO-string term', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir);
    const d = new Date('2024-01-15T00:00:00.000Z');
    await writer.addDocument({ id: 'doc', created: d });
    await writer.commit();

    // Standard analyzer will split the ISO string on non-word chars into tokens
    const results = await searcher.search('created:2024');
    expect(results.map(r => r.docId)).toContain('doc');
  });

  it('stores the numeric value in the result doc', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'doc', year: 2024, title: 'hello' });
    await writer.commit();

    const results = await searcher.search('hello');
    expect(results[0]!.doc['year']).toBe(2024);
  });
});

// ─── deleteById edge cases ────────────────────────────────────────────────────

describe('deleteById edge cases', () => {
  it('deleting a non-existent id is a no-op', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'real', title: 'hello world' });
    await writer.deleteById('nonexistent');
    await writer.commit();

    const results = await searcher.search('hello');
    expect(results.map(r => r.docId)).toContain('real');
  });

  it('deleting the same id twice does not corrupt the index', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'doc', title: 'hello world' });
    await writer.deleteById('doc');
    await writer.deleteById('doc');
    await writer.commit();

    const results = await searcher.search('hello');
    expect(results.map(r => r.docId)).not.toContain('doc');
  });
});

// ─── Cache invalidation ───────────────────────────────────────────────────────

describe('cache invalidation', () => {
  it('invalidateCache allows new segments to be found', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir);

    await writer.addDocument({ id: 'doc1', title: 'hello' });
    await writer.commit();

    // Prime the cache with one search
    const before = await searcher.search('hello');
    expect(before.map(r => r.docId)).toContain('doc1');

    // Add a second document in a new segment
    await writer.addDocument({ id: 'doc2', title: 'hello' });
    await writer.commit();

    // Without invalidation, the new segment might be visible anyway since we
    // re-read segments.json on every search — but caches for postings should be
    // irrelevant here. The main thing is invalidateCache does not throw and does
    // not break subsequent searches.
    searcher.invalidateCache();
    const after = await searcher.search('hello');
    expect(after.map(r => r.docId)).toContain('doc1');
    expect(after.map(r => r.docId)).toContain('doc2');
  });
});

// ─── topK boundary ────────────────────────────────────────────────────────────

describe('topK boundary', () => {
  it('topK larger than result count returns all results', async () => {
    const { writer, searcher } = makeIndex();
    for (let i = 0; i < 3; i++) {
      await writer.addDocument({ id: `d${i}`, title: 'common term' });
    }
    await writer.commit();

    const results = await searcher.search('common', { topK: 100 });
    expect(results).toHaveLength(3);
  });

  it('topK=1 returns only the best-scoring document', async () => {
    const { writer, searcher } = makeIndex();
    await writer.addDocument({ id: 'high', title: 'search' });
    await writer.addDocument({ id: 'low',  title: 'search result overview here' });
    await writer.commit();

    const results = await searcher.search('search', { topK: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]!.docId).toBe('high');
  });
});
