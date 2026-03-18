import { LRUCache } from 'lru-cache';
import type { IndexDirectory } from './directory.js';
import type {
  IndexConfig,
  SegmentMeta,
  PostingsList,
  QueryAST,
  SearchResult,
  SearchOptions,
} from './types.js';
import type { Scorer } from './scorer.js';
import { wildcardToRegex } from './scorer.js';
import { createAnalyzer } from './analyzer.js';
import { LuceneQueryParser } from './query-parser.js';

export class IndexSearcher {
  private readonly parser = new LuceneQueryParser();
  private readonly termDictCache: LRUCache<string, Record<string, string>>;
  private readonly postingsCache:  LRUCache<string, PostingsList>;

  constructor(
    private readonly directory: IndexDirectory,
    private readonly config: IndexConfig = {},
    private readonly scorer: Scorer,
    options?: {
      termDictCacheSize?: number;
      postingsCacheSize?: number;
    },
  ) {
    this.termDictCache = new LRUCache({ max: options?.termDictCacheSize ?? 200 });
    this.postingsCache  = new LRUCache({ max: options?.postingsCacheSize ?? 10_000 });
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async search(queryStr: string, options?: SearchOptions): Promise<SearchResult[]> {
    const topK   = options?.topK ?? 10;
    const filter = options?.filter;

    const segments = await this.loadSegments();
    if (segments.length === 0) return [];

    const queryAST = this.parser.parse(queryStr);

    const perSegment = await Promise.all(
      segments.map(meta => this.searchSegment(meta, queryAST)),
    );

    return kWayMerge(perSegment, topK, filter);
  }

  invalidateCache(): void {
    this.termDictCache.clear();
    this.postingsCache.clear();
  }

  // ─── Segment search ───────────────────────────────────────────────────────

  private async searchSegment(
    segMeta: SegmentMeta,
    queryAST: QueryAST,
  ): Promise<SearchResult[]> {
    const segId = segMeta.segmentId;

    const [docs, deletedIds] = await Promise.all([
      this.directory.readJson<Record<string, Record<string, unknown>>>(`${segId}/docs.json`),
      this.loadDeletedSet(segId),
    ]);

    // Indexed fields for this segment — used to expand unfielded query terms
    const indexedFields = Object.keys(segMeta.fields);

    // Build postingsMap: load entries for all concrete query terms
    const postingsMap = new Map<string, PostingsList>();
    const terms = extractTerms(queryAST, indexedFields, this.config);
    for (const { field, term } of terms) {
      const key = `${field}:${term}`;
      if (!postingsMap.has(key)) {
        const pl = await this.loadPostings(segId, key);
        if (pl) postingsMap.set(key, pl);
      }
    }

    // Expand wildcards against the term-dict
    await this.expandWildcards(queryAST, segId, postingsMap);

    // mustNot doc IDs to exclude
    const mustNotIds = await this.collectMustNotDocIds(queryAST, segId, indexedFields);

    // Candidate docIds from all matched postings
    const candidates = new Set<number>();
    for (const pl of postingsMap.values()) {
      for (const p of pl.postings) candidates.add(p.docId);
    }

    const results: SearchResult[] = [];

    for (const docId of candidates) {
      if (mustNotIds.has(docId)) continue;

      const stored = docs[String(docId)];
      if (!stored) continue;

      const docStringId = String(stored['id'] ?? docId);
      if (deletedIds.has(docStringId)) continue;

      if (!this.mustClausesSatisfied(queryAST, docId, postingsMap)) continue;

      const score = this.scorer.score({
        query: queryAST,
        docId,
        segmentMeta: segMeta,
        postingsMap,
        config: this.config,
      });

      if (score > 0) {
        results.push({ doc: stored, score, docId: docStringId, segmentId: segId });
      }
    }

    return results;
  }

  // ─── Must / mustNot ───────────────────────────────────────────────────────

  private mustClausesSatisfied(
    query: QueryAST,
    docId: number,
    postingsMap: Map<string, PostingsList>,
  ): boolean {
    if (query.type !== 'bool' || !query.must?.length) return true;
    return query.must.every(c => this.clauseMatches(c, docId, postingsMap));
  }

  private clauseMatches(
    node: QueryAST,
    docId: number,
    pm: Map<string, PostingsList>,
  ): boolean {
    switch (node.type) {
      case 'term': {
        if (node.field) {
          return pm.get(`${node.field}:${node.term}`)?.postings.some(p => p.docId === docId) ?? false;
        }
        for (const [key, pl] of pm) {
          if (key.endsWith(`:${node.term}`) && pl.postings.some(p => p.docId === docId)) return true;
        }
        return false;
      }
      case 'phrase': {
        return node.terms.every(t => {
          if (node.field) {
            return pm.get(`${node.field}:${t}`)?.postings.some(p => p.docId === docId) ?? false;
          }
          for (const [key, pl] of pm) {
            if (key.endsWith(`:${t}`) && pl.postings.some(p => p.docId === docId)) return true;
          }
          return false;
        });
      }
      case 'bool':
        return this.mustClausesSatisfied(node, docId, pm);
      default:
        return true;
    }
  }

  private async collectMustNotDocIds(
    query: QueryAST,
    segId: string,
    indexedFields: string[],
  ): Promise<Set<number>> {
    const excluded = new Set<number>();
    if (query.type !== 'bool' || !query.mustNot?.length) return excluded;

    for (const clause of query.mustNot) {
      for (const { field, term } of extractTerms(clause, indexedFields, this.config)) {
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
      for (const fieldTerm of Object.keys(termDict)) {
        const colonIdx = fieldTerm.indexOf(':');
        const dictField = fieldTerm.slice(0, colonIdx);
        const dictTerm  = fieldTerm.slice(colonIdx + 1);

        if (field && dictField !== field) continue;
        if (!regex.test(dictTerm)) continue;
        if (!postingsMap.has(fieldTerm)) {
          const pl = await this.loadPostings(segId, fieldTerm);
          if (pl) postingsMap.set(fieldTerm, pl);
        }
      }
    }
  }

  // ─── I/O helpers ─────────────────────────────────────────────────────────

  private async loadSegments(): Promise<SegmentMeta[]> {
    try {
      const { segments } = await this.directory.readJson<{ segments: string[] }>('segments.json');
      return Promise.all(
        segments.map(id => this.directory.readJson<SegmentMeta>(`${id}/segment-meta.json`)),
      );
    } catch {
      return [];
    }
  }

  private async loadTermDict(segId: string): Promise<Record<string, string>> {
    const key = `${segId}/term-dict`;
    const cached = this.termDictCache.get(key);
    if (cached) return cached;
    const dict = await this.directory.readJson<Record<string, string>>(`${segId}/term-dict.json`);
    this.termDictCache.set(key, dict);
    return dict;
  }

  private async loadPostings(segId: string, fieldTerm: string): Promise<PostingsList | null> {
    const key = `${segId}::${fieldTerm}`;
    const cached = this.postingsCache.get(key);
    if (cached) return cached;
    try {
      const termDict = await this.loadTermDict(segId);
      const filename = termDict[fieldTerm];
      if (!filename) return null;
      const pl = await this.directory.readJson<PostingsList>(`${segId}/${filename}`);
      this.postingsCache.set(key, pl);
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

/**
 * Extract concrete (field, term) pairs from a query AST.
 * Unfielded terms are expanded to all indexed fields in this segment.
 */
function extractTerms(
  node: QueryAST,
  indexedFields: string[],
  config: IndexConfig,
): Array<{ field: string; term: string }> {
  const out: Array<{ field: string; term: string }> = [];

  const walk = (n: QueryAST) => {
    switch (n.type) {
      case 'term': {
        const fields = n.field ? [n.field] : indexedFields;
        for (const field of fields) {
          const analyzerName = config.analyzers?.[field] ?? 'standard';
          const tokens = createAnalyzer(analyzerName).analyze(field, n.term);
          if (tokens.length > 0) {
            for (const t of tokens) out.push({ field, term: t.term });
          } else {
            out.push({ field, term: n.term.toLowerCase() });
          }
        }
        break;
      }
      case 'phrase': {
        const fields = n.field ? [n.field] : indexedFields;
        for (const field of fields)
          for (const t of n.terms) out.push({ field, term: t.toLowerCase() });
        break;
      }
      case 'bool':
        for (const c of [...(n.must ?? []), ...(n.should ?? [])]) walk(c);
        break;
      case 'wildcard':
      case 'range':
        break;
    }
  };

  walk(node);
  return out;
}

function collectWildcards(node: QueryAST): Array<{ field?: string; pattern: string }> {
  const out: Array<{ field?: string; pattern: string }> = [];
  const walk = (n: QueryAST) => {
    if (n.type === 'wildcard') {
      out.push({ field: n.field, pattern: n.pattern });
    } else if (n.type === 'bool') {
      for (const c of [...(n.must ?? []), ...(n.should ?? []), ...(n.mustNot ?? [])]) walk(c);
    }
  };
  walk(node);
  return out;
}

// ─── k-way merge ─────────────────────────────────────────────────────────────

function kWayMerge(
  perSegment: SearchResult[][],
  topK: number,
  filter?: (doc: Record<string, unknown>) => boolean,
): SearchResult[] {
  const flat: SearchResult[] = [];
  for (const seg of perSegment) {
    for (const r of seg) {
      if (!filter || filter(r.doc)) flat.push(r);
    }
  }
  flat.sort((a, b) => b.score - a.score);
  return flat.slice(0, topK);
}
