// lib/storage.js
// Every uploaded file lives in Cloudflare R2 (S3-compatible), in two buckets:
//
//   public   R2_BUCKET_PUBLIC   photos, videos, posters, brochures, journal PDFs...
//            The database keeps their path as "/uploads/<key>" (e.g.
//            "/uploads/news/1793...-photo.jpg" -> key "news/1793...-photo.jpg").
//            Visitors load them from R2_PUBLIC_BASE_URL/<key>; the backend's
//            /uploads/<key> redirects there too, so older links keep working.
//   private  R2_BUCKET_PRIVATE  payment slips, application and member photos.
//            The database keeps the key itself ("membership/applications/...").
//            Never public: streamed to logged-in admins only (lib/private-files.js).
//
// Settings (.env / Railway variables):
//   R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
//   R2_BUCKET_PUBLIC, R2_BUCKET_PRIVATE, R2_PUBLIC_BASE_URL

require('dotenv').config();
const path = require('path');
const { PassThrough } = require('stream');
const {
  S3Client, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand,
  CopyObjectCommand, ListObjectsV2Command, HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const REQUIRED = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_PUBLIC', 'R2_BUCKET_PRIVATE', 'R2_PUBLIC_BASE_URL'];
const missing = REQUIRED.filter((k) => !process.env[k]);

let client = null;
function s3() {
  if (missing.length) throw Object.assign(new Error(`File storage is not set up: missing ${missing.join(', ')}.`), { statusCode: 500 });
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
      // R2 doesn't support the newer AWS checksum headers recent SDKs send by default.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return client;
}

const BUCKETS = { public: process.env.R2_BUCKET_PUBLIC, private: process.env.R2_BUCKET_PRIVATE };
const bucketName = (which) => BUCKETS[which] || (() => { throw new Error(`Unknown bucket "${which}".`); })();
const PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');

// Keys are relative paths like "news/123-a.jpg": no leading slash, no "..".
function safeKey(key) {
  const k = String(key || '');
  if (!k || k.startsWith('/') || k.split('/').some((part) => part === '..' || part === '')) return null;
  return k;
}

// "/uploads/news/a.jpg" -> "news/a.jpg" (public files), or null.
function publicKeyFromPath(publicPath) {
  const p = String(publicPath || '');
  return p.startsWith('/uploads/') ? safeKey(p.slice('/uploads/'.length)) : null;
}
const publicUrl = (key) => `${PUBLIC_BASE_URL}/${key}`;

const TYPES_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.ogg': 'video/ogg', '.ogv': 'video/ogg',
};
// The type browsers need to show or play it; for files sent as "application/octet-stream" the extension decides.
function contentTypeFor(name, reported) {
  const byExt = TYPES_BY_EXT[path.extname(String(name || '')).toLowerCase()];
  if (!reported || reported === 'application/octet-stream') return byExt || 'application/octet-stream';
  return reported;
}

// Public files never change (each upload gets a new name), so browsers may keep them for a year.
const cacheControlFor = (which) => (which === 'public' ? 'public, max-age=31536000, immutable' : 'private, no-store');

// Uploads a stream, Buffer or string (large files in parts). Resolves when stored.
async function put(which, key, body, contentType) {
  const k = safeKey(key);
  if (!k) throw new Error(`Invalid storage key "${key}".`);
  await new Upload({
    client: s3(),
    params: { Bucket: bucketName(which), Key: k, Body: body, ContentType: contentType, CacheControl: cacheControlFor(which) },
    partSize: 10 * 1024 * 1024,
    queueSize: 4,
  }).done();
  return k;
}

const isMissing = (err) => err && (err.name === 'NoSuchKey' || err.name === 'NotFound' || (err.$metadata && err.$metadata.httpStatusCode === 404));

// { Body (stream), ContentType, ContentLength } or null when there's no such file.
async function get(which, key) {
  const k = safeKey(key);
  if (!k) return null;
  try {
    return await s3().send(new GetObjectCommand({ Bucket: bucketName(which), Key: k }));
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

async function getBuffer(which, key) {
  const obj = await get(which, key);
  if (!obj) return null;
  return Buffer.from(await obj.Body.transformToByteArray());
}

async function exists(which, key) {
  const k = safeKey(key);
  if (!k) return false;
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucketName(which), Key: k }));
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

// Deletes a file. Never throws (a failed clean-up shouldn't break the request); problems are logged.
async function remove(which, key) {
  const k = safeKey(key);
  if (!k) return;
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: bucketName(which), Key: k }));
  } catch (err) {
    console.error(`Could not delete ${which} file ${k}:`, err.message);
  }
}

// Every key under a prefix ("membership/applications/LT-2026.../").
async function list(which, prefix) {
  const keys = [];
  let token;
  do {
    const out = await s3().send(new ListObjectsV2Command({ Bucket: bucketName(which), Prefix: prefix, ContinuationToken: token }));
    (out.Contents || []).forEach((o) => keys.push(o.Key));
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

// Deletes everything under a "folder" (prefix ending in "/"). Never throws.
async function removePrefix(which, prefix) {
  if (!safeKey(String(prefix).replace(/\/$/, ''))) return;
  try {
    const keys = await list(which, prefix);
    for (let i = 0; i < keys.length; i += 1000) {
      await s3().send(new DeleteObjectsCommand({ Bucket: bucketName(which), Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
    }
  } catch (err) {
    console.error(`Could not delete ${which} files under ${prefix}:`, err.message);
  }
}

// R2 has no rename: copy, then delete the original.
async function move(which, fromKey, toKey) {
  const from = safeKey(fromKey);
  const to = safeKey(toKey);
  if (!from || !to) throw new Error('Invalid storage key.');
  const bucket = bucketName(which);
  await s3().send(new CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: `${bucket}/${from.split('/').map(encodeURIComponent).join('/')}` }));
  await remove(which, from);
  return to;
}

// Multer storage engine: streams each uploaded file straight to R2.
//   keyFor(req, file) -> the key, e.g. "news/1793...-photo.jpg"
// The saved file gets: key, filename (last part of the key), bucket ("public" | "private"), size.
// multer calls _removeFile for files already saved when a later one fails.
function multerStorage(which, keyFor) {
  return {
    _handleFile(req, file, cb) {
      let key;
      try { key = safeKey(keyFor(req, file)); } catch (err) { return cb(err); }
      if (!key) return cb(new Error('Invalid file name.'));
      let size = 0;
      const counter = new PassThrough();
      counter.on('data', (chunk) => { size += chunk.length; });
      file.stream.on('error', cb);
      file.stream.pipe(counter);
      put(which, key, counter, contentTypeFor(file.originalname || key, file.mimetype))
        .then(() => cb(null, { key, filename: path.posix.basename(key), bucket: which, size }))
        .catch(cb);
    },
    _removeFile(req, file, cb) {
      remove(file.bucket || which, file.key).then(() => cb(null), cb);
    },
  };
}

module.exports = {
  BUCKETS, PUBLIC_BASE_URL, missing,
  safeKey, publicKeyFromPath, publicUrl, contentTypeFor,
  put, get, getBuffer, exists, remove, list, removePrefix, move, multerStorage,
};
