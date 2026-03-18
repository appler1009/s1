import type { IndexDirectory } from './directory.js';
import type { IndexConfig, Posting, PostingsList, SegmentMeta, SegmentInfo, FieldStats } from './types.js';
import { createAnalyzer } from './analyzer.js';

export class IndexWriter {
  private nextDocId = 0;
  private segmentCounter = 0;

  private stagingDocs     = new Map<number, Record<string, unknown>>();
  private stagingPostings = new Map<string, Posting[]>();              // "field:term" → postings
  private stagingFieldLengths = new Map<number, Map<string, number>>(); // docId → field → tokenCount
  private pendingDeletes  = new Set<string>();

  // Derived from config for fast lookup
  private readonly noStore:  Set<string>;
  private readonly noIndex:  Set<string>;

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

        const analyzerName = this.config.analyzers?.[fieldName] ?? 'standard';
        const tokens = createAnalyzer(analyzerName).analyze(fieldName, raw);

        if (tokens.length > 0) {
          if (!this.stagingFieldLengths.has(docId)) {
            this.stagingFieldLengths.set(docId, new Map());
          }
          this.stagingFieldLengths.get(docId)!.set(fieldName, tokens.length);

          for (const token of tokens) {
            const key = `${fieldName}:${token.term}`;
            let list = this.stagingPostings.get(key);
            if (!list) { list = []; this.stagingPostings.set(key, list); }

            const existing = list.find(p => p.docId === docId);
            if (existing) {
              existing.tf++;
              existing.pos.push(token.position);
            } else {
              list.push({ docId, tf: 1, pos: [token.position] });
            }
          }
        }
      }
    }

    // 'id' is always stored so tombstoning works
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

    // 2. Field stats (only indexed fields appear here)
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

    // 3. Per-term postings + term-dict
    const termDict: Record<string, string> = {};
    for (const [fieldTerm, postings] of this.stagingPostings) {
      postings.sort((a, b) => a.docId - b.docId);
      const filename = `postings/${sanitize(fieldTerm)}.json`;
      await this.directory.writeJson(`${segmentId}/${filename}`, { df: postings.length, postings } satisfies PostingsList);
      termDict[fieldTerm] = filename;
    }
    await this.directory.writeJson(`${segmentId}/term-dict.json`, termDict);

    // 4. Segment metadata
    const meta: SegmentMeta = {
      segmentId,
      docCount: this.stagingDocs.size,
      createdAt: new Date().toISOString(),
      fields: fieldStats,
    };
    await this.directory.writeJson(`${segmentId}/segment-meta.json`, meta);

    // 5. Tombstones
    const deletedCount = this.pendingDeletes.size;
    if (deletedCount > 0) {
      await this.directory.writeJson(`${segmentId}/deleted.json`, [...this.pendingDeletes]);
    }

    // 6. Manifest
    const segments = await readSegmentsList(this.directory);
    segments.push(segmentId);
    await this.directory.writeJson('segments.json', { segments }, { atomic: true });

    // 7. Clear buffers
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

function sanitize(fieldTerm: string): string {
  return fieldTerm.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}
