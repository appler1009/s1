# lucene-ts

A Lucene-inspired full-text search engine written in TypeScript. Designed for millions of documents on AWS S3 with no JVM, no GC pauses, and human-readable JSON index files.

```
bun add lucene-ts
```

## Features

- **Immutable segments** — append-only writes, safe concurrent reads
- **BM25 scoring** — full per-document field-length normalisation (`|d|/avgdl`)
- **Lucene query syntax** — `field:term`, `"phrase"`, `term*`, `+must -mustNot`, `AND`/`OR`/`NOT`, `^boost`
- **Phrase position checking** — exact or slop-tolerant (`"quick fox"~1`)
- **S3-native** — index lives directly in S3; no plugin, no sidecar
- **Lazy postings loading** — only loads term data for queried terms (~50 KB/query vs loading the full index)
- **LRU cache** — configurable in-memory postings + term-dict cache
- **Segment merging** — automatic or manual consolidation
- **Three backends** — `MemoryIndexDirectory` (tests), `FsIndexDirectory` (local), `S3IndexDirectory` (production)
- **External full documents** — index stores metadata/snippets only; full docs live wherever you put them

## Quick start

```ts
import { MemoryIndexDirectory, createIndex } from 'lucene-ts';

const dir = new MemoryIndexDirectory();
const { writer, searcher } = createIndex(dir);

await writer.addDocument({ id: 'doc-1', title: 'Hello World', body: 'Full body text here.' });
await writer.addDocument({ id: 'doc-2', title: 'TypeScript Search', body: 'Building a search engine.' });
await writer.commit();

const results = await searcher.search('typescript search');
// results[0].doc → { id: 'doc-2', title: 'TypeScript Search' }
// results[0].score → BM25 relevance score
```

## Query syntax

| Query | Meaning |
|---|---|
| `hello` | Term in any indexed field |
| `title:hello` | Term in a specific field |
| `"quick brown fox"` | Exact phrase (position-checked; stop words create position gaps) |
| `title:"quick brown"` | Fielded phrase |
| `"quick brown"~2` | Phrase with slop: each term may be up to 2 positions away from its expected position |
| `hel*` | Wildcard (suffix/prefix/contains) |
| `title:hel*` | Fielded wildcard |
| `+typescript +search` | Both terms required (AND) |
| `typescript -java` | Must have `typescript`, must not have `java` |
| `typescript AND search` | Explicit AND |
| `typescript OR javascript` | Either term |
| `NOT java` | Exclude term |
| `title:hello^2.5` | Boost a term's score |
| `(typescript OR javascript) +search` | Grouped expression |

> **Phrase stop words:** The query analyzer mirrors the index analyzer. Stop words in a phrase (`"the quick brown"`) are filtered but their position slots are preserved, so `"the quick brown"` matches a document where "the" was at position 1, "quick" at 2, and "brown" at 3.
>
> **Boolean semantics:** When a query has no `+`/`AND`/`must` clauses, at least one `should` clause must structurally match (phrase position constraints apply). When `must` clauses are present, `should` clauses only add to the score.
>
> **Note:** Range queries (`[min TO max]`) are parsed but not yet implemented. Use the `filter` option instead: `{ filter: doc => Number(doc.year) >= 2020 }`.

## Backends

### In-memory (tests / prototyping)

```ts
import { MemoryIndexDirectory } from 'lucene-ts';

const dir = new MemoryIndexDirectory();
```

### Filesystem (local dev / small deployments)

```ts
import { FsIndexDirectory } from 'lucene-ts';

const dir = new FsIndexDirectory('/var/data/my-index');
```

### S3 (production)

Requires `@aws-sdk/client-s3` as a peer dependency:

```
bun add @aws-sdk/client-s3
```

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { S3IndexDirectory } from 'lucene-ts';

