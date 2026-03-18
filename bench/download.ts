/**
 * BeIR dataset download, caching, and streaming parse utilities.
 *
 * Download sources (tried in order):
 *  1. UKP TU Darmstadt public server (original BeIR hosting)
 *     https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/
 *  2. HuggingFace Hub (BeIR organisation)
 *     https://huggingface.co/datasets/BeIR/<dataset>
 *     Data is served as Parquet shards; hyparquet converts them to the same
 *     JSONL / TSV layout that the UKP zip produces, so the rest of the code
 *     is backend-agnostic.
 *
 * After the first successful download the data is cached in:
 *   <dataDir>/<dataset>/corpus.jsonl
 *   <dataDir>/<dataset>/queries.jsonl
 *   <dataDir>/<dataset>/qrels/{test,dev,train}.tsv
 * Subsequent runs skip the download entirely.
 *
 * System requirements for the UKP path: curl, unzip.
 * For the HuggingFace path: internet access + `hyparquet` dev-dependency.
 */

import { createReadStream } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { Qrels } from './metrics.js';

// ─── Dataset registry ─────────────────────────────────────────────────────────

export type DatasetName = 'hotpotqa' | 'msmarco' | string;

const UKP_BASE = 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets';
const HF_API   = 'https://datasets-server.huggingface.co/parquet?dataset=BeIR%2F';

/**
 * Default qrel split per dataset.
 * MSMARCO has no public test qrels — dev is the standard evaluation split.
 */
export const DATASET_DEFAULT_SPLIT: Record<string, string> = {
  msmarco: 'dev',
};

/** Approximate corpus sizes for ETA display during indexing. */
export const KNOWN_CORPUS_SIZES: Record<string, number> = {
  msmarco:          8_841_823,
  hotpotqa:         5_233_329,
  nfcorpus:             3_633,
  fiqa:                57_638,
  arguana:              8_674,
  scifact:              5_183,
  trec_covid:         171_332,
  webis_touche2020:   382_545,
  dbpedia_entity:   4_635_922,
  scidocs:             25_657,
  fever:            5_416_568,
  climate_fever:    5_416_593,
  nq:               2_681_468,
  quora:              522_931,
};

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CorpusDoc {
  _id:    string;
  title:  string;
  text:   string;
}

export interface BeirQuery {
  _id:  string;
  text: string;
}

export interface DatasetPaths {
  dir:         string;
  corpusPath:  string;
  queriesPath: string;
  qrelsPath:   string;
  splitUsed:   string;
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function findQrelsPath(
  datasetDir: string,
  preferred:  string,
): Promise<{ qrelsPath: string; splitUsed: string } | null> {
  const candidates = [preferred, 'test', 'dev', 'train'].filter(
    (s, i, a) => a.indexOf(s) === i,
  );
  for (const s of candidates) {
    const p = path.join(datasetDir, 'qrels', `${s}.tsv`);
    if (await pathExists(p)) return { qrelsPath: p, splitUsed: s };
  }
  return null;
}

// ─── Public: ensure dataset ───────────────────────────────────────────────────

/**
 * Ensure the BeIR dataset is present in `dataDir`, downloading if necessary.
 * Returns paths to corpus, queries, and qrels files.
 */
export async function ensureDataset(
  dataset:        DatasetName,
  dataDir:        string,
  preferredSplit?: string,
): Promise<DatasetPaths> {
  const datasetDir  = path.join(dataDir, dataset);
  const corpusPath  = path.join(datasetDir, 'corpus.jsonl');
  const queriesPath = path.join(datasetDir, 'queries.jsonl');
  const split       = preferredSplit ?? DATASET_DEFAULT_SPLIT[dataset] ?? 'test';

  // ── Serve from cache ───────────────────────────────────────────────────────
  if (await pathExists(corpusPath)) {
    const found = await findQrelsPath(datasetDir, split);
    if (found) {
      console.log(`  Dataset cached: ${datasetDir}`);
      return { dir: datasetDir, corpusPath, queriesPath, ...found };
    }
  }

  await mkdir(datasetDir, { recursive: true });
  await mkdir(path.join(datasetDir, 'qrels'), { recursive: true });

  // ── Try UKP ────────────────────────────────────────────────────────────────
  let ukpError: string | null = null;
  try {
    await downloadFromUKP(dataset, dataDir, datasetDir);
  } catch (err) {
    ukpError = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `\n  [warn] UKP download failed: ${ukpError}\n` +
      `  Trying HuggingFace (BeIR/${dataset})...\n\n`,
    );
  }

