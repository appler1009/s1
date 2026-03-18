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
| `"quick brown fox"` | Exact phrase (position-checked) |
| `title:"quick brown"` | Fielded phrase |
| `"quick brown"~2` | Phrase with slop (terms within 2 positions) |
| `hel*` | Wildcard (suffix/prefix/contains) |
| `title:hel*` | Fielded wildcard |
| `+typescript +search` | Both terms required (AND) |
| `typescript -java` | Must have `typescript`, must not have `java` |
| `typescript AND search` | Explicit AND |
| `typescript OR javascript` | Either term |
| `NOT java` | Exclude term |
| `title:hello^2.5` | Boost a term's score |
| `(typescript OR javascript) +search` | Grouped expression |

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
await writer.deleteById('doc-1');  // tombstone; applied on next commit

const info = await writer.commit();
// → { segmentId: 'seg-000001', docCount: 1, deletedCount: 0 }

await writer.close();  // commits any remaining buffered docs
```

Each `commit()` produces a new segment directory:

```
index/
├── segments.json              ← manifest listing all segment IDs
├── seg-000001/
│   ├── segment-meta.json      ← docCount, per-field avgLength, timestamp
│   ├── docs.json              ← stored fields keyed by numeric docId
│   ├── field-lengths.json     ← per-doc token counts for BM25 |d| normalisation
│   ├── term-dict.json         ← "field:term" → "postings/field__term.json"
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

const merger = new SegmentMerger(dir, config, {
  maxSegments: 10,  // trigger when segment count exceeds this
  mergeCount:  4,   // merge this many of the smallest segments at once
});

await merger.maybeMerge();  // no-op if under threshold (good for a background cron)
await merger.mergeAll();    // unconditionally consolidate everything into one segment
```

After a merge, call `searcher.invalidateCache()` so stale term-dict entries are evicted.

> **Merge limitation:** Fields in `noStore` (e.g. `body`) are not stored in `docs.json`, so they cannot be re-indexed during a merge. If you need to merge-and-reindex body text, store the full document in an external store (S3, database) keyed by `id`, and re-fetch it at merge time.

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

## Development

```sh
bun install
bun test                          # bun:test
bun test --watch src/tests
bun run build                     # tsc → dist/
bun run bench                     # 10K doc benchmark

DOCS=50000 QUERIES=500 bun run bench
```

## License

MIT