const client = new S3Client({ region: 'us-east-1' });
const dir = new S3IndexDirectory(client, 'my-bucket', 'search-index/v1');
```

All index files are written under `<prefix>/` in the bucket. The `S3Client` is fully user-controlled — use standard AWS credential providers, LocalStack, MinIO, or any S3-compatible endpoint.

> **S3 consistency note:** `segments.json` is updated on every commit. S3 does not support atomic rename, so for high-frequency concurrent writers use S3 Object Versioning or a DynamoDB lock to prevent manifest races.

## Configuration

All fields are indexed + stored with the standard analyzer by default. Override per field:

```ts
const { writer, searcher } = createIndex(dir, {
  analyzers: { id: 'keyword', tags: 'keyword' },  // exact-match fields
  noStore:   ['body'],      // index for search but don't return in results
  noIndex:   ['url', 'thumbnail'],  // store and return but don't search
  boost:     { title: 2.0 },        // per-field BM25 score multiplier
});
```

| Option | Default | Meaning |
|---|---|---|
| `analyzers` | `{}` | Per-field analyzer map. Built-in: `'standard'`, `'keyword'` |
| `noStore` | `[]` | Fields to index but not store (e.g. large body text) |
| `noIndex` | `[]` | Fields to store but not index (e.g. url, thumbnail) |
| `boost` | `{}` | Per-field BM25 score multipliers |

## IndexWriter

```ts
const { writer } = createIndex(dir, config, {
  commitThreshold: 5000,  // auto-commit after this many documents (default 5000)
});

await writer.addDocument({ id: 'doc-1', title: 'Hello', body: '...' });
await writer.deleteById('doc-1');  // tombstone visible across ALL segments, not just the current one

const info = await writer.commit();
// → { segmentId: 'seg-000001', docCount: 1, deletedCount: 0 }

await writer.close();  // commits any remaining buffered docs; further use throws
```

Each `commit()` produces a new segment directory:

```
index/
├── segments.json              ← manifest listing all segment IDs
├── seg-000001/
│   ├── segment-meta.json      ← docCount, per-field avgLength, timestamp
│   ├── docs.json              ← stored fields keyed by numeric docId
│   ├── field-lengths.json     ← per-doc token counts for BM25 |d| normalisation
│   ├── term-dict.json         ← "field:term" → "postings/field__term.json" (term part hex-escaped)
│   ├── deleted.json           ← tombstoned string doc IDs
│   └── postings/
│       ├── title__hello.json  ← { df, postings: [{docId, tf, pos}] }
│       └── ...
└── seg-000002/
    └── ...
```

## IndexSearcher

```ts
const { searcher } = createIndex(dir, config, {
  postingsCacheSize: 10_000,  // LRU entries for postings lists (default 10,000)
  termDictCacheSize: 200,     // LRU entries for term dicts (default 200)
});

const results = await searcher.search('typescript search engine', {
  topK: 10,                                        // default 10
  filter: doc => doc['tags'] !== 'archived',       // optional post-filter
});

for (const r of results) {
  console.log(r.score, r.docId, r.doc);
}

// Invalidate caches after new segments are written
searcher.invalidateCache();
```

Results are sorted by BM25 score descending. Searches across all segments in parallel, then selects the top-K using a min-heap (O(n log k)).

## Segment merging

Many small segments slow searches. Use `SegmentMerger` to consolidate:

```ts
import { SegmentMerger } from 'lucene-ts';

const merger = new SegmentMerger(dir, {
  maxSegments: 10,  // trigger when segment count exceeds this (default 10)
  mergeCount:  4,   // merge this many of the smallest segments at once (default 4)
});

await merger.maybeMerge();  // no-op if under threshold (good for a background cron)
await merger.mergeAll();    // unconditionally consolidate everything into one segment
```

After a merge, call `searcher.invalidateCache()` so stale term-dict entries are evicted.

Merging is **structural** — postings lists are combined directly without re-tokenising or re-analysing any text. This means:

- `noStore` fields (e.g. `body`) remain fully searchable after a merge; their postings are carried over verbatim from the source segments.
- Phrase query positions are preserved exactly as indexed.
- No `IndexConfig` is required by `SegmentMerger`; the analyzer is never invoked.

## Scoring

BM25 is computed per term per field using actual per-document field lengths:

```
score(t, d) = IDF(t) × tf(t,d) × (k+1) / (tf(t,d) + k × (1 − b + b × |d|/avgdl))
```

- `|d|` — actual token count for the field in this document (stored in `field-lengths.json`)
- `avgdl` — average token count across all documents in the segment
- Default: `k = 1.2`, `b = 0.75`

Field boosts (`boost: { title: 2.0 }`) multiply the per-field BM25 score. Term boosts (`title:foo^2`) multiply the per-term score.

Custom scorer:

```ts
import type { Scorer, ScoreContext } from 'lucene-ts';

class MyScorer implements Scorer {
  score(ctx: ScoreContext): number {
    // ctx.query, ctx.docId, ctx.segmentMeta, ctx.postingsMap, ctx.config, ctx.fieldLengths
    return 1.0;
  }
}

