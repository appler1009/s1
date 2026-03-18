/**
 * Segment merge: combine N small segments into one larger segment.
 *
 * This keeps the segment count manageable (≤ maxSegments) and improves
 * search performance by reducing the number of term-dict + postings loads.
 *
 * Algorithm:
 *   1. Read all current segments from segments.json.
 *   2. If count ≤ maxSegments, do nothing.
 *   3. Pick the smallest `mergeCount` segments by docCount.
 *   4. Re-index all their stored docs into a new segment via IndexWriter.
 *   5. Remove the old segment entries from segments.json.
 */

import type { IndexDirectory } from './directory.js';
import type { Schema, SegmentMeta } from './types.js';
import type { Analyzer } from './analyzer.js';
import { IndexWriter } from './writer.js';

export interface MergePolicy {
  /** Maximum number of segments before a merge is triggered. */
  maxSegments: number;
  /** How many of the smallest segments to merge at once. */
  mergeCount: number;
}

export const DEFAULT_MERGE_POLICY: MergePolicy = {
  maxSegments: 10,
  mergeCount: 4,
};

export class SegmentMerger {
  constructor(
    private readonly directory: IndexDirectory,
    private readonly schema: Schema,
    private readonly analyzer: Analyzer,
    private readonly policy: MergePolicy = DEFAULT_MERGE_POLICY,
  ) {}

  /**
   * Run a merge if the segment count exceeds policy.maxSegments.
   * Returns the new segment ID, or null if no merge was needed.
   */
  async maybeMerge(): Promise<string | null> {
    const manifest = await this.readManifest();
    if (manifest.segments.length <= this.policy.maxSegments) return null;

    return this.merge(manifest.segments);
  }

  /**
   * Unconditionally merge all segments into one.
   */
  async mergeAll(): Promise<string | null> {
    const manifest = await this.readManifest();
    if (manifest.segments.length <= 1) return null;
    return this.merge(manifest.segments);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async merge(allSegmentIds: string[]): Promise<string | null> {
    // Load metadata to find the smallest segments
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

    // Collect all docs from the segments being merged
    const allDocs: Array<Record<string, unknown>> = [];
    const deletedIds = new Set<string>();

    for (const { id } of toMerge) {
      // Load tombstones
      try {
        const dels = await this.directory.readJson<string[]>(`${id}/deleted.json`);
        for (const d of dels) deletedIds.add(d);
      } catch { /* no deleted.json is fine */ }

      // Load stored docs
      const docs = await this.directory.readJson<Record<string, Record<string, unknown>>>(
        `${id}/docs.json`,
      );
      for (const doc of Object.values(docs)) {
        const docId = String(doc['id'] ?? '');
        if (!deletedIds.has(docId)) allDocs.push(doc);
      }
    }

    if (allDocs.length === 0) {
      // All docs were deleted; just remove the merged segments
      await this.updateManifest(toKeep);
      return null;
    }

    // Write merged segment
    const writer = new IndexWriter(
      this.directory,
      this.schema,
      this.analyzer,
      allDocs.length + 1, // single commit at the end
    );

    for (const doc of allDocs) {
      await writer.addDocument(doc);
    }

    const { segmentId } = await writer.commit();

    // Update manifest: keep survivors + new merged segment (drop old ones)
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
