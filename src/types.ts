// ─── Index configuration ──────────────────────────────────────────────────────

/**
 * Optional per-index configuration. All fields are indexed + stored with the
 * standard analyzer by default; use these lists and maps to override.
 */
export interface IndexConfig {
  /**
   * Override the analyzer for specific fields.
   * Any field not listed uses 'standard'.
   * Built-in values: 'standard' | 'keyword'. Custom analyzers can be
   * registered via createAnalyzer.
   *
   * @example { analyzers: { id: 'keyword', tags: 'keyword' } }
   */
  analyzers?: Record<string, string>;

  /**
   * Fields to index for search but NOT write to stored docs.json.
   * Use for large text (e.g. body) you want to search but not return.
   */
  noStore?: string[];

  /**
   * Fields to store in docs.json but NOT add to the inverted index.
   * Use for carry-through metadata (e.g. url, thumbnail) you want in
   * results but don't need to search.
   */
  noIndex?: string[];

  /**
   * Per-field BM25 score multipliers applied at query time.
   * @example { boost: { title: 2.0 } }
   */
  boost?: Record<string, number>;
}

// ─── Tokenization ────────────────────────────────────────────────────────────

export interface Token {
  term: string;
  position: number;
}

// ─── Postings ────────────────────────────────────────────────────────────────

export interface Posting {
  /** Segment-local numeric doc ID. */
  docId: number;
  /** Term frequency: how many times the term appears in this doc. */
  tf: number;
  /** Token positions within the field, for phrase queries. */
  pos: number[];
}

export interface PostingsList {
  /** Document frequency: number of docs containing this term. */
  df: number;
  /** Sorted ascending by docId. */
  postings: Posting[];
}

// ─── Segment metadata ────────────────────────────────────────────────────────

export interface FieldStats {
  /** Number of documents that have at least one token for this field. */
  docCount: number;
  /** Average token count across those documents. */
  avgLength: number;
}

export interface SegmentMeta {
  segmentId: string;
  docCount: number;
  createdAt: string; // ISO 8601
  /** Keyed by field name; only fields that were actually indexed appear here. */
  fields: Record<string, FieldStats>;
}

export interface SegmentInfo {
  segmentId: string;
  docCount: number;
  deletedCount: number;
}

// ─── Query AST ───────────────────────────────────────────────────────────────

export type QueryAST =
  | TermQuery
  | PhraseQuery
  | RangeQuery
  | BoolQuery
  | WildcardQuery;

export interface TermQuery {
  type: 'term';
  field?: string;
  term: string;
  boost?: number;
}

export interface PhraseQuery {
  type: 'phrase';
  field?: string;
  terms: string[];
  slop?: number;
  boost?: number;
}

export interface RangeQuery {
  type: 'range';
  field: string;
  min?: string;
  max?: string;
  inclusive?: boolean;
  boost?: number;
}

export interface BoolQuery {
  type: 'bool';
  must?: QueryAST[];
  should?: QueryAST[];
  mustNot?: QueryAST[];
  boost?: number;
}

export interface WildcardQuery {
  type: 'wildcard';
  field?: string;
  pattern: string;
  boost?: number;
}

// ─── Search results ──────────────────────────────────────────────────────────

export interface SearchResult {
  /** Stored fields from docs.json. */
  doc: Record<string, unknown>;
  score: number;
  /** The document's string ID (from the 'id' field). */
  docId: string;
  segmentId: string;
}

export interface SearchOptions {
  topK?: number;
  filter?: (doc: Record<string, unknown>) => boolean;
}

// ─── Scorer ──────────────────────────────────────────────────────────────────

export interface ScoreContext {
  query: QueryAST;
  docId: number;
  segmentMeta: SegmentMeta;
  postingsMap: Map<string, PostingsList>;
  config: IndexConfig;
  /** Token count per indexed field for this specific document. Used for BM25 |d|/avgdl. */
  fieldLengths: Record<string, number>;
}
