/**
 * BeIR dataset download, caching, and streaming parse utilities.
 *
 * Datasets are downloaded from the UKP TU Darmstadt public server (the
 * canonical source used in the BeIR paper). Downloaded zips are cached on
 * disk so subsequent runs skip the download.
 *
 * System requirements: `curl` and `unzip` must be in PATH.
 */

import { createReadStream } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { Qrels } from './metrics.js';

// ─── Dataset registry ─────────────────────────────────────────────────────────

export type DatasetName = 'hotpotqa' | 'msmarco' | string;

const BASE_URL = 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets';

/**
 * Which qrels split to use by default for each dataset.
 * MSMARCO has no public test qrels, so dev is the standard evaluation split.
 */
export const DATASET_DEFAULT_SPLIT: Record<string, string> = {
  msmarco: 'dev',
};

/**
 * Approximate corpus sizes used to compute accurate ETAs during indexing.
 * These match the original BeIR paper corpus sizes.
 */
export const KNOWN_CORPUS_SIZES: Record<string, number> = {
  msmarco:   8_841_823,
  hotpotqa:  5_233_329,
  nfcorpus:      3_633,
  fiqa:         57_638,
  arguana:       8_674,
  scifact:       5_183,
  trec_covid:   171_332,
  webis_touche2020: 382_545,
  dbpedia_entity: 4_635_922,
  scidocs:       25_657,
  fever:      5_416_568,
  climate_fever: 5_416_593,
  nq:         2_681_468,
  quora:        522_931,
  cqadupstack:  457_199,
};

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

// ─── Download and cache ───────────────────────────────────────────────────────

/**
 * Ensure the BeIR dataset is downloaded and extracted.
 *
 * Layout after extraction (mirrors the upstream zip structure):
 *   <dataDir>/<dataset>/corpus.jsonl
 *   <dataDir>/<dataset>/queries.jsonl
 *   <dataDir>/<dataset>/qrels/{test,dev,train}.tsv
 */
export async function ensureDataset(
  dataset:          DatasetName,
  dataDir:          string,
  preferredSplit?:  string,
): Promise<DatasetPaths> {
  const datasetDir  = path.join(dataDir, dataset);
  const corpusPath  = path.join(datasetDir, 'corpus.jsonl');
  const queriesPath = path.join(datasetDir, 'queries.jsonl');

  // Resolve qrels split
  const defaultSplit = DATASET_DEFAULT_SPLIT[dataset] ?? 'test';
  const split        = preferredSplit ?? defaultSplit;

  // Try the preferred split first, then fall back to other common names
  const candidateSplits = [split, 'test', 'dev', 'train'].filter(
    (s, i, a) => a.indexOf(s) === i, // deduplicate while preserving order
  );

  async function findQrelsPath(): Promise<{ qrelsPath: string; splitUsed: string } | null> {
    for (const s of candidateSplits) {
      const p = path.join(datasetDir, 'qrels', `${s}.tsv`);
      if (await exists(p)) return { qrelsPath: p, splitUsed: s };
    }
    return null;
  }

  // If corpus and at least one qrel file already exist, skip download
  if (await exists(corpusPath)) {
    const found = await findQrelsPath();
    if (found) {
      console.log(`  Dataset cached: ${datasetDir}`);
      return { dir: datasetDir, corpusPath, queriesPath, ...found };
    }
  }

  // ── Download ───────────────────────────────────────────────────────────────
  await mkdir(dataDir, { recursive: true });

  const url     = `${BASE_URL}/${dataset}.zip`;
  const zipPath = path.join(dataDir, `${dataset}.zip`);

  if (!(await exists(zipPath))) {
    console.log(`  Downloading ${dataset} from UKP TU Darmstadt...`);
    console.log(`  URL: ${url}`);
    console.log(`  Destination: ${zipPath}`);
    console.log();

    const curl = Bun.spawn(
      ['curl', '-L', '--progress-bar', '-o', zipPath, url],
      { stderr: 'inherit' },
    );
    const exit = await curl.exited;
    if (exit !== 0) throw new Error(`curl failed with exit code ${exit}`);
  } else {
    console.log(`  Found cached zip: ${zipPath}`);
  }

  // ── Extract ────────────────────────────────────────────────────────────────
  console.log(`  Extracting to ${dataDir}...`);
  const unzip = Bun.spawn(
    ['unzip', '-oq', zipPath, '-d', dataDir],
    { stderr: 'inherit' },
  );
  const unzipExit = await unzip.exited;
  if (unzipExit !== 0) throw new Error(`unzip failed with exit code ${unzipExit}`);
  console.log('  Extraction complete.');

  const found = await findQrelsPath();
  if (!found) throw new Error(`No qrels file found under ${path.join(datasetDir, 'qrels')}. Tried: ${candidateSplits.join(', ')}.`);

  return { dir: datasetDir, corpusPath, queriesPath, ...found };
}

// ─── Streaming JSONL reader ───────────────────────────────────────────────────

async function* readJsonl<T>(filePath: string): AsyncGenerator<T> {
  const rl = createInterface({
    input:     createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  let malformed = 0;
  for await (const raw of rl) {
    const line = raw.replace(/^\uFEFF/, '').trim(); // strip BOM + whitespace
    if (!line) continue;
    try {
      yield JSON.parse(line) as T;
    } catch {
      malformed++;
      if (malformed <= 3) process.stderr.write(`  [warn] malformed JSON line (showing first 3): ${line.slice(0, 80)}\n`);
    }
  }
  if (malformed > 3) process.stderr.write(`  [warn] total malformed JSON lines: ${malformed}\n`);
}

/**
 * Stream corpus documents one at a time.
 * Never loads the full corpus into memory — suitable for 8M+ document sets.
 */
export function streamCorpus(corpusPath: string): AsyncGenerator<CorpusDoc> {
  return readJsonl<CorpusDoc>(corpusPath);
}

/**
 * Load all queries into memory (typically ~7K entries — small).
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
 *
 * Format (with mandatory header row):
 *   query-id\tcorpus-id\tscore
 *
 * Entries with score=0 are included in the map (they represent "judged
 * non-relevant"). Metric functions check `rel > 0` to detect relevance.
 */
export async function loadQrels(qrelsPath: string): Promise<Qrels> {
  const qrels: Qrels = new Map();
  const rl = createInterface({
    input:     createReadStream(qrelsPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  let firstLine = true;
  for await (const line of rl) {
    if (firstLine) { firstLine = false; continue; } // skip header
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
