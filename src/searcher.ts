import { LRUCache } from 'lru-cache';
import type { IndexDirectory } from './directory.js';
import type {
  IndexConfig,
  SegmentMeta,
  PostingsList,
  Posting,
  QueryAST,
  PhraseQuery,
  SearchResult,
  SearchOptions,
} from './types.js';
import type { Scorer } from './scorer.js';
import { wildcardToRegex, binarySearchPosting } from './scorer.js';
import { createAnalyzer } from './analyzer.js';
import { LuceneQueryParser } from './query-parser.js';

export class IndexSearcher {
  private readonly parser = new LuceneQueryParser();
  private readonly termDictCache:    LRUCache<string, Record<string, string>>;
  private readonly postingsCache:    LRUCache<string, PostingsList>;
  private readonly fieldLenCache:    LRUCache<string, Record<string, Record<string, number>>>;

  constructor(
    private readonly directory: IndexDirectory,
    private readonly config: IndexConfig = {},
    private readonly scorer: Scorer,
    options?: {
      termDictCacheSize?: number;
      postingsCacheSize?: number;
    },
  ) {
    this.termDictCache  = new LRUCache({ max: options?.termDictCacheSize ?? 200 });
    this.postingsCache  = new LRUCache({ max: options?.postingsCacheSize ?? 10_000 });
    // One entry per segment; field-lengths.json is ~docCount × fields × 4 bytes
    this.fieldLenCache  = new LRUCache({ max: 50 });
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async search(queryStr: string, options?: SearchOptions): Promise<SearchResult[]> {
    const topK   = options?.topK ?? 10;
    const filter = options?.filter;

    const queryAST = this.parser.parse(queryStr);

    // Fail fast on unimplemented range queries
    if (containsRangeQuery(queryAST)) {
      throw new Error(
        'Range queries ([min TO max]) are not yet implemented. ' +
        'Use the filter option for numeric/date range filtering: ' +
        '{ filter: doc => Number(doc.year) >= 2020 }',
      );
    }

    const segments = await this.loadSegments();
    if (segments.length === 0) return [];

    const perSegment = await Promise.all(
      segments.map(meta => this.searchSegment(meta, queryAST)),
    );

    return selectTopK(perSegment.flat().filter(r => !filter || filter(r.doc)), topK);
  }

  invalidateCache(): void {
    this.termDictCache.clear();
    this.postingsCache.clear();
    this.fieldLenCache.clear();
  }

  // ─── Segment search ───────────────────────────────────────────────────────

  private async searchSegment(
    segMeta: SegmentMeta,
    queryAST: QueryAST,
  ): Promise<SearchResult[]> {
    const segId = segMeta.segmentId;
    const indexedFields = Object.keys(segMeta.fields);

    const [docs, deletedIds, allFieldLengths] = await Promise.all([
      this.directory.readJson<Record<string, Record<string, unknown>>>(`${segId}/docs.json`),
      this.loadDeletedSet(segId),
      this.loadFieldLengths(segId),
    ]);

    // Build postingsMap for all concrete query terms
    const postingsMap = new Map<string, PostingsList>();
    for (const { field, term } of extractTerms(queryAST, indexedFields, this.config)) {
      const key = `${field}:${term}`;
      if (!postingsMap.has(key)) {
        const pl = await this.loadPostings(segId, key);
        if (pl) postingsMap.set(key, pl);
      }
    }

    // Expand wildcards against full term-dict
    await this.expandWildcards(queryAST, segId, postingsMap);

    // mustNot exclusion set
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

      // Structural match check (phrase position, must clauses)
      if (!this.queryMatches(queryAST, docId, postingsMap)) continue;

      const fieldLengths = allFieldLengths[String(docId)] ?? {};
      const score = this.scorer.score({
        query: queryAST,
        docId,
        segmentMeta: segMeta,
        postingsMap,
        config: this.config,
        fieldLengths,
      });

      if (score > 0) {
        results.push({ doc: stored, score, docId: docStringId, segmentId: segId });
      }
    }

    return results;
  }

  // ─── Query structural matching ────────────────────────────────────────────

  /**
   * Check that a document satisfies structural constraints:
   * - Phrase queries: terms must appear at consecutive positions (within slop)
   * - Bool queries: all must-clauses satisfied
   * Term/wildcard/range: no structural constraint beyond existence (score > 0 gates them)
   */
  private queryMatches(query: QueryAST, docId: number, pm: Map<string, PostingsList>): boolean {
    switch (query.type) {
      case 'phrase': return checkPhraseMatch(query, docId, pm);
      case 'bool':   return this.boolMustSatisfied(query, docId, pm);
      default:       return true;
    }
  }

  private boolMustSatisfied(
    query: QueryAST,
    docId: number,
    pm: Map<string, PostingsList>,
  ): boolean {
    if (query.type !== 'bool' || !query.must?.length) return true;
    return query.must.every(c => this.clauseMatches(c, docId, pm));
  }

