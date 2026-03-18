// ─── Field & Schema ──────────────────────────────────────────────────────────

export type FieldType = 'text' | 'keyword' | 'numeric' | 'date';

export interface FieldConfig {
  type: FieldType;
  /** Include this field in stored docs.json? */
  store: boolean;
  /** Analyzer name to use when indexing ('standard' | 'keyword'). Defaults to 'standard'. */
  analyzer?: 'standard' | 'keyword';
  /** Add to inverted index? */
  indexed: boolean;
  /** BM25 score multiplier applied to matches in this field. */
  boost?: number;
}

export interface Schema {
  fields: Record<string, FieldConfig>;
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
  schema: Schema;
}
