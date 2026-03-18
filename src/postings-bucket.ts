/**
 * Postings bucket layout.
 *
 * Instead of one file per term, all postings for a segment are grouped into
 * a variable number of bucket files (postings/bucket-0.json, bucket-1.json,
 * …).  Each bucket file is a JSON object mapping "field:term" → PostingsList.
 *
 * The number of buckets is proportional to the segment's document count:
 *
 *   numBuckets = ceil(docCount / DOCS_PER_BUCKET)
 *
 * This keeps each bucket file roughly bounded in size regardless of corpus
 * scale — a 5 000-doc segment gets 5 buckets, a 5 200 000-doc merged segment
 * gets 5 200 buckets, each covering ~1 000 documents' worth of postings.
 *
 * The bucket assignment is a deterministic FNV-1a hash of the "field:term"
 * key modulo numBuckets, so it can be recomputed at write time without any
 * extra metadata.  Readers never compute the hash — they look up the bucket
 * filename directly from term-dict.json.
 */

/** Target number of documents per bucket file. */
export const DOCS_PER_BUCKET = 1_000;

/**
 * Minimum bucket count, chosen so that small segments (e.g. the default
 * 5 000-doc commit threshold) keep each bucket file to a manageable size
 * (~640 terms) for lazy postings loading during search.
 */
export const MIN_BUCKETS = 64;

/** Compute the number of buckets for a segment with the given document count. */
export function numBucketsFor(docCount: number): number {
  return Math.max(MIN_BUCKETS, Math.ceil(docCount / DOCS_PER_BUCKET));
}

/**
 * FNV-1a 32-bit hash of a UTF-16 string.
 * Returns a bucket index in [0, numBuckets).
 */
export function bucketFor(fieldTerm: string, numBuckets: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < fieldTerm.length; i++) {
    h ^= fieldTerm.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % numBuckets;
}

/** Returns the relative path of a bucket file, e.g. "postings/bucket-42.json". */
export function bucketFilename(bucket: number): string {
  return `postings/bucket-${bucket}.json`;
}
