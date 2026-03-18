import type { QueryAST, PostingsList, SegmentMeta, IndexConfig, ScoreContext } from './types.js';

export interface Scorer {
  score(context: ScoreContext): number;
}

/**
 * BM25 scorer.
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
    const { query, docId, segmentMeta, postingsMap, config } = ctx;
    let total = 0;

    const scoreTerm = (field: string, term: string, boost: number): void => {
      const pl = postingsMap.get(`${field}:${term}`);
      if (!pl) return;

      const posting = binarySearch(pl.postings, docId);
      if (!posting) return;

      const tf = posting.tf;
      const N = segmentMeta.docCount;
      const avgLen = segmentMeta.fields[field]?.avgLength ?? 1;

      const idf = Math.max(0, Math.log((N - pl.df + 0.5) / (pl.df + 0.5) + 1));
      const tfNorm =
        (tf * (this.k + 1)) /
        (tf + this.k * (1 - this.b + this.b * (tf / avgLen)));

      total += idf * tfNorm * (config.boost?.[field] ?? 1.0) * boost;
    };

    visitQuery(query, postingsMap, scoreTerm);
    return total;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function visitQuery(
  node: QueryAST,
  postingsMap: Map<string, PostingsList>,
  fn: (field: string, term: string, boost: number) => void,
): void {
  switch (node.type) {
    case 'term': {
      const boost = node.boost ?? 1.0;
      if (node.field) {
        fn(node.field, node.term, boost);
      } else {
        // No field: score against every field in postingsMap that has this term
        for (const key of postingsMap.keys()) {
          const colonIdx = key.indexOf(':');
          if (key.slice(colonIdx + 1) === node.term) {
            fn(key.slice(0, colonIdx), node.term, boost);
          }
        }
      }
      break;
    }
    case 'phrase': {
      const boost = (node.boost ?? 1.0) / Math.max(node.terms.length, 1);
      if (node.field) {
        for (const t of node.terms) fn(node.field, t, boost);
      } else {
        for (const t of node.terms) {
          for (const key of postingsMap.keys()) {
            const colonIdx = key.indexOf(':');
            if (key.slice(colonIdx + 1) === t) {
              fn(key.slice(0, colonIdx), t, boost);
            }
          }
        }
      }
      break;
    }
    case 'wildcard': {
      const wRegex = wildcardToRegex(node.pattern);
      const boost = node.boost ?? 1.0;
      for (const key of postingsMap.keys()) {
        const colonIdx = key.indexOf(':');
        const kField = key.slice(0, colonIdx);
        const kTerm  = key.slice(colonIdx + 1);
        if (node.field && kField !== node.field) continue;
        if (wRegex.test(kTerm)) fn(kField, kTerm, boost);
      }
      break;
    }
    case 'range':
      break;
    case 'bool':
      for (const child of node.must ?? []) visitQuery(child, postingsMap, fn);
      for (const child of node.should ?? []) visitQuery(child, postingsMap, fn);
      break;
  }
}

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

// Re-export for use in searcher.ts
export { wildcardToRegex };
