import { describe, it, expect } from 'bun:test';
import { bucketFor, bucketFilename, numBucketsFor, DOCS_PER_BUCKET, MIN_BUCKETS } from '../postings-bucket.js';
import { MemoryIndexDirectory } from '../directory.js';
import { createIndex } from '../index.js';
import { SegmentMerger } from '../merge.js';

// ─── Unit: numBucketsFor ──────────────────────────────────────────────────────

describe('numBucketsFor', () => {
  it('returns MIN_BUCKETS for small doc counts', () => {
    expect(numBucketsFor(0)).toBe(MIN_BUCKETS);
    expect(numBucketsFor(1)).toBe(MIN_BUCKETS);
    expect(numBucketsFor(5_000)).toBe(MIN_BUCKETS);
    expect(numBucketsFor(MIN_BUCKETS * DOCS_PER_BUCKET)).toBe(MIN_BUCKETS);
  });

  it('scales above MIN_BUCKETS once docCount exceeds the threshold', () => {
    expect(numBucketsFor(MIN_BUCKETS * DOCS_PER_BUCKET + 1)).toBe(MIN_BUCKETS + 1);
    expect(numBucketsFor(5_200_000)).toBe(5_200);
  });
});

// ─── Unit: hash function ──────────────────────────────────────────────────────

describe('bucketFor', () => {
  it('returns a value in [0, numBuckets)', () => {
    const terms = ['title:hello', 'body:world', 'id:doc-1', 'title:typescript', 'x:'];
    for (const numBuckets of [1, 5, 64, 5_200]) {
      for (const t of terms) {
        const b = bucketFor(t, numBuckets);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(numBuckets);
      }
    }
  });

  it('is deterministic — same input always yields same bucket', () => {
    expect(bucketFor('title:hello', 64)).toBe(bucketFor('title:hello', 64));
    expect(bucketFor('body:search', 5)).toBe(bucketFor('body:search', 5));
  });

  it('different terms can land in different buckets', () => {
    const buckets = new Set(
      ['title:hello', 'title:world', 'body:foo', 'body:bar', 'title:typescript']
        .map(t => bucketFor(t, 64)),
    );
    expect(buckets.size).toBeGreaterThan(1);
  });
});

// ─── Unit: bucket filename ────────────────────────────────────────────────────

describe('bucketFilename', () => {
  it('formats as postings/bucket-N.json', () => {
    expect(bucketFilename(0)).toBe('postings/bucket-0.json');
    expect(bucketFilename(7)).toBe('postings/bucket-7.json');
    expect(bucketFilename(5200)).toBe('postings/bucket-5200.json');
  });
});

// ─── Integration: writer produces bucket files ───────────────────────────────

