/**
 * Standard IR evaluation metrics for BeIR-style benchmarks.
 *
 * All metrics follow the conventions used in the original BeIR paper:
 *   Thakur et al., "BEIR: A Heterogenous Benchmark for Zero-shot Evaluation of
 *   Information Retrieval Models", NeurIPS 2021.
 *
 * Relevance grading:
 *   - Score ≥ 1 is treated as relevant.
 *   - Score = 0 means "judged non-relevant" and does NOT count as relevant.
 *   - NDCG uses graded gain (2^rel − 1) to handle both binary and graded qrels.
 *
 * All per-query values are macro-averaged over queries that have at least one
 * qrel entry. Queries absent from the qrel file are excluded from evaluation
 * (they are "unjudged", not "0-recall").
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** queryId → (corpusId → relevance score) */
export type Qrels = Map<string, Map<string, number>>;

/** queryId → retrieved corpus IDs in rank order (best first) */
export type Run = Map<string, string[]>;

export interface MetricScores {
  'NDCG@10':    number;
  'NDCG@100':   number;
  'MAP@100':    number;
  'Recall@10':  number;
  'Recall@100': number;
  'MRR@10':     number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Discounted Cumulative Gain — gains are already in relevance-grade order. */
function dcg(gains: number[], k: number): number {
  let score = 0;
  for (let i = 0; i < Math.min(gains.length, k); i++) {
    score += gains[i]! / Math.log2(i + 2); // log2(rank + 1), rank is 1-indexed
  }
  return score;
}

// ─── Per-query metric functions ───────────────────────────────────────────────

/**
 * NDCG@K for a single query using graded relevance (gain = 2^rel − 1).
 */
export function ndcgAtK(
  retrieved: string[],
  relevant:  Map<string, number>,
  k:         number,
): number {
  const top  = retrieved.slice(0, k);
  const gains = top.map(id => {
    const rel = relevant.get(id) ?? 0;
    return Math.pow(2, rel) - 1;
  });

  const idealGains = Array.from(relevant.values())
    .filter(r => r > 0)
    .map(r => Math.pow(2, r) - 1)
    .sort((a, b) => b - a);

  const idcgVal = dcg(idealGains, k);
  if (idcgVal === 0) return 0;
  return dcg(gains, k) / idcgVal;
}

/**
 * Average Precision@K (used for MAP).
 *
 * AP = Σ_{k: retrieved[k] is relevant} (precision@k) / |total relevant docs|
 *
 * Note: denominator is total relevant docs, not min(|relevant|, K).
 */
export function apAtK(
  retrieved: string[],
  relevant:  Map<string, number>,
  k:         number,
): number {
  const numRelevant = [...relevant.values()].filter(r => r > 0).length;
  if (numRelevant === 0) return 0;

  const top = retrieved.slice(0, k);
  let hits = 0;
  let sumPrecision = 0;

  for (let i = 0; i < top.length; i++) {
    if ((relevant.get(top[i]!) ?? 0) > 0) {
      hits++;
      sumPrecision += hits / (i + 1);
    }
  }
  return sumPrecision / numRelevant;
}

/**
 * Recall@K for a single query.
 */
export function recallAtK(
  retrieved: string[],
  relevant:  Map<string, number>,
  k:         number,
): number {
  const numRelevant = [...relevant.values()].filter(r => r > 0).length;
  if (numRelevant === 0) return 0;

  const top  = retrieved.slice(0, k);
  const hits = top.filter(id => (relevant.get(id) ?? 0) > 0).length;
  return hits / numRelevant;
}

/**
 * Reciprocal Rank@K for a single query.
 */
export function rrAtK(
  retrieved: string[],
  relevant:  Map<string, number>,
  k:         number,
): number {
  const top = retrieved.slice(0, k);
  for (let i = 0; i < top.length; i++) {
    if ((relevant.get(top[i]!) ?? 0) > 0) return 1 / (i + 1);
  }
  return 0;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

export interface EvalResult {
  scores:              MetricScores;
  numQueries:          number;  // total queries in the run
  numQueriesWithQrels: number;  // queries that had at least one qrel entry
  numQueriesSkipped:   number;  // queries with no qrels (excluded from averaging)
}

/**
 * Evaluate a full retrieval run against qrels.
 *
 * Queries absent from qrels are excluded from averaging (they are "unjudged").
 */
export function evaluateRun(run: Run, qrels: Qrels): EvalResult {
  type Accumulator = { ndcg10: number; ndcg100: number; ap100: number; rec10: number; rec100: number; rr10: number };
  const acc: Accumulator = { ndcg10: 0, ndcg100: 0, ap100: 0, rec10: 0, rec100: 0, rr10: 0 };

  let numWithQrels = 0;

  for (const [qid, retrieved] of run) {
    const relevant = qrels.get(qid);
    if (!relevant) continue;
    numWithQrels++;

    acc.ndcg10  += ndcgAtK(retrieved, relevant, 10);
    acc.ndcg100 += ndcgAtK(retrieved, relevant, 100);
    acc.ap100   += apAtK(retrieved, relevant, 100);
    acc.rec10   += recallAtK(retrieved, relevant, 10);
    acc.rec100  += recallAtK(retrieved, relevant, 100);
    acc.rr10    += rrAtK(retrieved, relevant, 10);
  }

  const n = numWithQrels || 1;
  return {
    scores: {
      'NDCG@10':    acc.ndcg10  / n,
      'NDCG@100':   acc.ndcg100 / n,
      'MAP@100':    acc.ap100   / n,
      'Recall@10':  acc.rec10   / n,
      'Recall@100': acc.rec100  / n,
      'MRR@10':     acc.rr10    / n,
    },
    numQueries:          run.size,
    numQueriesWithQrels: numWithQrels,
    numQueriesSkipped:   run.size - numWithQrels,
  };
}
