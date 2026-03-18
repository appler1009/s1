/**
 * Microbenchmark: index N documents, run M search queries, report latency.
 *
 * Usage:
 *   npm run bench
 *   DOCS=50000 QUERIES=500 npm run bench
 */

import { MemoryIndexDirectory } from '../directory.js';
import { createIndex } from '../index.js';
import type { Schema } from '../types.js';

const N_DOCS    = parseInt(process.env['DOCS']    ?? '10000',  10);
const N_QUERIES = parseInt(process.env['QUERIES'] ?? '100',    10);
const TOP_K     = parseInt(process.env['TOPK']    ?? '10',     10);

const SCHEMA: Schema = {
  fields: {
    id:      { type: 'keyword', store: true,  indexed: true  },
    title:   { type: 'text',    store: true,  indexed: true,  boost: 2.0 },
    body:    { type: 'text',    store: false, indexed: true  },
    tags:    { type: 'keyword', store: true,  indexed: true,  analyzer: 'keyword' },
  },
};

const WORDS = [
  'search', 'engine', 'index', 'query', 'document', 'segment', 'lucene',
  'typescript', 'node', 'javascript', 'data', 'cloud', 'storage', 's3',
  'inverted', 'term', 'posting', 'bm25', 'score', 'relevance', 'ranking',
  'fulltext', 'analyzer', 'tokenize', 'filter', 'phrase', 'wildcard', 'range',
  'field', 'boost', 'idf', 'frequency', 'merge', 'commit', 'schema',
];

function rand<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]!; }
function randWords(n: number): string { return Array.from({ length: n }, () => rand(WORDS)).join(' '); }

function hr(label: string, ms: number, count: number): void {
  const avg = (ms / count).toFixed(2);
  const tp  = (count / (ms / 1000)).toFixed(0);
  console.log(`  ${label.padEnd(20)} total=${ms.toFixed(0)}ms  avg=${avg}ms  throughput=${tp}/s`);
}

async function main(): Promise<void> {
  console.log(`\n=== lucene-ts benchmark ===`);
  console.log(`  docs=${N_DOCS}  queries=${N_QUERIES}  topK=${TOP_K}\n`);

  const dir = new MemoryIndexDirectory();
  const { writer, searcher } = createIndex(dir, SCHEMA, { commitThreshold: 2_500 });

  // ── Indexing ──────────────────────────────────────────────────────────────
  const t0 = Date.now();
  for (let i = 0; i < N_DOCS; i++) {
    await writer.addDocument({
      id:    `doc-${i}`,
      title: randWords(6),
      body:  randWords(30),
      tags:  rand(WORDS),
    });
  }
  await writer.close();
  const indexMs = Date.now() - t0;
  hr('indexing', indexMs, N_DOCS);

  // ── Searching ─────────────────────────────────────────────────────────────
  const queries = Array.from({ length: N_QUERIES }, () => rand(WORDS));

  const t1 = Date.now();
  let hits = 0;
  for (const q of queries) {
    const res = await searcher.search(q, { topK: TOP_K });
    hits += res.length;
  }
  const searchMs = Date.now() - t1;
  hr('searching', searchMs, N_QUERIES);

  console.log(`\n  avg hits/query: ${(hits / N_QUERIES).toFixed(1)}`);
  console.log();
}

main().catch(err => { console.error(err); process.exit(1); });
