import { describe, it, expect } from 'bun:test';
import { MemoryIndexDirectory } from '../directory.js';
import { createIndex } from '../index.js';
import { SegmentMerger } from '../merge.js';

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

    const merger = new SegmentMerger(dir, {}, {
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

    const merger = new SegmentMerger(dir, {}, { maxSegments: 4, mergeCount: 3 });
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

    const merger = new SegmentMerger(dir, {}, { maxSegments: 10, mergeCount: 4 });
    expect(await merger.maybeMerge()).toBeNull();
  });
});
