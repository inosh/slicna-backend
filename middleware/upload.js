// middleware/upload.js
// Multer config for image (and album video) uploads, saved to the local uploads/ folder:
//   uploads/<folder>/<timestamp>-<random>-<original-name>
// The database stores the public path ("/uploads/<folder>/<file>"), which
// server.js serves as static files. (To move to Cloudflare R2 later, only this
// file and lib/files.js need to change.)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
// Album videos, as on the SLNA site.
const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg', 'video/x-m4v'];
// Some computers report an MP4 with no type or a general one (application/octet-stream,
// video/x-msvideo, ...): then the file extension decides.
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|ogg)$/i;
const isVideoFile = (file) => VIDEO_MIME_TYPES.includes(file.mimetype)
  || (VIDEO_EXT.test(file.originalname || '') && (!file.mimetype || file.mimetype === 'application/octet-stream' || file.mimetype.startsWith('video/')));
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

function safeName(originalname) {
  return originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-80);
}

function storageFor(folder) {
  return multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(UPLOAD_ROOT, folder);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName(file.originalname)}`);
    },
  });
}

function imageFilter(req, file, cb) {
  if (IMAGE_MIME_TYPES.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Only image files (JPEG, PNG, WEBP, GIF) are allowed.'));
}

// Uploader for one folder, e.g. imageUpload('news').single('photo').
function imageUpload(folder) {
  return multer({ storage: storageFor(folder), fileFilter: imageFilter, limits: { fileSize: MAX_IMAGE_BYTES } });
}

// Album media: photos and videos. imageFields are image-only (e.g. a news cover).
// Multer's limit is the video size; checkMediaSizes() then holds photos to 15MB.
function mediaUpload(folder, { imageFields = [] } = {}) {
  return multer({
    storage: storageFor(folder),
    limits: { fileSize: MAX_VIDEO_BYTES },
    fileFilter(req, file, cb) {
      if (IMAGE_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
      if (!imageFields.includes(file.fieldname) && isVideoFile(file)) return cb(null, true);
      cb(new Error(imageFields.includes(file.fieldname)
        ? 'Only image files (JPEG, PNG, WEBP, GIF) are allowed.'
        : 'Only photos (JPEG, PNG, WEBP, GIF) or videos (MP4, WEBM, MOV, OGG) are allowed.'));
    },
  });
}

const mediaTypeFor = (file) => (isVideoFile(file) ? 'video' : 'image');

// Throws a 400 if a photo is over 15MB (videos may be up to 100MB).
function checkMediaSizes(files) {
  const big = files.find((f) => mediaTypeFor(f) === 'image' && f.size > MAX_IMAGE_BYTES);
  if (big) {
    const err = new Error(`${big.originalname} is over 15MB. Photos must be under 15MB (videos under 100MB).`);
    err.statusCode = 400;
    throw err;
  }
}

// The public path stored in the database for an uploaded file.
function publicPathFor(folder, file) {
  return `/uploads/${folder}/${file.filename}`;
}

module.exports = { UPLOAD_ROOT, imageUpload, mediaUpload, mediaTypeFor, checkMediaSizes, publicPathFor };