  private clauseMatches(
    node: QueryAST,
    docId: number,
    pm: Map<string, PostingsList>,
  ): boolean {
    switch (node.type) {
      case 'term': {
        if (node.field) {
          return binarySearchPosting(
            pm.get(`${node.field}:${node.term}`)?.postings ?? [], docId,
          ) !== undefined;
        }
        for (const [key, pl] of pm) {
          if (key.endsWith(`:${node.term}`) && binarySearchPosting(pl.postings, docId)) return true;
        }
        return false;
      }
      case 'phrase':
        return checkPhraseMatch(node, docId, pm);
      case 'wildcard': {
        const regex = wildcardToRegex(node.pattern);
        for (const [key, pl] of pm) {
          const colonIdx = key.indexOf(':');
          if (node.field && key.slice(0, colonIdx) !== node.field) continue;
          if (regex.test(key.slice(colonIdx + 1)) && binarySearchPosting(pl.postings, docId)) return true;
        }
        return false;
      }
      case 'bool':
        return this.boolMustSatisfied(node, docId, pm);
      default:
        return true;
    }
  }

  // ─── mustNot ─────────────────────────────────────────────────────────────

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
        if (field && fieldTerm.slice(0, colonIdx) !== field) continue;
        if (!regex.test(fieldTerm.slice(colonIdx + 1))) continue;
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

  private async loadFieldLengths(
    segId: string,
  ): Promise<Record<string, Record<string, number>>> {
    const key = segId;
    const cached = this.fieldLenCache.get(key);
    if (cached) return cached;
    try {
      const data = await this.directory.readJson<Record<string, Record<string, number>>>(
        `${segId}/field-lengths.json`,
      );
      this.fieldLenCache.set(key, data);
      return data;
    } catch {
      return {};
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

// ─── Phrase position checking ─────────────────────────────────────────────────

function checkPhraseMatch(
  node: PhraseQuery,
  docId: number,
  pm: Map<string, PostingsList>,
): boolean {
  if (node.terms.length === 0) return true;
  const slop = node.slop ?? 0;

  if (node.field) {
    return checkPhrasePositions(node.terms, node.field, docId, pm, slop);
  }

  // Unfielded: try each distinct field present in postingsMap
  const fields = new Set<string>();
  for (const key of pm.keys()) fields.add(key.slice(0, key.indexOf(':')));
  for (const field of fields) {
    if (checkPhrasePositions(node.terms, field, docId, pm, slop)) return true;
  }
  return false;
}

function checkPhrasePositions(
  terms: string[],
  field: string,
  docId: number,
  pm: Map<string, PostingsList>,
  slop: number,
): boolean {
  // Collect position arrays for each term; bail if any term is missing
  const posArrays: number[][] = [];
  for (const t of terms) {
    const pl = pm.get(`${field}:${t}`);
    if (!pl) return false;
    const posting = binarySearchPosting(pl.postings, docId);
    if (!posting) return false;
    posArrays.push(posting.pos);
  }

  // For each candidate start position of term[0], verify subsequent terms
  // appear at expected offsets (position[i] ≈ startPos + i, within slop)
  outer: for (const startPos of posArrays[0]!) {
    for (let i = 1; i < terms.length; i++) {
      const expected = startPos + i;
      if (!posArrays[i]!.some(p => Math.abs(p - expected) <= slop)) continue outer;
    }
    return true;
  }
  return false;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

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
          const tokens = createAnalyzer(config.analyzers?.[field] ?? 'standard').analyze(field, n.term);
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

function containsRangeQuery(node: QueryAST): boolean {
  if (node.type === 'range') return true;
  if (node.type === 'bool') {
    const all = [...(node.must ?? []), ...(node.should ?? []), ...(node.mustNot ?? [])];
    return all.some(containsRangeQuery);
  }
  return false;
}

// ─── Top-K selection (min-heap, O(n log k)) ───────────────────────────────────

function selectTopK(items: SearchResult[], k: number): SearchResult[] {
  if (items.length <= k) {
    return items.sort((a, b) => b.score - a.score);
  }

  // Build a min-heap of size k: the smallest score is always at index 0
  const heap = items.slice(0, k);
  for (let i = Math.floor(k / 2) - 1; i >= 0; i--) heapSiftDown(heap, i);

  for (let i = k; i < items.length; i++) {
    if (items[i]!.score > heap[0]!.score) {
      heap[0] = items[i]!;
      heapSiftDown(heap, 0);
    }
  }

  return heap.sort((a, b) => b.score - a.score);
}

function heapSiftDown(heap: SearchResult[], i: number): void {
  const n = heap.length;
  while (true) {
    let smallest = i;
    const l = 2 * i + 1, r = 2 * i + 2;
    if (l < n && heap[l]!.score < heap[smallest]!.score) smallest = l;
    if (r < n && heap[r]!.score < heap[smallest]!.score) smallest = r;
    if (smallest === i) break;
    [heap[i], heap[smallest]] = [heap[smallest]!, heap[i]!];
    i = smallest;
  }
}
