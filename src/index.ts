export type {
  Schema,
  FieldConfig,
  FieldType,
  Token,
  Posting,
  PostingsList,
  FieldStats,
  SegmentMeta,
  SegmentInfo,
  QueryAST,
  TermQuery,
  PhraseQuery,
  RangeQuery,
  BoolQuery,
  WildcardQuery,
  SearchResult,
  SearchOptions,
  ScoreContext,
} from './types.js';

export type { IndexDirectory } from './directory.js';
export { MemoryIndexDirectory, FsIndexDirectory } from './directory.js';
export { S3IndexDirectory } from './directory-s3.js';

export type { Analyzer } from './analyzer.js';
export { StandardAnalyzer, KeywordAnalyzer, createAnalyzer } from './analyzer.js';

export type { Scorer } from './scorer.js';
export { BM25Scorer } from './scorer.js';

export { LuceneQueryParser } from './query-parser.js';

export { IndexWriter } from './writer.js';
export { IndexSearcher } from './searcher.js';
export { SegmentMerger } from './merge.js';
export type { MergePolicy } from './merge.js';

// ─── Convenience factory ──────────────────────────────────────────────────────

import type { Schema } from './types.js';
import type { IndexDirectory } from './directory.js';
import { StandardAnalyzer } from './analyzer.js';
import { BM25Scorer } from './scorer.js';
import { IndexWriter } from './writer.js';
import { IndexSearcher } from './searcher.js';

export interface IndexOptions {
  /** Automatically flush a new segment every N documents (default 5000). */
  commitThreshold?: number;
  /** LRU cache size for postings lists (default 10_000 entries). */
  postingsCacheSize?: number;
}

/**
 * Create a writer/searcher pair that share the same directory + schema.
 *
 * @example
 * ```ts
 * const dir = new MemoryIndexDirectory();
 * const schema: Schema = { fields: { title: { type: 'text', store: true, indexed: true } } };
 * const { writer, searcher } = createIndex(dir, schema);
 *
 * await writer.addDocument({ title: 'Hello world' });
 * await writer.commit();
 *
 * const results = await searcher.search('hello');
 * ```
 */
export function createIndex(
  directory: IndexDirectory,
  schema: Schema,
  options?: IndexOptions,
): { writer: IndexWriter; searcher: IndexSearcher } {
  const analyzer = new StandardAnalyzer();
  const scorer = new BM25Scorer();

  const writer = new IndexWriter(directory, schema, analyzer, options?.commitThreshold);
  const searcher = new IndexSearcher(directory, schema, analyzer, scorer, {
    postingsCacheSize: options?.postingsCacheSize,
  });

  return { writer, searcher };
}
