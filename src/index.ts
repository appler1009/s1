export type {
  IndexConfig,
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

import type { IndexConfig } from './types.js';
import type { IndexDirectory } from './directory.js';
import { BM25Scorer } from './scorer.js';
import { IndexWriter } from './writer.js';
import { IndexSearcher } from './searcher.js';

export interface IndexOptions {
  commitThreshold?: number;
  postingsCacheSize?: number;
  termDictCacheSize?: number;
}

/**
 * Create a writer/searcher pair sharing the same directory and config.
 *
 * @example
 * ```ts
 * const dir = new MemoryIndexDirectory();
 * const { writer, searcher } = createIndex(dir);
 *
 * await writer.addDocument({ id: '1', title: 'Hello world', body: 'long text...' });
 * await writer.commit();
 *
 * const results = await searcher.search('hello');
 * ```
 *
 * @example With config overrides
 * ```ts
 * const { writer, searcher } = createIndex(dir, {
 *   analyzers: { id: 'keyword', tags: 'keyword' },
 *   noStore:   ['body'],
 *   noIndex:   ['url', 'thumbnail'],
 *   boost:     { title: 2.0 },
 * });
 * ```
 */
export function createIndex(
  directory: IndexDirectory,
  config: IndexConfig = {},
  options?: IndexOptions,
): { writer: IndexWriter; searcher: IndexSearcher } {
  const scorer = new BM25Scorer();
  return {
    writer:   new IndexWriter(directory, config, options?.commitThreshold),
    searcher: new IndexSearcher(directory, config, scorer, {
      postingsCacheSize: options?.postingsCacheSize,
      termDictCacheSize: options?.termDictCacheSize,
    }),
  };
}
