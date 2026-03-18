/**
 * S3IndexDirectory — AWS SDK v3 backed IndexDirectory.
 *
 * Requires peer dependency: @aws-sdk/client-s3
 *   npm install @aws-sdk/client-s3
 *
 * The S3Client instance is injected so callers control auth, region, and
 * endpoint (including LocalStack / MinIO for local dev).
 *
 * @example
 * ```ts
 * import { S3Client } from '@aws-sdk/client-s3';
 * import { S3IndexDirectory } from 'lucene-ts';
 *
 * const client = new S3Client({ region: 'us-east-1' });
 * const dir = new S3IndexDirectory(client, 'my-bucket', 'search-index/v1');
 * ```
 */

import type { IndexDirectory } from './directory.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyS3Client = any;

export class S3IndexDirectory implements IndexDirectory {
  constructor(
    private readonly client: AnyS3Client,
    private readonly bucket: string,
    /** All keys are written under this prefix, e.g. "my-index/v1" */
    private readonly prefix: string,
  ) {}

  private key(filePath: string): string {
    return `${this.prefix}/${filePath}`;
  }

  async list(pathPrefix: string): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3' as string as any);

    const prefix = this.key(pathPrefix);
    const results: string[] = [];
    let token: string | undefined;

    do {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of (resp.Contents ?? []) as Array<{ Key?: string }>) {
        if (obj.Key) results.push(obj.Key.slice(this.prefix.length + 1));
      }
      token = (resp as any).NextContinuationToken;
    } while (token);

    return results;
  }

  async readJson<T>(filePath: string): Promise<T> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3' as string as any);
    const resp = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(filePath) }),
    );
    const body: string | undefined = await resp.Body?.transformToString();
    if (!body) throw new Error(`S3IndexDirectory: empty body for ${filePath}`);
    return JSON.parse(body) as T;
  }

  async writeJson(
    filePath: string,
    data: unknown,
    _options?: { atomic?: boolean },
  ): Promise<void> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3' as string as any);
    const body = JSON.stringify(data, null, 2);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(filePath),
        Body: body,
        ContentType: 'application/json',
      }),
    );
    // S3 doesn't support atomic rename. For stronger consistency guarantees,
    // use S3 versioning + conditional writes (IfNoneMatch) or DynamoDB as a
    // manifest lock table.
  }

  async exists(filePath: string): Promise<boolean> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3' as string as any);
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(filePath) }),
      );
      return true;
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
      throw err;
    }
  }

  async delete(filePath: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3' as string as any);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(filePath) }),
    );
  }
}
