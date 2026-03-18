#!/usr/bin/env bun
/**
 * BeIR benchmark runner for lucene-ts.
 *
 * Downloads (and caches) a BeIR dataset, indexes the corpus with the chosen
 * storage backend, runs all queries, and reports standard IR metrics.
 *
 * Usage:
 *   bun bench/beir.ts --dataset hotpotqa
 *   bun bench/beir.ts --dataset msmarco --backend fs --index-dir /tmp/msmarco-idx
 *   bun bench/beir.ts --dataset hotpotqa --backend memory --max-docs 50000
 *   bun bench/beir.ts --dataset msmarco --backend s3 --s3-bucket my-bucket
 *
 * Options:
 *   --dataset  <name>    hotpotqa | msmarco | nfcorpus | fiqa | ...  [required]
 *   --backend  <name>    memory | fs | s3                            [default: fs]
 *   --data-dir <path>    Dataset cache directory                     [default: bench/data]
 *   --index-dir <path>   Index directory (fs backend)                [default: bench/index-<dataset>]
 *   --s3-bucket <name>   S3 bucket (s3 backend)
 *   --s3-prefix <pfx>    S3 key prefix                              [default: beir/<dataset>]
 *   --s3-region <r>      AWS region                                 [default: us-east-1]
 *   --s3-endpoint <url>  Custom endpoint (LocalStack / MinIO)
 *   --max-docs <n>       Cap corpus size (0 = unlimited)            [default: 100000 for memory]
 *   --commit-every <n>   Writer auto-commit threshold               [default: 5000]
 *   --top-k <n>          Retrieval depth per query                  [default: 100]
 *   --split <name>       Qrel split: test | dev | train             [auto per dataset]
 *   --no-merge           Skip SegmentMerger.mergeAll() after indexing
 *   --quiet              No progress bars; print summary only
 */

import path from 'node:path';
import {
  MemoryIndexDirectory,
  FsIndexDirectory,
  createIndex,
  SegmentMerger,
} from '../src/index.js';
import type { IndexDirectory, IndexConfig } from '../src/index.js';
import {
  ensureDataset,
  streamCorpus,
  loadQueries,
  loadQrels,
  KNOWN_CORPUS_SIZES,
  DATASET_DEFAULT_SPLIT,
  type DatasetName,
} from './download.js';
import { evaluateRun, type Run, type Qrels } from './metrics.js';

// ─── CLI args ─────────────────────────────────────────────────────────────────

interface Args {
  dataset:     string;
  backend:     'memory' | 'fs' | 's3';
  dataDir:     string;
  indexDir?:   string;
  s3Bucket?:   string;
  s3Prefix?:   string;
  s3Region:    string;
  s3Endpoint?: string;
  maxDocs:     number;   // 0 = unlimited
  commitEvery: number;
  topK:        number;
  split?:      string;
  noMerge:     boolean;
  quiet:       boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dataset:     '',
    backend:     'fs',
    dataDir:     path.join(import.meta.dir, 'data'),
    s3Region:    'us-east-1',
    maxDocs:     0,
    commitEvery: 5_000,
    topK:        100,
    noMerge:     false,
    quiet:       false,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = argv[i + 1] ?? '';
    switch (flag) {
      case '--dataset':      args.dataset     = next; i++; break;
      case '--backend':      args.backend     = next as Args['backend']; i++; break;
      case '--data-dir':     args.dataDir     = next; i++; break;
      case '--index-dir':    args.indexDir    = next; i++; break;
      case '--s3-bucket':    args.s3Bucket    = next; i++; break;
      case '--s3-prefix':    args.s3Prefix    = next; i++; break;
      case '--s3-region':    args.s3Region    = next; i++; break;
      case '--s3-endpoint':  args.s3Endpoint  = next; i++; break;
      case '--max-docs':     args.maxDocs     = parseInt(next, 10); i++; break;
      case '--commit-every': args.commitEvery = parseInt(next, 10); i++; break;
      case '--top-k':        args.topK        = parseInt(next, 10); i++; break;
      case '--split':        args.split       = next; i++; break;
      case '--no-merge':     args.noMerge     = true; break;
      case '--quiet':        args.quiet       = true; break;
      case '--help': case '-h':
        printUsage(); process.exit(0);
    }
  }

  if (!args.dataset) {
    console.error('Error: --dataset is required.\n');
    printUsage();
    process.exit(1);
  }
  if (!['memory', 'fs', 's3'].includes(args.backend)) {
    console.error(`Error: unknown backend "${args.backend}". Use memory, fs, or s3.\n`);
    process.exit(1);
  }
  if (args.topK < 100) {
    process.stderr.write(`[warn] --top-k ${args.topK} < 100 — NDCG@100, MAP@100, Recall@100 will be underestimated. Bumping to 100.\n`);
    args.topK = 100;
  }
  if (args.backend === 'memory' && args.maxDocs === 0) {
    const known = KNOWN_CORPUS_SIZES[args.dataset];
    const size  = known ? `~${(known / 1e6).toFixed(1)}M` : 'unknown number of';
    process.stderr.write(
      `[warn] memory backend selected for ${args.dataset} (${size} docs). ` +
      `Defaulting to --max-docs 100000. Use --max-docs 0 on a machine with ` +
      `sufficient RAM to index the full corpus.\n`,
    );
    args.maxDocs = 100_000;
  }
  if (args.backend === 's3' && !args.s3Bucket) {
    console.error('Error: --s3-bucket is required for the s3 backend.\n');
    process.exit(1);
  }

  return args;
}

