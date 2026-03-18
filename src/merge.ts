import type { IndexDirectory } from './directory.js';
import type { Posting, PostingsList, SegmentMeta, FieldStats } from './types.js';
import { bucketFor, bucketFilename, numBucketsFor } from './postings-bucket.js';

export interface MergePolicy {
  maxSegments: number;
  mergeCount: number;
}

export const DEFAULT_MERGE_POLICY: MergePolicy = {
  maxSegments: 10,
  mergeCount: 4,
};

/**
 * Merges segments by combining their postings structures directly — no
 * re-tokenisation, no re-analysis, no dependency on the original document text.
 *
 * The process for each merged field:term pair:
 *   1. Load the postings list from every source segment that contains it.
 *   2. Remap each posting's docId to a new global docId space.
 *   3. Skip tombstoned documents.
 *   4. Concatenate the remapped lists (they are non-overlapping by construction,
 *      so the result is sorted without an explicit sort pass).
 *   5. Write the merged postings file to the new segment directory.
 *
 * docs.json and field-lengths.json are copied and re-keyed under the new docIds.
 * No IndexConfig is required — the analyzer is never invoked.
 */
export class SegmentMerger {
  constructor(
    private readonly directory: IndexDirectory,
    private readonly policy: MergePolicy = DEFAULT_MERGE_POLICY,
  ) {}

  async maybeMerge(): Promise<string | null> {
    const manifest = await this.readManifest();
    if (manifest.segments.length <= this.policy.maxSegments) return null;
    return this.mergeSegments(manifest.segments);
  }

  async mergeAll(): Promise<string | null> {
    const manifest = await this.readManifest();
    if (manifest.segments.length <= 1) return null;
    return this.mergeSegments(manifest.segments);
  }

  // ─── Core merge ────────────────────────────────────────────────────────────

