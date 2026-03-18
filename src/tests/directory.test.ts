import { describe, it, expect } from 'bun:test';
import { MemoryIndexDirectory } from '../directory.js';

describe('MemoryIndexDirectory', () => {
  // ── writeJson / readJson ────────────────────────────────────────────────────

  it('stores and retrieves a JSON value', async () => {
    const dir = new MemoryIndexDirectory();
    await dir.writeJson('test.json', { hello: 'world' });
    const result = await dir.readJson<{ hello: string }>('test.json');
    expect(result.hello).toBe('world');
  });

  it('throws when reading a non-existent file', async () => {
    const dir = new MemoryIndexDirectory();
    await expect(dir.readJson('missing.json')).rejects.toThrow('file not found');
  });

  it('overwrites an existing file on re-write', async () => {
    const dir = new MemoryIndexDirectory();
    await dir.writeJson('file.json', { v: 1 });
    await dir.writeJson('file.json', { v: 2 });
    const r = await dir.readJson<{ v: number }>('file.json');
    expect(r.v).toBe(2);
  });

  it('writeJson deep-clones — mutating the written object does not affect the store', async () => {
    const dir = new MemoryIndexDirectory();
    const obj = { a: [1, 2, 3] };
    await dir.writeJson('file.json', obj);
    obj.a.push(4); // mutate after write
    const r = await dir.readJson<{ a: number[] }>('file.json');
    expect(r.a).toHaveLength(3);
  });

  it('readJson deep-clones — mutating the result does not affect the store', async () => {
    const dir = new MemoryIndexDirectory();
    await dir.writeJson('file.json', { a: [1, 2, 3] });
    const r1 = await dir.readJson<{ a: number[] }>('file.json');
    r1.a.push(99);
    const r2 = await dir.readJson<{ a: number[] }>('file.json');
    expect(r2.a).toHaveLength(3);
  });

  // ── exists ──────────────────────────────────────────────────────────────────

  it('exists returns true for a written file', async () => {
    const dir = new MemoryIndexDirectory();
    await dir.writeJson('f.json', {});
    expect(await dir.exists('f.json')).toBe(true);
  });

  it('exists returns false for a non-existent file', async () => {
    const dir = new MemoryIndexDirectory();
    expect(await dir.exists('nope.json')).toBe(false);
  });

  // ── delete ──────────────────────────────────────────────────────────────────

  it('deletes a file', async () => {
    const dir = new MemoryIndexDirectory();
    await dir.writeJson('f.json', {});
    await dir.delete('f.json');
    expect(await dir.exists('f.json')).toBe(false);
  });

  it('delete on a non-existent file is a no-op', async () => {
    const dir = new MemoryIndexDirectory();
    await expect(dir.delete('nope.json')).resolves.toBeUndefined();
  });

  // ── list ────────────────────────────────────────────────────────────────────

  it('list returns all files matching the prefix', async () => {
    const dir = new MemoryIndexDirectory();
    await dir.writeJson('seg-000001/docs.json', {});
    await dir.writeJson('seg-000001/term-dict.json', {});
    await dir.writeJson('seg-000002/docs.json', {});
    await dir.writeJson('segments.json', {});

    const seg1 = await dir.list('seg-000001/');
    expect(seg1).toHaveLength(2);
    expect(seg1).toContain('seg-000001/docs.json');
    expect(seg1).toContain('seg-000001/term-dict.json');
  });

  it('list returns empty array when no files match the prefix', async () => {
    const dir = new MemoryIndexDirectory();
    await dir.writeJson('seg-000001/docs.json', {});
    expect(await dir.list('seg-000002/')).toHaveLength(0);
  });

  it('list with empty prefix returns all files', async () => {
    const dir = new MemoryIndexDirectory();
    await dir.writeJson('a.json', {});
    await dir.writeJson('b.json', {});
    const all = await dir.list('');
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  // ── dump ────────────────────────────────────────────────────────────────────

  it('dump returns a copy of the internal store', async () => {
    const dir = new MemoryIndexDirectory();
    await dir.writeJson('a.json', { x: 1 });
    const dumped = dir.dump();
    expect(dumped.has('a.json')).toBe(true);
  });

  it('dump returns an independent copy (modifying it does not affect the directory)', async () => {
    const dir = new MemoryIndexDirectory();
    await dir.writeJson('a.json', { x: 1 });
    const dumped = dir.dump();
    dumped.delete('a.json');
    expect(await dir.exists('a.json')).toBe(true);
  });

  // ── writeJson options param is accepted (no-op for memory) ──────────────────

  it('writeJson with atomic option does not throw', async () => {
    const dir = new MemoryIndexDirectory();
    await expect(dir.writeJson('f.json', {}, { atomic: true })).resolves.toBeUndefined();
  });
});