  // ── Fallback: HuggingFace ──────────────────────────────────────────────────
  if (ukpError) {
    try {
      await downloadFromHuggingFace(dataset, datasetDir, split);
    } catch (hfErr) {
      const hfMsg = hfErr instanceof Error ? hfErr.message : String(hfErr);
      throw new Error(
        `Both download sources failed.\n\n` +
        `  UKP error:         ${ukpError}\n` +
        `  HuggingFace error: ${hfMsg}\n\n` +
        `Manual setup:\n` +
        `  Place these files in ${datasetDir}/\n` +
        `    corpus.jsonl          — one JSON object per line: {_id, title, text}\n` +
        `    queries.jsonl         — one JSON object per line: {_id, text}\n` +
        `    qrels/${split}.tsv   — TSV with header: query-id\\tcorpus-id\\tscore\n\n` +
        `  Get the data from: https://huggingface.co/datasets/BeIR/${dataset}`,
      );
    }
  }

  const found = await findQrelsPath(datasetDir, split);
  if (!found) {
    throw new Error(
      `No qrels file found under ${path.join(datasetDir, 'qrels')}.\n` +
      `Tried splits: test, dev, train.\n` +
      `Use --split <name> to specify the split explicitly.`,
    );
  }

  return { dir: datasetDir, corpusPath, queriesPath, ...found };
}

// ─── UKP download ─────────────────────────────────────────────────────────────

async function downloadFromUKP(
  dataset:    string,
  dataDir:    string,
  datasetDir: string,
): Promise<void> {
  const url     = `${UKP_BASE}/${dataset}.zip`;
  const zipPath = path.join(dataDir, `${dataset}.zip`);

  if (!(await pathExists(zipPath))) {
    console.log(`  Downloading from UKP TU Darmstadt: ${url}`);
    const curl = Bun.spawn(
      ['curl', '-L', '--progress-bar', '-o', zipPath, url],
      { stderr: 'inherit' },
    );
    const exit = await curl.exited;
    if (exit !== 0) throw new Error(`curl exited with code ${exit}`);
  } else {
    console.log(`  Found cached zip: ${zipPath}`);
  }

  console.log(`  Extracting to ${dataDir}...`);
  const unzip = Bun.spawn(
    ['unzip', '-oq', zipPath, '-d', dataDir],
    { stderr: 'inherit' },
  );
  const unzipExit = await unzip.exited;
  if (unzipExit !== 0) throw new Error(`unzip exited with code ${unzipExit}`);

  // UKP zip may extract to a directory with a slightly different name
  // (e.g. "msmarco/") that differs from what we expect. The datasetDir
  // should already match since we extract to dataDir.
  const corpusPath = path.join(datasetDir, 'corpus.jsonl');
  if (!(await pathExists(corpusPath))) {
    throw new Error(`Extraction succeeded but corpus.jsonl not found at ${corpusPath}`);
  }
  console.log('  Extraction complete.');
}

// ─── HuggingFace Parquet download ─────────────────────────────────────────────

interface HFParquetFile {
  config:   string;
  split:    string;
  url:      string;
  filename: string;
  size:     number;
}

