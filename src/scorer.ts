import type { QueryAST, PostingsList, SegmentMeta, Schema, ScoreContext } from './types.js';

export interface Scorer {
  score(context: ScoreContext): number;
}

/**
 * BM25+ scorer.
 *
 * score(q, d) = Σ IDF(t) × [ tf(t,d) × (k+1) ] / [ tf(t,d) + k × (1 - b + b × |d|/avgdl) ]
 *
 * k  = TF saturation (default 1.2)
 * b  = field-length normalisation (default 0.75)
 */
export class BM25Scorer implements Scorer {
  constructor(
    private readonly k: number = 1.2,
    private readonly b: number = 0.75,
  ) {}

  score(ctx: ScoreContext): number {
    const { query, docId, segmentMeta, postingsMap, schema } = ctx;
    let total = 0;

    const scoreTerm = (field: string, term: string, boost: number): void => {
      const key = `${field}:${term}`;
      const pl = postingsMap.get(key);
      if (!pl) return;

      const posting = binarySearch(pl.postings, docId);
      if (!posting) return;

      const tf = posting.tf;
      const df = pl.df;
      const N = segmentMeta.docCount;
      const stats = segmentMeta.fields[field];
      const avgLen = stats?.avgLength ?? 1;

      // IDF (Robertson-Sparck Jones, clamped to ≥ 0)
      const idf = Math.max(0, Math.log((N - df + 0.5) / (df + 0.5) + 1));

      // Field-length proxy: use tf as a loose proxy for field token count.
      // For a tighter approximation, IndexWriter would need to persist per-doc lengths.
      const tfNorm =
        (tf * (this.k + 1)) /
        (tf + this.k * (1 - this.b + this.b * (tf / avgLen)));

      const fieldBoost = schema.fields[field]?.boost ?? 1.0;
      total += idf * tfNorm * fieldBoost * boost;
    };

    visitQuery(query, schema, postingsMap, scoreTerm);
    return total;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Walk the query AST and call `fn` for each (field, term, boost) triple. */
function visitQuery(
  node: QueryAST,
  schema: Schema,
  postingsMap: Map<string, PostingsList>,
  fn: (field: string, term: string, boost: number) => void,
): void {
  switch (node.type) {
    case 'term': {
      const field = node.field ?? defaultField(schema);
      fn(field, node.term, node.boost ?? 1.0);
      break;
    }
    case 'phrase': {
      const field = node.field ?? defaultField(schema);
      const boost = (node.boost ?? 1.0) / Math.max(node.terms.length, 1);
      for (const t of node.terms) fn(field, t, boost);
      break;
    }
    case 'wildcard': {
      // Expand against postingsMap keys that match the pattern.
      const wRegex = wildcardToRegex(node.pattern);
      const wField = node.field ?? defaultField(schema);
      for (const [key] of postingsMap) {
        const colonIdx = key.indexOf(':');
        const kField = key.slice(0, colonIdx);
        const kTerm  = key.slice(colonIdx + 1);
        if (kField !== wField) continue;
        if (!wRegex.test(kTerm)) continue;
        fn(kField, kTerm, node.boost ?? 1.0);
      }
      break;
    }
    case 'range':
      // Range queries don't contribute BM25 score, just filter.
      break;
    case 'bool':
      for (const child of node.must ?? []) visitQuery(child, schema, postingsMap, fn);
      for (const child of node.should ?? []) visitQuery(child, schema, postingsMap, fn);
      // mustNot terms don't contribute positive score
      break;
  }
}

/** Binary search for a posting by docId in a sorted array. */
function binarySearch(
  postings: Array<{ docId: number; tf: number; pos: number[] }>,
  docId: number,
): { docId: number; tf: number; pos: number[] } | undefined {
  let lo = 0, hi = postings.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const p = postings[mid]!;
    if (p.docId === docId) return p;
    if (p.docId < docId) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function defaultField(schema: Schema): string {
  for (const [name, cfg] of Object.entries(schema.fields)) {
    if (cfg.type === 'text' && cfg.indexed) return name;
  }
  return 'body';
}