const searcher = new IndexSearcher(dir, config, new MyScorer());
```

## Performance

Measured on Apple M-series, in-memory, random queries across 35 unique terms:

| Docs | Segments | Avg query latency |
|---:|---:|---:|
| 10,000 | 4 | ~6 ms |
| 50,000 | 20 | ~39 ms |

Cold S3 latency depends on object size and region. Typical per-term postings fetch is one `GetObject` call; the LRU cache eliminates repeated fetches for hot terms across queries.

## Deployment patterns

### Lambda + S3 (static / batch indexing)

```
build-job (ECS/Fargate/local)
  └─► commits segments → S3

searcher-lambda
  └─► reads S3 on demand → returns results
```

Cost: ~$50/mo for moderate query volumes (storage + Lambda invocations).

### ECS live indexing

```
writer-service (ECS)          ← receives new documents, commits segments
        │
        ▼
    S3 index
        │
        ▼
searcher-service (ECS, ×N)    ← stateless readers, poll segments.json
```

### Distributed sharding (future)

```
writer-shard-{0..N}  →  S3 shard-{0..N}/
                              │
                    coordinator-searcher
                    fan-out → [shard searchers] → merge top-K
```

## BeIR benchmark

Evaluates retrieval quality against [BeIR](https://github.com/beir-cellar/beir) datasets (MSMARCO, HotpotQA, and others) and reports standard IR metrics: NDCG@10/100, MAP@100, Recall@10/100, MRR@10.

**Requirements:** `curl` and `unzip` must be in PATH. For the S3 backend, `@aws-sdk/client-s3` must be installed as a peer dependency.

```sh
# Filesystem backend (default) — downloads ~1.7 GB, indexes to bench/index-hotpotqa/
bun bench/beir.ts --dataset hotpotqa

# In-memory subset — fast, no disk I/O
bun bench/beir.ts --dataset hotpotqa --backend memory --max-docs 50000

# Small dataset (3 633 docs) — completes in seconds, good for a quick smoke test
bun bench/beir.ts --dataset nfcorpus

# MSMARCO on a custom index path
bun bench/beir.ts --dataset msmarco --backend fs --index-dir /tmp/msmarco-idx

# S3 backend (requires bun add @aws-sdk/client-s3)
bun bench/beir.ts --dataset hotpotqa --backend s3 --s3-bucket my-bucket

# Skip segment merge, limit retrieval depth, silence progress bars
bun bench/beir.ts --dataset hotpotqa --no-merge --top-k 10 --quiet
```

| Option | Default | Description |
|---|---|---|
| `--dataset <name>` | — | BeIR dataset: `hotpotqa`, `msmarco`, `nfcorpus`, `fiqa`, `arguana`, `scifact`, `nq`, `quora`, … |
| `--backend <name>` | `fs` | Storage backend: `memory`, `fs`, `s3` |
| `--data-dir <path>` | `bench/data` | Dataset download cache |
| `--index-dir <path>` | `bench/index-<dataset>` | Index directory (fs backend) |
| `--s3-bucket <name>` | — | S3 bucket (s3 backend, required) |
| `--s3-prefix <pfx>` | `beir/<dataset>` | S3 key prefix |
| `--s3-region <r>` | `us-east-1` | AWS region |
| `--s3-endpoint <url>` | — | Custom endpoint (LocalStack / MinIO) |
| `--max-docs <n>` | 0 (unlimited) | Cap corpus size; defaults to 100 000 for the memory backend |
| `--commit-every <n>` | 5 000 | Writer auto-commit threshold |
| `--top-k <n>` | 100 | Retrieval depth per query (min 100 for full metrics) |
| `--split <name>` | auto | Qrel split: `test`, `dev`, `train` (MSMARCO defaults to `dev`) |
| `--no-merge` | false | Skip `SegmentMerger.mergeAll()` after indexing |
| `--quiet` | false | No progress bars; print summary only |

Datasets are downloaded from the [UKP TU Darmstadt public server](https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/) and cached in `bench/data/` — subsequent runs skip the download.

## Development

```sh
bun install
bun test                          # bun:test
bun test --watch src/tests
bun run build                     # tsc → dist/
bun run bench                     # 10K synthetic doc microbenchmark

DOCS=50000 QUERIES=500 bun run bench
```

## License

MIT