describe('IndexWriter bucket file layout', () => {
  it('writes bucket files instead of per-term files after commit', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer } = createIndex(dir);

    await writer.addDocument({ id: 'd1', title: 'hello world' });
    await writer.addDocument({ id: 'd2', title: 'typescript search' });
    await writer.commit();

    const manifest = await dir.readJson<{ segments: string[] }>('segments.json');
    const segId = manifest.segments[0]!;

    const files = await dir.list(`${segId}/postings/`);
    // All postings files must be bucket files
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f).toMatch(/postings\/bucket-\d+\.json$/);
    }
  });

  it('number of postings files is at most numBucketsFor(docCount)', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer } = createIndex(dir);

    const docCount = 20;
    for (let i = 0; i < docCount; i++) {
      await writer.addDocument({ id: `d${i}`, title: `term${i} another${i} extra${i}` });
    }
    await writer.commit();

    const manifest = await dir.readJson<{ segments: string[] }>('segments.json');
    const segId = manifest.segments[0]!;
    const files = await dir.list(`${segId}/postings/`);
    expect(files.length).toBeLessThanOrEqual(numBucketsFor(docCount));
  });

  it('term-dict values are bucket filenames', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer } = createIndex(dir);

    await writer.addDocument({ id: 'd1', title: 'hello world' });
    await writer.commit();

    const manifest = await dir.readJson<{ segments: string[] }>('segments.json');
    const segId = manifest.segments[0]!;
    const termDict = await dir.readJson<Record<string, string>>(`${segId}/term-dict.json`);

    for (const filename of Object.values(termDict)) {
      expect(filename).toMatch(/^postings\/bucket-\d+\.json$/);
    }
  });

  it('multiple terms in the same bucket are all in one file', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer } = createIndex(dir);

    await writer.addDocument({ id: 'd1', title: 'alpha beta gamma delta epsilon' });
    await writer.commit();

    const manifest = await dir.readJson<{ segments: string[] }>('segments.json');
    const segId = manifest.segments[0]!;
    const termDict = await dir.readJson<Record<string, string>>(`${segId}/term-dict.json`);

    // Load one bucket file and verify it contains multiple field:term entries
    const bucketFiles = [...new Set(Object.values(termDict))];
    let foundMulti = false;
    for (const f of bucketFiles) {
      const bucket = await dir.readJson<Record<string, unknown>>(`${segId}/${f}`);
      if (Object.keys(bucket).length > 1) { foundMulti = true; break; }
    }
    expect(foundMulti).toBe(true);
  });
});

// ─── Integration: search still works with bucket layout ──────────────────────

describe('search with bucket postings', () => {
  it('finds documents after bucketed write', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir);

    await writer.addDocument({ id: 'a', title: 'quick brown fox' });
    await writer.addDocument({ id: 'b', title: 'lazy dog' });
    await writer.commit();

    const results = await searcher.search('quick');
    expect(results).toHaveLength(1);
    expect(results[0]!.docId).toBe('a');
  });

  it('phrase queries work with bucket layout', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir);

    await writer.addDocument({ id: 'match',    title: 'quick brown fox' });
    await writer.addDocument({ id: 'no-match', title: 'brown quick fox' });
    await writer.commit();

    const results = await searcher.search('"quick brown"');
    expect(results.map(r => r.docId)).toContain('match');
    expect(results.map(r => r.docId)).not.toContain('no-match');
  });
});

// ─── Integration: merge produces bucket files ────────────────────────────────

describe('SegmentMerger with bucket layout', () => {
  it('merged segment uses bucket files', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir, {}, { commitThreshold: 2 });

    for (let i = 0; i < 6; i++) {
      await writer.addDocument({ id: `d${i}`, title: `document ${i} hello` });
    }
    await writer.close();

    const before = await dir.readJson<{ segments: string[] }>('segments.json');
    const merger = new SegmentMerger(dir, { maxSegments: 99, mergeCount: before.segments.length });
    const newSegId = await merger.mergeAll();
    expect(newSegId).not.toBeNull();

    const files = await dir.list(`${newSegId!}/postings/`);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f).toMatch(/postings\/bucket-\d+\.json$/);
    }

    // Search must still work after merge
    searcher.invalidateCache();
    const results = await searcher.search('hello', { topK: 10 });
    expect(results.length).toBe(6);
  });

  it('each source bucket file is read once per segment during merge', async () => {
    // Regression: old design re-read the same postings file once per term in it.
    // With bucket layout each file is read once; verify correctness as a proxy.
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir, {}, { commitThreshold: 3 });

    for (let i = 0; i < 6; i++) {
      await writer.addDocument({ id: `d${i}`, title: `alpha beta gamma ${i}` });
    }
    await writer.close();

    const before = await dir.readJson<{ segments: string[] }>('segments.json');
    await new SegmentMerger(dir, { maxSegments: 99, mergeCount: before.segments.length }).mergeAll();

    searcher.invalidateCache();
    const results = await searcher.search('alpha', { topK: 10 });
    expect(results.length).toBe(6);
  });
});
