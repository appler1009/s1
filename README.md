# lucene-ts

A Lucene-inspired full-text search engine written in TypeScript. Designed for millions of documents on AWS S3 with no JVM, no GC pauses, and human-readable JSON index files.

```
bun add lucene-ts
```

## Features

- **Immutable segments** — append-only writes, safe concurrent reads
- **BM25 scoring** with per-field boost
- **Lucene query syntax** — `field:term`, `"phrase"`, `term*`, `[min TO max]`, `+must -mustNot`, `AND`/`OR`/`NOT`, `^boost`
- **S3-native** — index lives directly in S3; no plugin, no sidecar
- **Lazy postings loading** — only loads term data for queried terms (~50 KB/query vs loading the full index)
- **LRU cache** — configurable in-memory postings cache
- **Segment merging** — automatic or manual consolidation
- **Three backends** — `MemoryIndexDirectory` (tests), `FsIndexDirectory` (local), `S3IndexDirectory` (production)
- **External full documents** — index stores metadata/snippets only; full docs live wherever you put them

## Quick start

```ts
import { MemoryIndexDirectory, createIndex } from 'lucene-ts';
import type { Schema } from 'lucene-ts';

const schema: Schema = {
  fields: {
    id:      { type: 'keyword', store: true,  indexed: true  },
    title:   { type: 'text',    store: true,  indexed: true,  boost: 2.0 },
    body:    { type: 'text',    store: false, indexed: true  },
    snippet: { type: 'text',    store: true,  indexed: false },
    url:     { type: 'keyword', store: true,  indexed: false },
  },
};

const dir = new MemoryIndexDirectory();
const { writer, searcher } = createIndex(dir, schema);

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
| `"quick brown fox"` | Phrase (all terms must appear) |
| `title:"quick brown"` | Fielded phrase |
| `hel*` | Wildcard (suffix/contains) |
| `title:hel*` | Fielded wildcard |
| `+typescript +search` | Both terms required (AND) |
| `typescript -java` | Must have `typescript`, must not have `java` |
| `typescript AND search` | Explicit AND |
| `typescript OR javascript` | Either term |
| `NOT java` | Exclude term |
| `title:hello^2.5` | Boost a term's score |
| `[2020 TO 2024]` | Range |
| `(typescript OR javascript) +search` | Grouped expression |

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

## Schema

Each field has a type, storage, and indexing configuration:

```ts
const schema: Schema = {
  fields: {
    // Stored + indexed text with title boost
    title: { type: 'text', store: true, indexed: true, boost: 2.0 },

    // Indexed but not stored — used for search, not returned in results
    body: { type: 'text', store: false, indexed: true },

    // Stored but not indexed — returned in results, not searchable
    snippet: { type: 'text', store: true, indexed: false },

    // Keyword: no tokenization, exact match
    tags: { type: 'keyword', store: true, indexed: true, analyzer: 'keyword' },

    // Date field
    publishedAt: { type: 'date', store: true, indexed: true },
  },
};
```

**`store: false` fields** are indexed for search but never written to `docs.json`, keeping stored document size small. This is the recommended pattern for long body text — index it for relevance, but store only a snippet.

## IndexWriter

```ts
const { writer } = createIndex(dir, schema, {
  commitThreshold: 5000,   // auto-commit after this many documents (default 5000)
});

// Add documents (buffers in memory until commit)
await writer.addDocument({ id: 'doc-1', title: 'Hello', body: '...' });

// Tombstone a document by its string ID
await writer.deleteById('doc-1');

// Flush buffer to a new immutable segment
const info = await writer.commit();
// info → { segmentId: 'seg-000001', docCount: 1, deletedCount: 0 }

// Commit any remaining docs and close
await writer.close();
```

Each `commit()` produces a new segment directory:

```
index/
├── segments.json              ← manifest listing all segment IDs
├── seg-000001/
│   ├── segment-meta.json      ← docCount, field stats, timestamp
│   ├── docs.json              ← stored fields keyed by numeric docId
│   ├── term-dict.json         ← "field:term" → "postings/field_term.json"
│   ├── deleted.json           ← tombstoned string doc IDs
│   └── postings/
│       ├── title_hello.json   ← { df, postings: [{docId, tf, pos}] }
│       └── ...
└── seg-000002/
    └── ...
```

## IndexSearcher

```ts
const { searcher } = createIndex(dir, schema);

const results = await searcher.search('typescript search engine', {
  topK: 10,                                       // default 10
  filter: doc => doc.tags !== 'archived',         // optional post-filter
});

for (const r of results) {
  console.log(r.score, r.docId, r.doc);
}

// Clear LRU caches after new segments are written
searcher.invalidateCache();
```

Results are sorted by BM25 score descending. Searches across all segments in parallel and performs a k-way merge.

## Segment merging

Many small segments degrade search performance. Use `SegmentMerger` to consolidate:

```ts
import { SegmentMerger } from 'lucene-ts';
import { StandardAnalyzer } from 'lucene-ts';

const merger = new SegmentMerger(dir, schema, new StandardAnalyzer(), {
  maxSegments: 10,   // trigger merge when segment count exceeds this
  mergeCount: 4,     // merge this many of the smallest segments at once
});

// Merge only if over threshold (good for a background cron)
await merger.maybeMerge();

// Unconditionally consolidate everything into one segment
await merger.mergeAll();
```

After a merge, call `searcher.invalidateCache()` so stale term-dict entries are evicted.

## Scoring

BM25 is computed per term per field:

```
score(t, d) = IDF(t) × tf(t,d) × (k+1) / (tf(t,d) + k × (1 − b + b × |d|/avgdl))
```

Default parameters: `k = 1.2`, `b = 0.75`. Field boosts multiply the per-field score. Term boosts (`^N`) multiply the per-term score.

Custom scorer:

```ts
import type { Scorer, ScoreContext } from 'lucene-ts';

class MyScorer implements Scorer {
  score(ctx: ScoreContext): number {
    // ctx.query, ctx.docId, ctx.segmentMeta, ctx.postingsMap, ctx.schema
    return 1.0;
  }
}

const searcher = new IndexSearcher(dir, schema, analyzer, new MyScorer());
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