async function downloadFromHuggingFace(
  dataset:    string,
  datasetDir: string,
  split:      string,
): Promise<void> {
  // ── Discover Parquet files ─────────────────────────────────────────────────
  const apiUrl  = `${HF_API}${dataset}`;
  console.log(`  Querying HuggingFace datasets API...`);
  const apiResp = await fetch(apiUrl);

  if (!apiResp.ok) {
    throw new Error(
      `HuggingFace datasets API returned HTTP ${apiResp.status} for BeIR/${dataset}.\n` +
      `The dataset may not exist or may not have been converted to Parquet.\n` +
      `Check: https://huggingface.co/datasets/BeIR/${dataset}`,
    );
  }

  const meta = await apiResp.json() as { parquet_files: HFParquetFile[] };
  if (!meta.parquet_files?.length) {
    throw new Error(`HuggingFace returned no Parquet files for BeIR/${dataset}.`);
  }

  // Group by "config/split" key
  const groups = new Map<string, HFParquetFile[]>();
  for (const f of meta.parquet_files) {
    const key = `${f.config}/${f.split}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }

  console.log('  Available configs:');
  for (const [key, files] of groups) {
    const mb = (files.reduce((s, f) => s + f.size, 0) / 1e6).toFixed(0);
    console.log(`    ${key.padEnd(30)} ${files.length} shard(s)  ~${mb} MB`);
  }
  console.log();

  // ── Resolve config keys ────────────────────────────────────────────────────
  const corpusKey  = pickConfig(groups, ['corpus/corpus', 'default/corpus']);
  const queriesKey = pickConfig(groups, ['queries/queries', 'default/queries']);
  const qrelKeys   = [...groups.keys()].filter(k =>
    k.includes('qrel') || k.startsWith('qrels'),
  );

  if (!corpusKey) {
    throw new Error(
      `Could not identify corpus config in HuggingFace dataset.\n` +
      `Available: ${[...groups.keys()].join(', ')}`,
    );
  }

  // ── Try to also fetch qrels from a companion dataset ──────────────────────
  // Some BeIR datasets keep qrels in BeIR/<dataset>-qrels
  if (qrelKeys.length === 0) {
    try {
      await fetchCompanionQrels(dataset, datasetDir, split);
    } catch {
      process.stderr.write(
        `  [warn] No qrels found in BeIR/${dataset} or BeIR/${dataset}-qrels.\n`,
      );
    }
  }

  // ── Convert corpus → corpus.jsonl ─────────────────────────────────────────
  await convertShardsToJsonl(
    groups.get(corpusKey)!,
    path.join(datasetDir, 'corpus.jsonl'),
    (row: Record<string, unknown>) => ({
      _id:   String(row['_id'] ?? row['id'] ?? ''),
      title: String(row['title'] ?? ''),
      text:  String(row['text'] ?? ''),
    }),
    'corpus',
  );

  // ── Convert queries → queries.jsonl ───────────────────────────────────────
  if (queriesKey) {
    await convertShardsToJsonl(
      groups.get(queriesKey)!,
      path.join(datasetDir, 'queries.jsonl'),
      (row: Record<string, unknown>) => ({
        _id:  String(row['_id'] ?? row['id'] ?? ''),
        text: String(row['text'] ?? ''),
      }),
      'queries',
    );
  }

  // ── Convert qrels → qrels/<split>.tsv ────────────────────────────────────
  for (const key of qrelKeys) {
    const qrelSplit = key.split('/').pop()!;
    await convertShardsToQrelsTsv(
      groups.get(key)!,
      path.join(datasetDir, 'qrels', `${qrelSplit}.tsv`),
      qrelSplit,
    );
  }
}

function pickConfig(groups: Map<string, HFParquetFile[]>, candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (groups.has(c)) return c;
  }
  // Fuzzy: first key whose first segment matches
  for (const k of groups.keys()) {
    if (candidates.some(c => k.split('/')[0] === c.split('/')[0])) return k;
  }
  return undefined;
}

/** Some BeIR datasets store qrels in a companion repo: BeIR/<dataset>-qrels */
async function fetchCompanionQrels(
  dataset:    string,
  datasetDir: string,
  split:      string,
): Promise<void> {
  const apiResp = await fetch(`${HF_API}${dataset}-qrels`);
  if (!apiResp.ok) throw new Error(`HTTP ${apiResp.status}`);

  const meta = await apiResp.json() as { parquet_files: HFParquetFile[] };
  const groups = new Map<string, HFParquetFile[]>();
  for (const f of meta.parquet_files ?? []) {
    const key = `${f.config}/${f.split}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }

  for (const [key, files] of groups) {
    const qrelSplit = key.split('/').pop()!;
    await convertShardsToQrelsTsv(
      files,
      path.join(datasetDir, 'qrels', `${qrelSplit}.tsv`),
      qrelSplit,
    );
  }
}

// ─── Parquet → JSONL / TSV conversion ────────────────────────────────────────

type ParquetReadFn = (opts: {
  file:       ArrayBuffer;
  onComplete: (rows: unknown[]) => void;
  rowFormat:  'object';
}) => Promise<void>;

async function getParquetRead(): Promise<ParquetReadFn> {
  try {
    const mod = await import('hyparquet') as typeof import('hyparquet');
    return mod.parquetRead as ParquetReadFn;
  } catch {
    throw new Error(
      'hyparquet is required for HuggingFace download but is not installed.\n' +
      'Run:  bun add -d hyparquet',
    );
  }
}

async function fetchShard(url: string): Promise<ArrayBuffer> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.arrayBuffer();
}

