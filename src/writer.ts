import type { IndexDirectory } from './directory.js';
import type { Schema, Posting, PostingsList, SegmentMeta, SegmentInfo, FieldStats } from './types.js';
import type { Analyzer } from './analyzer.js';
import { createAnalyzer } from './analyzer.js';

export class IndexWriter {
  private nextDocId = 0;
  private segmentCounter = 0;

  // Staging buffers for the current (unflushed) segment
  private stagingDocs = new Map<number, Record<string, unknown>>();
  private stagingPostings = new Map<string, Posting[]>(); // "field:term" → postings
  private stagingFieldLengths = new Map<number, Map<string, number>>(); // docId → field → tokenCount
  private pendingDeletes = new Set<string>(); // string doc IDs to tombstone

  constructor(
    private readonly directory: IndexDirectory,
    private readonly schema: Schema,
    private readonly analyzer: Analyzer,
    /** Automatically flush a new segment when this many docs are buffered. */
    private readonly commitThreshold = 5_000,
  ) {}

  // ─── Public API ──────────────────────────────────────────────────────────

  async addDocument(inputDoc: Record<string, unknown>): Promise<void> {
    const docId = this.nextDocId++;
    const storedFields: Record<string, unknown> = {};

    for (const [fieldName, config] of Object.entries(this.schema.fields)) {
      const value = inputDoc[fieldName];
      if (value === undefined || value === null) continue;

      // Store the field if requested
      if (config.store) {
        storedFields[fieldName] = value;
      }

      // Index if requested
      if (config.indexed) {
        const rawValue =
          typeof value === 'string'
            ? value
            : typeof value === 'number' || value instanceof Date
              ? String(value)
              : JSON.stringify(value);

        const fieldAnalyzer = createAnalyzer(config.analyzer ?? 'standard');
        const tokens = fieldAnalyzer.analyze(fieldName, rawValue);

        // Track per-doc field length for BM25 normalisation
        if (!this.stagingFieldLengths.has(docId)) {
          this.stagingFieldLengths.set(docId, new Map());
        }
        this.stagingFieldLengths.get(docId)!.set(fieldName, tokens.length);

        for (const token of tokens) {
          const key = `${fieldName}:${token.term}`;
          let postings = this.stagingPostings.get(key);
          if (!postings) {
            postings = [];
            this.stagingPostings.set(key, postings);
          }

          const existing = postings.find(p => p.docId === docId);
          if (existing) {
            existing.tf++;
            existing.pos.push(token.position);
          } else {
            postings.push({ docId, tf: 1, pos: [token.position] });
          }
        }
      }
    }

    // Always preserve the document's own 'id'; fall back to numeric
    storedFields['id'] = inputDoc['id'] ?? `doc-${docId}`;
    this.stagingDocs.set(docId, storedFields);

    if (this.stagingDocs.size >= this.commitThreshold) {
      await this.commit();
    }
  }

  /** Mark a string document ID for deletion (tombstoned on next commit). */
  async deleteById(id: string): Promise<void> {
    this.pendingDeletes.add(id);
  }

  /** Flush all buffered documents into a new immutable segment. */
  async commit(): Promise<SegmentInfo> {
    if (this.stagingDocs.size === 0 && this.pendingDeletes.size === 0) {
      return { segmentId: '', docCount: 0, deletedCount: 0 };
    }

    const segmentId = `seg-${String(++this.segmentCounter).padStart(6, '0')}`;

    // 1. Write stored docs
    await this.directory.writeJson(`${segmentId}/docs.json`, Object.fromEntries(this.stagingDocs));

    // 2. Compute field stats
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

    // 3. Write per-term postings + build term-dict
    const termDict: Record<string, string> = {};

    for (const [fieldTerm, postings] of this.stagingPostings) {
      postings.sort((a, b) => a.docId - b.docId);
      const pl: PostingsList = { df: postings.length, postings };
      const filename = `postings/${sanitize(fieldTerm)}.json`;
      await this.directory.writeJson(`${segmentId}/${filename}`, pl);
      termDict[fieldTerm] = filename;
    }

    await this.directory.writeJson(`${segmentId}/term-dict.json`, termDict);

    // 4. Write segment metadata
    const meta: SegmentMeta = {
      segmentId,
      docCount: this.stagingDocs.size,
      createdAt: new Date().toISOString(),
      fields: fieldStats,
    };
    await this.directory.writeJson(`${segmentId}/segment-meta.json`, meta);

    // 5. Write tombstones
    const deletedCount = this.pendingDeletes.size;
    if (deletedCount > 0) {
      await this.directory.writeJson(`${segmentId}/deleted.json`, [...this.pendingDeletes]);
    }

    // 6. Append segment to manifest (atomic write)
    const segments = await readSegmentsList(this.directory);
    segments.push(segmentId);
    await this.directory.writeJson('segments.json', { segments }, { atomic: true });

    // 7. Clear staging buffers
    this.stagingDocs.clear();
    this.stagingPostings.clear();
    this.stagingFieldLengths.clear();
    this.pendingDeletes.clear();

    return { segmentId, docCount: meta.docCount, deletedCount };
  }

  /** Commit any remaining buffered documents and close. */
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

/** Convert "field:term" to a safe filename component. */
function sanitize(fieldTerm: string): string {
  return fieldTerm.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}
