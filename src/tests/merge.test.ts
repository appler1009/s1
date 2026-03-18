import { describe, it, expect } from 'bun:test';
import { MemoryIndexDirectory } from '../directory.js';
import { createIndex } from '../index.js';
import { SegmentMerger } from '../merge.js';
import type { MergePolicy } from '../merge.js';

function makeFullMergePolicy(segmentCount: number): MergePolicy {
  return { maxSegments: 99, mergeCount: segmentCount };
}

describe('SegmentMerger', () => {
  it('mergeAll consolidates many segments into one', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir, {}, { commitThreshold: 2 });

    for (let i = 0; i < 8; i++) {
      await writer.addDocument({ id: `d${i}`, title: `document number ${i}` });
    }
    await writer.close();

    const before = await dir.readJson<{ segments: string[] }>('segments.json');
    expect(before.segments.length).toBeGreaterThanOrEqual(4);

    const merger = new SegmentMerger(dir, {
      maxSegments: 99,
      mergeCount: before.segments.length,
    });
    await merger.mergeAll();

    const after = await dir.readJson<{ segments: string[] }>('segments.json');
    expect(after.segments.length).toBe(1);

    const results = await searcher.search('document', { topK: 10 });
    expect(results.length).toBe(8);
  });

  it('maybeMerge triggers when over maxSegments', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer } = createIndex(dir, {}, { commitThreshold: 1 });

    for (let i = 0; i < 6; i++) {
      await writer.addDocument({ id: `d${i}`, title: `hello world ${i}` });
    }
    await writer.close();

    const merger = new SegmentMerger(dir, { maxSegments: 4, mergeCount: 3 });
    const result = await merger.maybeMerge();
    expect(result).not.toBeNull();

    const after = await dir.readJson<{ segments: string[] }>('segments.json');
    // 6 segments → merge 3 smallest → 3 remaining + 1 new = 4
    expect(after.segments.length).toBe(4);
  });

  it('maybeMerge does nothing when under threshold', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer } = createIndex(dir, {}, { commitThreshold: 10 });

    for (let i = 0; i < 3; i++) {
      await writer.addDocument({ id: `d${i}`, title: `hello ${i}` });
    }
    await writer.commit();

    const merger = new SegmentMerger(dir, { maxSegments: 10, mergeCount: 4 });
    expect(await merger.maybeMerge()).toBeNull();
  });

  // ── Structural merge correctness ─────────────────────────────────────────

  it('noStore fields remain searchable after merge', async () => {
    // The old re-indexing merger lost noStore fields because they were never
    // in docs.json. Structural merge copies postings directly — no re-indexing.
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir, { noStore: ['body'] }, { commitThreshold: 1 });

    await writer.addDocument({ id: 'd0', title: 'alpha', body: 'structural merge test' });
    await writer.addDocument({ id: 'd1', title: 'beta',  body: 'structural merge test' });
    await writer.close();

    const before = await dir.readJson<{ segments: string[] }>('segments.json');
    await new SegmentMerger(dir, makeFullMergePolicy(before.segments.length)).mergeAll();

    // body is noStore so it must not appear in results
    const results = await searcher.search('structural');
    expect(results).toHaveLength(2);
    expect(results[0]!.doc['body']).toBeUndefined();
  });

  it('phrase queries still work after merge', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir, {}, { commitThreshold: 1 });

    await writer.addDocument({ id: 'match',    title: 'quick brown fox' });
    await writer.addDocument({ id: 'no-match', title: 'quick fox brown' }); // wrong order
    await writer.close();

    const before = await dir.readJson<{ segments: string[] }>('segments.json');
    await new SegmentMerger(dir, makeFullMergePolicy(before.segments.length)).mergeAll();

    const results = await searcher.search('"quick brown fox"');
    const ids = results.map(r => r.docId);
    expect(ids).toContain('match');
    expect(ids).not.toContain('no-match');
  });

  it('tombstoned documents are excluded from merged segment', async () => {
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir, {}, { commitThreshold: 1 });

    await writer.addDocument({ id: 'keep', title: 'hello world' });
    await writer.addDocument({ id: 'gone', title: 'hello world' });
    await writer.deleteById('gone');
    await writer.close(); // commits keep in one seg, gone+tombstone in another

    const before = await dir.readJson<{ segments: string[] }>('segments.json');
    await new SegmentMerger(dir, makeFullMergePolicy(before.segments.length)).mergeAll();

    const after = await dir.readJson<{ segments: string[] }>('segments.json');
    expect(after.segments.length).toBe(1);

    const results = await searcher.search('hello');
    const ids = results.map(r => r.docId);
    expect(ids).toContain('keep');
    expect(ids).not.toContain('gone');
  });

  it('BM25 scores are correct after merge (field-lengths preserved)', async () => {
    // The merged segment must compute avgdl from the transferred field-lengths,
    // not re-derive them from text. We verify ranking is still correct.
    const dir = new MemoryIndexDirectory();
    const { writer, searcher } = createIndex(dir, { boost: { title: 2.0 } }, { commitThreshold: 1 });

    // 'high' has 'search' in a short title — higher TF/IDF density
    await writer.addDocument({ id: 'high', title: 'search'                              });
    await writer.addDocument({ id: 'low',  title: 'search engines are great tools here' });
    await writer.close();

    const before = await dir.readJson<{ segments: string[] }>('segments.json');
    await new SegmentMerger(dir, makeFullMergePolicy(before.segments.length)).mergeAll();

    const results = await searcher.search('search');
    expect(results[0]!.docId).toBe('high');
  });
});