function printUsage(): void {
  console.log(`
Usage: bun bench/beir.ts --dataset <name> [options]

Datasets:  hotpotqa, msmarco, nfcorpus, fiqa, arguana, scifact, trec_covid, nq, quora, ...
Backends:  memory (fast/limited), fs (default), s3 (production)

Examples:
  bun bench/beir.ts --dataset hotpotqa
  bun bench/beir.ts --dataset msmarco --backend fs --index-dir /tmp/idx
  bun bench/beir.ts --dataset hotpotqa --backend memory --max-docs 50000
  bun bench/beir.ts --dataset nfcorpus --backend s3 --s3-bucket my-bucket
`.trim());
}

// ─── Backend factory ──────────────────────────────────────────────────────────

async function makeDirectory(args: Args): Promise<{ dir: IndexDirectory; description: string }> {
  switch (args.backend) {
    case 'memory': {
      return {
        dir:         new MemoryIndexDirectory(),
        description: 'MemoryIndexDirectory',
      };
    }
    case 'fs': {
      const indexDir = args.indexDir ?? path.join(import.meta.dir, `index-${args.dataset}`);
      return {
        dir:         new FsIndexDirectory(indexDir),
        description: `FsIndexDirectory  ${indexDir}`,
      };
    }
    case 's3': {
      let S3Client: unknown, S3IndexDirectory: unknown;
      try {
        const sdk = await import('@aws-sdk/client-s3');
        S3Client = sdk.S3Client;
        const dirMod = await import('../src/directory-s3.js');
        S3IndexDirectory = dirMod.S3IndexDirectory;
      } catch {
        console.error(
          'Error: @aws-sdk/client-s3 is required for the S3 backend.\n' +
          'Install it with: bun add @aws-sdk/client-s3',
        );
        process.exit(1);
      }
      const clientOptions: Record<string, unknown> = { region: args.s3Region };
      if (args.s3Endpoint) clientOptions['endpoint'] = args.s3Endpoint;
      const client = new (S3Client as new (o: unknown) => unknown)(clientOptions);
      const prefix = args.s3Prefix ?? `beir/${args.dataset}`;
      const dir = new (S3IndexDirectory as new (c: unknown, b: string, p: string) => IndexDirectory)(
        client, args.s3Bucket!, prefix,
      );
      return {
        dir,
        description: `S3IndexDirectory  s3://${args.s3Bucket}/${prefix}`,
      };
    }
  }
}

// ─── Progress display ─────────────────────────────────────────────────────────

