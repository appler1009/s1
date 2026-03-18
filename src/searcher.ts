import { LRUCache } from 'lru-cache';
import type { IndexDirectory } from './directory.js';
import type {
  Schema,
  SegmentMeta,
  PostingsList,
  QueryAST,
  SearchResult,
  SearchOptions,
} from './types.js';
import type { Analyzer } from './analyzer.js';
import type { Scorer } from './scorer.js';
import { LuceneQueryParser } from './query-parser.js';

export class IndexSearcher {
  private readonly parser = new LuceneQueryParser();

  // Per-segment term dictionaries (small, ~1 per segment)
  private readonly termDictCache: LRUCache<string, Record<string, string>>;
  // Per-term postings (~0.1–1 MB each for large indexes; cap by count)
  private readonly postingsCache: LRUCache<string, PostingsList>;

  constructor(
    private readonly directory: IndexDirectory,
    private readonly schema: Schema,
    private readonly analyzer: Analyzer,
    private readonly scorer: Scorer,
    options?: {
      /** Number of term-dict entries to hold in memory (default 200). */
      termDictCacheSize?: number;
      /** Number of postings lists to hold in memory (default 10_000). */
      postingsCacheSize?: number;
    },
  ) {
    this.termDictCache = new LRUCache({ max: options?.termDictCacheSize ?? 200 });
    this.postingsCache = new LRUCache({ max: options?.postingsCacheSize ?? 10_000 });
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async search(queryStr: string, options?: SearchOptions): Promise<SearchResult[]> {
    const topK = options?.topK ?? 10;
    const filter = options?.filter;

    const segments = await this.loadSegments();
    if (segments.length === 0) return [];

    const queryAST = this.parser.parse(queryStr);
    const queryTerms = extractTerms(queryAST, this.schema, this.analyzer);

    // Search each segment in parallel
    const perSegmentResults = await Promise.all(
      segments.map(meta => this.searchSegment(meta, queryAST, queryTerms)),
    );

    // k-way merge across segments
    const merged = kWayMerge(perSegmentResults, topK, filter);
    return merged;
  }

  /** Force-clear all caches (useful after new segments are written). */
  invalidateCache(): void {
    this.termDictCache.clear();
    this.postingsCache.clear();
  }

  // ─── Segment-level search ─────────────────────────────────────────────────

  private async searchSegment(
    segMeta: SegmentMeta,
    queryAST: QueryAST,
    queryTerms: Array<{ field: string; term: string }>,
  ): Promise<SearchResult[]> {
    const segId = segMeta.segmentId;

    // Load deleted set (may not exist; that's fine)
    const deletedIds = await this.loadDeletedSet(segId);

    // Load stored docs
    const docs = await this.directory.readJson<Record<string, Record<string, unknown>>>(
      `${segId}/docs.json`,
    );

    // Collect postings for all query terms
    const postingsMap = new Map<string, PostingsList>();
    for (const { field, term } of queryTerms) {
      const key = `${field}:${term}`;
      if (postingsMap.has(key)) continue; // dedup

      const pl = await this.loadPostings(segId, key);
      if (pl) postingsMap.set(key, pl);
    }

    // Also handle wildcards: expand against term-dict
    await this.expandWildcards(queryAST, segId, postingsMap);

    // Collect candidate docIds from all postings
    const candidates = new Set<number>();
    for (const pl of postingsMap.values()) {
      for (const p of pl.postings) candidates.add(p.docId);
    }

    // Filter mustNot candidates first
    const mustNotDocIds = await this.collectMustNotDocIds(queryAST, segId);

    const results: SearchResult[] = [];

    for (const docId of candidates) {
      if (mustNotDocIds.has(docId)) continue;

      const stored = docs[String(docId)];
      if (!stored) continue;

      const docStringId = String(stored['id'] ?? docId);
      if (deletedIds.has(docStringId)) continue;

      // Validate must clauses: all must terms must match
      if (!this.mustClausesSatisfied(queryAST, docId, postingsMap)) continue;

      const score = this.scorer.score({
        query: queryAST,
        docId,
        segmentMeta: segMeta,
        postingsMap,
        schema: this.schema,
      });

      if (score > 0) {
        results.push({ doc: stored, score, docId: docStringId, segmentId: segId });
      }
    }

    return results;
  }

  // ─── Must-clause filter ───────────────────────────────────────────────────

  private mustClausesSatisfied(
    query: QueryAST,
    docId: number,
    postingsMap: Map<string, PostingsList>,
  ): boolean {
    if (query.type !== 'bool' || !query.must?.length) return true;

    for (const clause of query.must) {
      if (!this.clauseMatches(clause, docId, postingsMap)) return false;
    }
    return true;
  }

  private clauseMatches(
    node: QueryAST,
    docId: number,
    postingsMap: Map<string, PostingsList>,
  ): boolean {
    switch (node.type) {
      case 'term': {
        if (node.field) {
          const pl = postingsMap.get(`${node.field}:${node.term}`);
          return pl?.postings.some(p => p.docId === docId) ?? false;
        }
        // No field: match any field with this term
        for (const [key, pl] of postingsMap) {
          if (key.endsWith(`:${node.term}`) && pl.postings.some(p => p.docId === docId)) return true;
        }
        return false;
      }
      case 'phrase': {
        const field = node.field;
        return node.terms.every(t => {
          if (field) {
            const pl = postingsMap.get(`${field}:${t}`);
            return pl?.postings.some(p => p.docId === docId) ?? false;
          }
          for (const [key, pl] of postingsMap) {
            if (key.endsWith(`:${t}`) && pl.postings.some(p => p.docId === docId)) return true;
          }
          return false;
        });
      }
      case 'bool':
        return this.mustClausesSatisfied(node, docId, postingsMap);
      default:
        return true;
    }
  }

  // ─── MustNot ──────────────────────────────────────────────────────────────

  private async collectMustNotDocIds(
    query: QueryAST,
    segId: string,
  ): Promise<Set<number>> {
    const excluded = new Set<number>();
    if (query.type !== 'bool' || !query.mustNot?.length) return excluded;

    for (const clause of query.mustNot) {
      const terms = extractTerms(clause, this.schema, this.analyzer);
      for (const { field, term } of terms) {
        const pl = await this.loadPostings(segId, `${field}:${term}`);
        if (pl) for (const p of pl.postings) excluded.add(p.docId);
      }
    }
    return excluded;
  }

  // ─── Wildcard expansion ───────────────────────────────────────────────────

  private async expandWildcards(
    query: QueryAST,
    segId: string,
    postingsMap: Map<string, PostingsList>,
  ): Promise<void> {
    const wildcards = collectWildcards(query);
    if (wildcards.length === 0) return;

    const termDict = await this.loadTermDict(segId);

    for (const { field, pattern } of wildcards) {
      const regex = wildcardToRegex(pattern);

      for (const [fieldTerm, _filename] of Object.entries(termDict)) {
        const [dictField, ...rest] = fieldTerm.split(':');
        const dictTerm = rest.join(':');

        if (field && dictField !== field) continue;
        if (!regex.test(dictTerm)) continue;

        const key = fieldTerm;
        if (!postingsMap.has(key)) {
          const pl = await this.loadPostings(segId, key);
          if (pl) postingsMap.set(key, pl);
        }
      }
    }
  }

  // ─── I/O helpers ─────────────────────────────────────────────────────────

  private async loadSegments(): Promise<SegmentMeta[]> {
    let manifest: { segments: string[] };
    try {
      manifest = await this.directory.readJson<{ segments: string[] }>('segments.json');
    } catch {
      return [];
    }

    return Promise.all(
      (manifest.segments ?? []).map(segId =>
        this.directory.readJson<SegmentMeta>(`${segId}/segment-meta.json`),
      ),
    );
  }

  private async loadTermDict(segId: string): Promise<Record<string, string>> {
    const cacheKey = `${segId}/term-dict`;
    const cached = this.termDictCache.get(cacheKey);
    if (cached) return cached;

    const dict = await this.directory.readJson<Record<string, string>>(
      `${segId}/term-dict.json`,
    );
    this.termDictCache.set(cacheKey, dict);
    return dict;
  }

  private async loadPostings(segId: string, fieldTerm: string): Promise<PostingsList | null> {
    const cacheKey = `${segId}::${fieldTerm}`;
    const cached = this.postingsCache.get(cacheKey);
    if (cached) return cached;

    try {
      const termDict = await this.loadTermDict(segId);
      const filename = termDict[fieldTerm];
      if (!filename) return null;

      const pl = await this.directory.readJson<PostingsList>(`${segId}/${filename}`);
      this.postingsCache.set(cacheKey, pl);
      return pl;
    } catch {
      return null;
    }
  }

  private async loadDeletedSet(segId: string): Promise<Set<string>> {
    try {
      const ids = await this.directory.readJson<string[]>(`${segId}/deleted.json`);
      return new Set(ids);
    } catch {
      return new Set();
    }
  }
}

// ─── Query helpers ────────────────────────────────────────────────────────────

/** Extract all (field, analyzed-term) pairs from a query AST. */
function extractTerms(
  node: QueryAST,
  schema: Schema,
  analyzer: Analyzer,
): Array<{ field: string; term: string }> {
  const results: Array<{ field: string; term: string }> = [];

  const walk = (n: QueryAST) => {
    switch (n.type) {
      case 'term': {
        const fields = n.field ? [n.field] : indexedTextFields(schema);
        for (const field of fields) {
          const tokens = analyzer.analyze(field, n.term);
          for (const t of tokens) results.push({ field, term: t.term });
          // Also add the raw term (for keyword-type fields or when analyzer returns nothing)
          if (tokens.length === 0) results.push({ field, term: n.term.toLowerCase() });
        }
        break;
      }
      case 'phrase': {
        const fields = n.field ? [n.field] : indexedTextFields(schema);
        for (const field of fields)
          for (const t of n.terms) results.push({ field, term: t.toLowerCase() });
        break;
      }
      case 'bool':
        for (const c of [...(n.must ?? []), ...(n.should ?? [])]) walk(c);
        // mustNot handled separately
        break;
      case 'wildcard':
      case 'range':
        break; // handled elsewhere
    }
  };

  walk(node);
  return results;
}

function indexedTextFields(schema: Schema): string[] {
  return Object.entries(schema.fields)
    .filter(([, c]) => c.indexed)
    .map(([name]) => name);
}

function collectWildcards(
  node: QueryAST,
): Array<{ field?: string; pattern: string }> {
  const out: Array<{ field?: string; pattern: string }> = [];
  const walk = (n: QueryAST) => {
    if (n.type === 'wildcard') out.push({ field: n.field, pattern: n.pattern });
    else if (n.type === 'bool') {
      for (const c of [...(n.must ?? []), ...(n.should ?? []), ...(n.mustNot ?? [])]) walk(c);
    }
  };
  walk(node);
  return out;
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

// ─── k-way merge ─────────────────────────────────────────────────────────────

function kWayMerge(
  perSegment: SearchResult[][],
  topK: number,
  filter?: (doc: Record<string, unknown>) => boolean,
): SearchResult[] {
  // Flatten, optionally filter, sort by score desc, take topK
  const flat: SearchResult[] = [];
  for (const seg of perSegment) {
    for (const r of seg) {
      if (!filter || filter(r.doc)) flat.push(r);
    }
  }
  flat.sort((a, b) => b.score - a.score);
  return flat.slice(0, topK);
}
