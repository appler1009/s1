import type { IndexDirectory } from './directory.js';
import type { IndexConfig, Posting, PostingsList, SegmentMeta, SegmentInfo, FieldStats } from './types.js';
import { createAnalyzer } from './analyzer.js';

export class IndexWriter {
  private nextDocId = 0;
  private segmentCounter = 0;

  private stagingDocs        = new Map<number, Record<string, unknown>>();
  // fieldTerm → docId → Posting: O(1) lookup during indexing
  private stagingPostings    = new Map<string, Map<number, Posting>>();
  private stagingFieldLengths = new Map<number, Map<string, number>>(); // docId → field → tokenCount
  private pendingDeletes     = new Set<string>();

  private readonly noStore: Set<string>;
  private readonly noIndex: Set<string>;

  constructor(
    private readonly directory: IndexDirectory,
    private readonly config: IndexConfig = {},
    private readonly commitThreshold = 5_000,
  ) {
    this.noStore = new Set(config.noStore ?? []);
    this.noIndex = new Set(config.noIndex ?? []);
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async addDocument(inputDoc: Record<string, unknown>): Promise<void> {
    const docId = this.nextDocId++;
    const storedFields: Record<string, unknown> = {};

    for (const [fieldName, value] of Object.entries(inputDoc)) {
      if (value === undefined || value === null) continue;

      if (!this.noStore.has(fieldName)) {
        storedFields[fieldName] = value;
      }

      if (!this.noIndex.has(fieldName)) {
        const raw =
          typeof value === 'string'  ? value :
          typeof value === 'number'  ? String(value) :
          value instanceof Date      ? value.toISOString() :
          JSON.stringify(value);

        const tokens = createAnalyzer(this.config.analyzers?.[fieldName] ?? 'standard')
          .analyze(fieldName, raw);

        if (tokens.length > 0) {
          if (!this.stagingFieldLengths.has(docId)) {
            this.stagingFieldLengths.set(docId, new Map());
          }
          this.stagingFieldLengths.get(docId)!.set(fieldName, tokens.length);

          for (const token of tokens) {
            const key = `${fieldName}:${token.term}`;
            let docMap = this.stagingPostings.get(key);
            if (!docMap) { docMap = new Map(); this.stagingPostings.set(key, docMap); }

            const existing = docMap.get(docId);
            if (existing) {
              existing.tf++;
              existing.pos.push(token.position);
            } else {
              docMap.set(docId, { docId, tf: 1, pos: [token.position] });
            }
          }
        }
      }
    }

    storedFields['id'] = inputDoc['id'] ?? `doc-${docId}`;
    this.stagingDocs.set(docId, storedFields);

    if (this.stagingDocs.size >= this.commitThreshold) {
      await this.commit();
    }
  }

  async deleteById(id: string): Promise<void> {
    this.pendingDeletes.add(id);
  }

  async commit(): Promise<SegmentInfo> {
    if (this.stagingDocs.size === 0 && this.pendingDeletes.size === 0) {
      return { segmentId: '', docCount: 0, deletedCount: 0 };
    }

    const segmentId = `seg-${String(++this.segmentCounter).padStart(6, '0')}`;

    // 1. Stored docs
    await this.directory.writeJson(`${segmentId}/docs.json`, Object.fromEntries(this.stagingDocs));

    // 2. Per-doc field lengths (for accurate BM25 |d| normalisation)
    const fieldLengthsOut: Record<string, Record<string, number>> = {};
    for (const [docId, fieldMap] of this.stagingFieldLengths) {
      fieldLengthsOut[String(docId)] = Object.fromEntries(fieldMap);
    }
    await this.directory.writeJson(`${segmentId}/field-lengths.json`, fieldLengthsOut);

    // 3. Field stats (avgLength per field, used for BM25 avgdl)
    const fieldTotalLen = new Map<string, number>();
    const fieldDocCount = new Map<string, number>();
    for (const [, fieldMap] of this.stagingFieldLengths) {
      for (const [field, len] of fieldMap) {
        fieldTotalLen.set(field, (fieldTotalLen.get(field) ?? 0) + len);
        fieldDocCount.set(field, (fieldDocCount.get(field) ?? 0) + 1);
      }
    }
    const fieldStats: Record<string, FieldStats> = {};
    for (const [field, total] of fieldTotalLen) {
      const count = fieldDocCount.get(field) ?? 1;
      fieldStats[field] = { docCount: count, avgLength: total / count };
    }

    // 4. Per-term postings (flatten Map<docId,Posting> → sorted array) + term-dict
    const termDict: Record<string, string> = {};
    for (const [fieldTerm, docMap] of this.stagingPostings) {
      const postings = Array.from(docMap.values()).sort((a, b) => a.docId - b.docId);
      const filename = `postings/${sanitize(fieldTerm)}.json`;
      await this.directory.writeJson(`${segmentId}/${filename}`,
        { df: postings.length, postings } satisfies PostingsList);
      termDict[fieldTerm] = filename;
    }
    await this.directory.writeJson(`${segmentId}/term-dict.json`, termDict);

    // 5. Segment metadata
    const meta: SegmentMeta = {
      segmentId,
      docCount: this.stagingDocs.size,
      createdAt: new Date().toISOString(),
      fields: fieldStats,
    };
    await this.directory.writeJson(`${segmentId}/segment-meta.json`, meta);

    // 6. Tombstones
    const deletedCount = this.pendingDeletes.size;
    if (deletedCount > 0) {
      await this.directory.writeJson(`${segmentId}/deleted.json`, [...this.pendingDeletes]);
    }

    // 7. Manifest
    const segments = await readSegmentsList(this.directory);
    segments.push(segmentId);
    await this.directory.writeJson('segments.json', { segments }, { atomic: true });

    // 8. Clear buffers
    this.stagingDocs.clear();
    this.stagingPostings.clear();
    this.stagingFieldLengths.clear();
    this.pendingDeletes.clear();

    return { segmentId, docCount: meta.docCount, deletedCount };
  }

  async close(): Promise<void> {
    if (this.stagingDocs.size > 0 || this.pendingDeletes.size > 0) {
      await this.commit();
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function readSegmentsList(dir: IndexDirectory): Promise<string[]> {
  try {
    const data = await dir.readJson<{ segments: string[] }>('segments.json');
    return Array.isArray(data.segments) ? data.segments : [];
  } catch {
    return [];
  }
}

/**
 * Convert "field:term" to a safe filename.
 * Encodes field and term separately, joined by "__", so "title:hello-world"
 * and "title:hello_world" produce different filenames and cannot collide.
 */
function sanitize(fieldTerm: string): string {
  const sep = fieldTerm.indexOf(':');
  const field = fieldTerm.slice(0, sep).replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const term  = fieldTerm.slice(sep + 1).replace(/[^a-z0-9]/gi, '_').toLowerCase();
  return `${field}__${term}`;
}
