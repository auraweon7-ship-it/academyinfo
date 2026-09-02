import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const endpoint = process.env.AWS_ENDPOINT_URL || process.env.BUCKET_ENDPOINT || '';
const bucket = process.env.BUCKET || process.env.RAILWAY_BUCKET_NAME || '';
const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.BUCKET_ACCESS_KEY_ID || '';
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.BUCKET_SECRET_ACCESS_KEY || '';
export const bucketEnabled = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
const client = bucketEnabled ? new S3Client({ endpoint, region: process.env.AWS_REGION || 'auto', credentials: { accessKeyId, secretAccessKey } }) : null;

export async function putObject(key, bytes, contentType) {
  if (!client) return false;
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
  return true;
}

export async function getObject(key) {
  if (!client) throw new Error('Railway Bucket이 연결되지 않았습니다.');
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await result.Body.transformToByteArray());
}