async function convertShardsToJsonl(
  shards:    HFParquetFile[],
  outPath:   string,
  transform: (row: Record<string, unknown>) => Record<string, unknown>,
  label:     string,
): Promise<void> {
  const parquetRead = await getParquetRead();
  const writer = Bun.file(outPath).writer();
  let total = 0;

  for (let i = 0; i < shards.length; i++) {
    const shard = shards[i]!;
    const mb = (shard.size / 1e6).toFixed(0);
    process.stderr.write(`\r  [${label}] downloading shard ${i + 1}/${shards.length} (${mb} MB)...  `);
    const buf = await fetchShard(shard.url);

    process.stderr.write(`\r  [${label}] parsing shard ${i + 1}/${shards.length}...  `);
    let shardCount = 0;
    await parquetRead({
      file: buf,
      onComplete(rows: unknown[]) {
        // Use for...of — never spread large arrays as function arguments
        for (const row of rows as Record<string, unknown>[]) {
          writer.write(JSON.stringify(transform(row)) + '\n');
          shardCount++;
        }
      },
      rowFormat: 'object',
    });
    total += shardCount;
    process.stderr.write(`\r  [${label}] shard ${i + 1}/${shards.length}: ${shardCount.toLocaleString()} rows\n`);
  }

  await writer.end();
  console.log(`  [${label}] ${total.toLocaleString()} total rows → ${outPath}`);
}

async function convertShardsToQrelsTsv(
  shards:     HFParquetFile[],
  outPath:    string,
  splitLabel: string,
): Promise<void> {
  const parquetRead = await getParquetRead();
  const writer = Bun.file(outPath).writer();
  writer.write('query-id\tcorpus-id\tscore\n');
  let total = 0;

  for (const shard of shards) {
    const buf = await fetchShard(shard.url);
    await parquetRead({
      file: buf,
      onComplete(rows: unknown[]) {
        for (const row of rows as Record<string, unknown>[]) {
          const qid   = row['query-id']  ?? row['query_id']  ?? '';
          const cid   = row['corpus-id'] ?? row['corpus_id'] ?? '';
          const score = row['score'] ?? 0;
          writer.write(`${qid}\t${cid}\t${score}\n`);
          total++;
        }
      },
      rowFormat: 'object',
    });
  }

  await writer.end();
  process.stderr.write(`  [qrels/${splitLabel}] ${total.toLocaleString()} entries → ${outPath}\n`);
}

// ─── Streaming JSONL reader ───────────────────────────────────────────────────

async function* readJsonl<T>(filePath: string): AsyncGenerator<T> {
  const rl = createInterface({
    input:     createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  let malformed = 0;
  for await (const raw of rl) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (!line) continue;
    try {
      yield JSON.parse(line) as T;
    } catch {
      if (++malformed <= 3) {
        process.stderr.write(`  [warn] malformed JSON: ${line.slice(0, 80)}\n`);
      }
    }
  }
  if (malformed > 3) {
    process.stderr.write(`  [warn] ${malformed} malformed JSON lines total.\n`);
  }
}

/**
 * Stream corpus documents one at a time.
 * Never loads the full corpus into RAM — suitable for 8M+ document sets.
 */
export function streamCorpus(corpusPath: string): AsyncGenerator<CorpusDoc> {
  return readJsonl<CorpusDoc>(corpusPath);
}

/**
 * Load all queries into memory (~7K entries — small).
 * Returns Map<queryId, queryText>.
 */
export async function loadQueries(queriesPath: string): Promise<Map<string, string>> {
  const queries = new Map<string, string>();
  for await (const q of readJsonl<BeirQuery>(queriesPath)) {
    if (q._id && q.text?.trim()) queries.set(q._id, q.text);
  }
  return queries;
}

/**
 * Load relevance judgements from a TSV file.
 * First line is a mandatory header (query-id\tcorpus-id\tscore) — always skipped.
 * Entries with score=0 are kept (they are "judged non-relevant"; metric
 * functions check `rel > 0` when counting relevant documents).
 */
export async function loadQrels(qrelsPath: string): Promise<Qrels> {
  const qrels: Qrels = new Map();
  const rl = createInterface({
    input:     createReadStream(qrelsPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  let firstLine = true;
  for await (const line of rl) {
    if (firstLine) { firstLine = false; continue; }
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    const [qid, cid, scoreStr] = parts as [string, string, string];
    const score = parseInt(scoreStr, 10);
    if (isNaN(score)) continue;

    let docMap = qrels.get(qid);
    if (!docMap) { docMap = new Map(); qrels.set(qid, docMap); }
    docMap.set(cid, score);
  }

  return qrels;
}