function formatDuration(secs: number): string {
  if (secs < 60)    return `${Math.round(secs)}s`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m${String(Math.round(secs % 60)).padStart(2, '0')}s`;
  return `${Math.floor(secs / 3600)}h${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}m`;
}

function fmt(n: number): string { return n.toLocaleString(); }

interface Ticker {
  tick(count: number): void;
  done(count: number, elapsedMs: number): void;
}

function makeTicker(label: string, approxTotal: number | undefined, quiet: boolean): Ticker {
  let lastWrite = 0;
  const logEvery = quiet ? 50_000 : 1_000;

  const write = (count: number, t0: number) => {
    const elapsed = (Date.now() - t0) / 1000;
    const rate    = elapsed > 0 ? count / elapsed : 0;
    if (approxTotal && approxTotal > 0) {
      const eta  = rate > 0 ? formatDuration((approxTotal - count) / rate) : '—';
      const pct  = ((count / approxTotal) * 100).toFixed(1);
      process.stderr.write(
        `\r  [${label}] ${fmt(count)} / ~${fmt(approxTotal)}  (${pct}%)  ${fmt(Math.round(rate))}/s  ETA ${eta}   `,
      );
    } else {
      process.stderr.write(
        `\r  [${label}] ${fmt(count)}  ${fmt(Math.round(rate))}/s  `,
      );
    }
  };

  let t0 = Date.now();

  return {
    tick(count: number) {
      const now = Date.now();
      if (count % logEvery !== 0 && now - lastWrite < 500) return;
      if (t0 === 0) t0 = now;
      lastWrite = now;
      if (quiet && count % logEvery === 0) {
        console.log(`  [${label}] ${fmt(count)}${approxTotal ? ` / ~${fmt(approxTotal)}` : ''}`);
      } else if (!quiet) {
        write(count, t0);
      }
    },
    done(count: number, elapsedMs: number) {
      const secs = elapsedMs / 1000;
      const rate = secs > 0 ? Math.round(count / secs) : 0;
      if (!quiet) process.stderr.write('\r' + ' '.repeat(80) + '\r'); // clear line
      console.log(
        `  [${label}] ${fmt(count)} docs in ${formatDuration(secs)}` +
        `  (${fmt(rate)}/s)`,
      );
    },
  };
}

// ─── Index config ─────────────────────────────────────────────────────────────

const INDEX_CONFIG: IndexConfig = {
  analyzers: { id: 'keyword' },
  noStore:   ['text'],     // index text but don't store — saves disk/RAM
  boost:     { title: 2.0 },
};

// ─── Indexing loop ────────────────────────────────────────────────────────────

async function indexCorpus(
  args:          Args,
  directory:     IndexDirectory,
  datasetPaths:  { corpusPath: string },
): Promise<{ indexed: number; durationMs: number }> {
  const { writer } = createIndex(directory, INDEX_CONFIG, {
    commitThreshold: args.commitEvery,
  });

  const approxTotal = KNOWN_CORPUS_SIZES[args.dataset];
  const limit       = args.maxDocs > 0 ? args.maxDocs : Infinity;
  const ticker      = makeTicker('index', approxTotal, args.quiet);

  let indexed = 0;
  const t0 = Date.now();

  for await (const doc of streamCorpus(datasetPaths.corpusPath)) {
    if (indexed >= limit) break;

    await writer.addDocument({
      id:    doc._id,
      title: doc.title ?? '',
      text:  doc.text  ?? '',
    });

    indexed++;
    ticker.tick(indexed);
  }

  await writer.close();
  const durationMs = Date.now() - t0;
  ticker.done(indexed, durationMs);
  return { indexed, durationMs };
}

// ─── Merge ────────────────────────────────────────────────────────────────────

async function mergeSegments(directory: IndexDirectory): Promise<{ durationMs: number }> {
  process.stderr.write('  [merge] consolidating segments...');
  const t0      = Date.now();
  const merger  = new SegmentMerger(directory);
  await merger.mergeAll();
  const elapsed = Date.now() - t0;
  process.stderr.write(`\r  [merge] done in ${formatDuration(elapsed / 1000)}\n`);
  return { durationMs: elapsed };
}

// ─── Query loop ───────────────────────────────────────────────────────────────

async function runQueries(
  args:      Args,
  directory: IndexDirectory,
  queries:   Map<string, string>,
  qrels:     Qrels,
): Promise<{ run: Run; durationMs: number }> {
  const { searcher } = createIndex(directory, INDEX_CONFIG);
  // Invalidate cache — segments may have changed after merge
  searcher.invalidateCache();

  const run:    Run  = new Map();
  const ticker       = makeTicker('search', queries.size, args.quiet);
  let   count        = 0;
  const t0           = Date.now();

  for (const [qid, text] of queries) {
    if (!text.trim()) continue; // skip blank queries
    try {
      const results = await searcher.search(text, { topK: args.topK });
      run.set(qid, results.map(r => r.docId));
    } catch {
      // Query parse errors (e.g. malformed boolean syntax) — return empty
      run.set(qid, []);
    }
    count++;
    ticker.tick(count);
  }

  const durationMs = Date.now() - t0;
  ticker.done(count, durationMs);
  return { run, durationMs };
}

// ─── Report ───────────────────────────────────────────────────────────────────

function printReport(
  args:          Args,
  dirDescription: string,
  datasetPaths:  { splitUsed: string },
  indexResult:   { indexed: number; durationMs: number },
  mergeMs:       number | null,
  queryResult:   { run: Run; durationMs: number },
  qrels:         Qrels,
): void {
  const { scores, numQueriesWithQrels, numQueriesSkipped } = evaluateRun(queryResult.run, qrels);

  const line = (label: string, value: string) =>
    console.log(`  ${label.padEnd(16)} ${value}`);

  console.log('\n' + '═'.repeat(60));
  console.log(`  BeIR: ${args.dataset}  (split: ${datasetPaths.splitUsed})`);
  console.log('═'.repeat(60));

  line('Backend:',  dirDescription);
  line('Corpus:',   `${fmt(indexResult.indexed)} docs  (${formatDuration(indexResult.durationMs / 1000)})` +
                    (args.maxDocs > 0 ? `  ← capped at ${fmt(args.maxDocs)}` : ''));
  if (mergeMs !== null) {
    line('Merge:', `${formatDuration(mergeMs / 1000)}`);
  }
  line('Queries:',  `${fmt(numQueriesWithQrels)} evaluated` +
                    (numQueriesSkipped > 0 ? `  (${fmt(numQueriesSkipped)} skipped — no qrels)` : ''));
  line('Search:',   `${formatDuration(queryResult.durationMs / 1000)}  topK=${args.topK}` +
                    `  avg ${((queryResult.durationMs / Math.max(queryResult.run.size, 1))).toFixed(1)}ms/query`);

  console.log('─'.repeat(60));

  const metric = (name: keyof typeof scores) =>
    console.log(`  ${name.padEnd(14)} ${scores[name].toFixed(4)}`);

  metric('NDCG@10');
  metric('NDCG@100');
  metric('MAP@100');
  metric('Recall@10');
  metric('Recall@100');
  metric('MRR@10');

  console.log('═'.repeat(60));
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`\n  BeIR benchmark — ${args.dataset} / ${args.backend}\n`);

  // 1. Dataset
  console.log('  [dataset] resolving...');
  const datasetPaths = await ensureDataset(args.dataset as DatasetName, args.dataDir, args.split);
  const defaultSplit = DATASET_DEFAULT_SPLIT[args.dataset] ?? 'test';
  if (datasetPaths.splitUsed !== defaultSplit && !args.split) {
    process.stderr.write(`  [warn] preferred split "${defaultSplit}" not found; using "${datasetPaths.splitUsed}"\n`);
  }
  console.log(`  [dataset] qrels: ${datasetPaths.splitUsed}.tsv\n`);

  // 2. Backend
  const { dir: directory, description: dirDescription } = await makeDirectory(args);
  console.log(`  [backend] ${dirDescription}\n`);

  // 3. Index corpus
  console.log('  Indexing corpus...');
  const indexResult = await indexCorpus(args, directory, datasetPaths);

  // 4. Merge
  let mergeMs: number | null = null;
  if (!args.noMerge) {
    const { durationMs } = await mergeSegments(directory);
    mergeMs = durationMs;
  }

  // 5. Load queries + qrels
  process.stderr.write('  Loading queries and qrels...');
  const [queries, qrels] = await Promise.all([
    loadQueries(datasetPaths.queriesPath),
    loadQrels(datasetPaths.qrelsPath),
  ]);
  process.stderr.write(`\r  Loaded ${fmt(queries.size)} queries, ${fmt(qrels.size)} qrel entries.\n\n`);

  // 6. Run queries
  console.log('  Running queries...');
  const queryResult = await runQueries(args, directory, queries, qrels);

  // 7. Report
  printReport(args, dirDescription, datasetPaths, indexResult, mergeMs, queryResult, qrels);
}

main().catch(err => { console.error(err); process.exit(1); });