  private async mergeSegments(allSegmentIds: string[]): Promise<string | null> {
    const metas = await Promise.all(
      allSegmentIds.map(id =>
        this.directory.readJson<SegmentMeta>(`${id}/segment-meta.json`),
      ),
    );

    // Select the smallest N segments to merge; leave the rest untouched.
    const sorted = metas
      .map((m, i) => ({ meta: m, id: allSegmentIds[i]! }))
      .sort((a, b) => a.meta.docCount - b.meta.docCount);

    const toMerge = sorted.slice(0, this.policy.mergeCount);
    const toKeep  = sorted.slice(this.policy.mergeCount).map(s => s.id);

    // ── 1. Load source data ───────────────────────────────────────────────────

    type SegData = {
      id:           string;
      docs:         Record<string, Record<string, unknown>>;   // numericId → stored fields
      deletedIds:   Set<string>;                               // string doc IDs
      termDict:     Record<string, string>;                    // field:term → filename
      fieldLengths: Record<string, Record<string, number>>;    // numericId → field → tokenCount
    };

    const segments: SegData[] = await Promise.all(
      toMerge.map(async ({ id }) => {
        const [docs, termDict, fieldLengths] = await Promise.all([
          this.directory.readJson<Record<string, Record<string, unknown>>>(`${id}/docs.json`),
          this.directory.readJson<Record<string, string>>(`${id}/term-dict.json`),
          this.loadFieldLengths(id),
        ]);

        let deletedStringIds: string[] = [];
        try {
          deletedStringIds = await this.directory.readJson<string[]>(`${id}/deleted.json`);
        } catch { /* segment has no tombstones — fine */ }

        return { id, docs, deletedIds: new Set(deletedStringIds), termDict, fieldLengths };
      }),
    );

    // ── 2. Assign new docIds, skipping tombstoned documents ──────────────────
    //
    // Collect tombstones from ALL source segments first so that a deletion
    // committed to a later segment correctly excludes a doc from an earlier one.
    const globalDeletedIds = new Set<string>();
    for (const seg of segments) {
      for (const id of seg.deletedIds) globalDeletedIds.add(id);
    }

    // New docIds are allocated sequentially across segments in merge order:
    //   segment[0] → 0 … k-1
    //   segment[1] → k … k+m-1
    //   …
    // This means each segment's remapped postings are already sorted relative to
    // the next segment's — concatenation yields a globally sorted list with no
    // explicit sort required.

    const docMappings: Map<number, number>[] = [];
    let nextDocId = 0;

    for (const seg of segments) {
      const mapping = new Map<number, number>();
      for (const [numIdStr, doc] of Object.entries(seg.docs)) {
        const stringId = String(doc['id'] ?? numIdStr);
        if (!globalDeletedIds.has(stringId)) {
          mapping.set(parseInt(numIdStr, 10), nextDocId++);
        }
      }
      docMappings.push(mapping);
    }

    const totalDocCount = nextDocId;
    if (totalDocCount === 0) {
      await this.updateManifest(toKeep);
      return null;
    }

    // Derive next segment ID from the existing segment IDs (same logic as IndexWriter).
    const maxN = allSegmentIds.reduce((max, id) => {
      const m = /seg-(\d+)$/.exec(id);
      return m ? Math.max(max, parseInt(m[1]!, 10)) : max;
    }, 0);
    const newSegId = `seg-${String(maxN + 1).padStart(6, '0')}`;

    // ── 3. Write docs.json ───────────────────────────────────────────────────

    const mergedDocs: Record<string, Record<string, unknown>> = {};
    for (let si = 0; si < segments.length; si++) {
      const mapping = docMappings[si]!;
      for (const [numIdStr, doc] of Object.entries(segments[si]!.docs)) {
        const newId = mapping.get(parseInt(numIdStr, 10));
        if (newId !== undefined) mergedDocs[String(newId)] = doc;
      }
    }
    await this.directory.writeJson(`${newSegId}/docs.json`, mergedDocs);

    // ── 4. Write field-lengths.json ──────────────────────────────────────────

    const mergedFieldLengths: Record<string, Record<string, number>> = {};
    for (let si = 0; si < segments.length; si++) {
      const mapping = docMappings[si]!;
      for (const [numIdStr, fields] of Object.entries(segments[si]!.fieldLengths)) {
        const newId = mapping.get(parseInt(numIdStr, 10));
        if (newId !== undefined) mergedFieldLengths[String(newId)] = fields;
      }
    }
    await this.directory.writeJson(`${newSegId}/field-lengths.json`, mergedFieldLengths);

    // ── 5. Merge postings ────────────────────────────────────────────────────
    //
    // Process source segments bucket-by-bucket so each source bucket file is
    // read exactly once.  The merged postings are accumulated per field:term,
    // then written out into new bucket files for the output segment.

    // fieldTerm → merged postings (accumulated across all source segments)
    const mergedByTerm = new Map<string, Posting[]>();

    for (let si = 0; si < segments.length; si++) {
      const seg     = segments[si]!;
      const mapping = docMappings[si]!;

      // Group terms by their source bucket filename to load each file once.
      const termsByFile = new Map<string, string[]>();
      for (const [ft, filename] of Object.entries(seg.termDict)) {
        if (!termsByFile.has(filename)) termsByFile.set(filename, []);
        termsByFile.get(filename)!.push(ft);
      }

      for (const [filename, terms] of termsByFile) {
        let bucketData: Record<string, PostingsList>;
        try {
          bucketData = await this.directory.readJson<Record<string, PostingsList>>(
            `${seg.id}/${filename}`,
          );
        } catch { continue; /* missing bucket file — skip */ }

        for (const fieldTerm of terms) {
          const pl = bucketData[fieldTerm];
          if (!pl) continue;
          if (!mergedByTerm.has(fieldTerm)) mergedByTerm.set(fieldTerm, []);
          const out = mergedByTerm.get(fieldTerm)!;
          for (const p of pl.postings) {
            const newId = mapping.get(p.docId);
            if (newId !== undefined) out.push({ docId: newId, tf: p.tf, pos: p.pos });
          }
        }
      }
    }

    // Write output bucket files and term-dict.
    const numBuckets = numBucketsFor(totalDocCount);
    const newBuckets = new Map<number, Record<string, PostingsList>>();
    const newTermDict: Record<string, string> = {};

    for (const [fieldTerm, postings] of mergedByTerm) {
      if (postings.length === 0) continue;
      const bucket = bucketFor(fieldTerm, numBuckets);
      if (!newBuckets.has(bucket)) newBuckets.set(bucket, {});
      newBuckets.get(bucket)![fieldTerm] = { df: postings.length, postings } satisfies PostingsList;
      newTermDict[fieldTerm] = bucketFilename(bucket);
    }

    for (const [bucket, data] of newBuckets) {
      await this.directory.writeJson(`${newSegId}/${bucketFilename(bucket)}`, data);
    }
    await this.directory.writeJson(`${newSegId}/term-dict.json`, newTermDict);

    // ── 6. Write segment-meta.json (derived from merged field-lengths) ───────

    const fieldTotalLen = new Map<string, number>();
    const fieldDocCnt   = new Map<string, number>();
    for (const fields of Object.values(mergedFieldLengths)) {
      for (const [field, len] of Object.entries(fields)) {
        fieldTotalLen.set(field, (fieldTotalLen.get(field) ?? 0) + len);
        fieldDocCnt.set(field,   (fieldDocCnt.get(field)   ?? 0) + 1);
      }
    }
    const fieldStats: Record<string, FieldStats> = {};
    for (const [field, total] of fieldTotalLen) {
      const count = fieldDocCnt.get(field) ?? 1;
      fieldStats[field] = { docCount: count, avgLength: total / count };
    }

    await this.directory.writeJson(`${newSegId}/segment-meta.json`, {
      segmentId: newSegId,
      docCount:  totalDocCount,
      createdAt: new Date().toISOString(),
      fields:    fieldStats,
    } satisfies SegmentMeta);

    // ── 7. Update manifest ───────────────────────────────────────────────────

    await this.updateManifest([...toKeep, newSegId]);
    return newSegId;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async loadFieldLengths(segId: string): Promise<Record<string, Record<string, number>>> {
    try {
      return await this.directory.readJson<Record<string, Record<string, number>>>(
        `${segId}/field-lengths.json`,
      );
    } catch {
      return {};
    }
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
