import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from './logger';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

let _client: S3Client | undefined;

export function getS3Client(): S3Client {
  if (_client) return _client;
  _client = new S3Client({
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint: required('S3_ENDPOINT'),
    credentials: {
      accessKeyId: required('S3_ACCESS_KEY'),
      secretAccessKey: required('S3_SECRET_KEY'),
    },
    forcePathStyle: true,
  });
  return _client;
}

export function getBucket(): string {
  return required('S3_BUCKET');
}

export async function putObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<void> {
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

/** Presigned GET URL. Default TTL 15 minutes. */
export async function getPresignedGetUrl(key: string, ttlSec = 900): Promise<string> {
  const client = getS3Client();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: getBucket(), Key: key }),
    { expiresIn: ttlSec }
  );
}

/** Used by tests to decide whether to skip file-upload cases. */
export async function isStorageReachable(): Promise<boolean> {
  try {
    await getS3Client().send(new HeadBucketCommand({ Bucket: getBucket() }));
    return true;
  } catch (err) {
    logger.warn('storage.unreachable', {
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
