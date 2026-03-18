import type { IndexDirectory } from './directory.js';
import type { IndexConfig, SegmentMeta } from './types.js';
import { IndexWriter } from './writer.js';

export interface MergePolicy {
  maxSegments: number;
  mergeCount: number;
}

export const DEFAULT_MERGE_POLICY: MergePolicy = {
  maxSegments: 10,
  mergeCount: 4,
};

export class SegmentMerger {
  constructor(
    private readonly directory: IndexDirectory,
    private readonly config: IndexConfig = {},
    private readonly policy: MergePolicy = DEFAULT_MERGE_POLICY,
  ) {}

  async maybeMerge(): Promise<string | null> {
    const manifest = await this.readManifest();
    if (manifest.segments.length <= this.policy.maxSegments) return null;
    return this.merge(manifest.segments);
  }

  async mergeAll(): Promise<string | null> {
    const manifest = await this.readManifest();
    if (manifest.segments.length <= 1) return null;
    return this.merge(manifest.segments);
  }

  private async merge(allSegmentIds: string[]): Promise<string | null> {
    const metas = await Promise.all(
      allSegmentIds.map(id =>
        this.directory.readJson<SegmentMeta>(`${id}/segment-meta.json`),
      ),
    );

    const sorted = metas
      .map((m, i) => ({ meta: m, id: allSegmentIds[i]! }))
      .sort((a, b) => a.meta.docCount - b.meta.docCount);

    const toMerge = sorted.slice(0, this.policy.mergeCount);
    const toKeep  = sorted.slice(this.policy.mergeCount).map(s => s.id);

    const allDocs: Array<Record<string, unknown>> = [];
    const deletedIds = new Set<string>();

    for (const { id } of toMerge) {
      try {
        const dels = await this.directory.readJson<string[]>(`${id}/deleted.json`);
        for (const d of dels) deletedIds.add(d);
      } catch { /* no deleted.json is fine */ }

      const docs = await this.directory.readJson<Record<string, Record<string, unknown>>>(
        `${id}/docs.json`,
      );
      for (const doc of Object.values(docs)) {
        if (!deletedIds.has(String(doc['id'] ?? ''))) allDocs.push(doc);
      }
    }

    if (allDocs.length === 0) {
      await this.updateManifest(toKeep);
      return null;
    }

    const writer = new IndexWriter(this.directory, this.config, allDocs.length + 1);
    for (const doc of allDocs) await writer.addDocument(doc);
    const { segmentId } = await writer.commit();

    await this.updateManifest([...toKeep, segmentId]);
    return segmentId;
  }

  private async readManifest(): Promise<{ segments: string[] }> {
    try {
      return await this.directory.readJson<{ segments: string[] }>('segments.json');
    } catch {
      return { segments: [] };
    }
  }

  private async updateManifest(segments: string[]): Promise<void> {
    await this.directory.writeJson('segments.json', { segments }, { atomic: true });
  }
}
