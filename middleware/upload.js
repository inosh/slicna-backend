// middleware/upload.js
// Multer config for image uploads, saved to the local uploads/ folder:
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
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

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

// The public path stored in the database for an uploaded file.
function publicPathFor(folder, file) {
  return `/uploads/${folder}/${file.filename}`;
}

module.exports = { UPLOAD_ROOT, imageUpload, publicPathFor };
