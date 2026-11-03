// lib/private-files.js
// PRIVATE uploads (membership photos, payment slips, signed recommendation
// pages). Unlike uploads/, this folder is never served statically: files are
// streamed only to logged-in admins (see sendPrivateFile).
//
// Files are identified by a storage key that mirrors a future R2 private
// bucket key, e.g.
//   membership/applications/APP-7KQ2M9XA/photo-1793716438086-e8cc.jpg
//   membership/renewals/12/receipt-1793716438086-1a2b.pdf
//   membership/members/12/photo-1793716438086-3c4d.jpg
// so moving to R2 later only means changing this file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const PRIVATE_ROOT = path.join(__dirname, '..', 'private-uploads');
const MAX_BYTES = 10 * 1024 * 1024;

const TYPES = {
  image: { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' },
  document: { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' },
};
const TYPE_LABELS = { image: 'JPEG, PNG or WEBP images', document: 'JPEG, PNG or WEBP images, or PDF files' };

function resolveKey(key) {
  const filePath = path.resolve(PRIVATE_ROOT, key || '');
  if (!key || !filePath.startsWith(PRIVATE_ROOT + path.sep)) return null;
  return filePath;
}

// Multer middleware for private files.
//   folderFn(req) -> storage folder, e.g. "membership/applications/APP-..."
//   fields: { photo: 'image', receipt: 'document', ... } (field name -> type)
// Each saved file gets a `key` property; fields not listed are rejected.
function privateUpload(folderFn, fields) {
  const storage = multer.diskStorage({
    destination(req, file, cb) {
      const folder = folderFn(req);
      file.storageFolder = folder;
      const dir = path.join(PRIVATE_ROOT, folder);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      const ext = TYPES[fields[file.fieldname]][file.mimetype];
      const name = `${file.fieldname}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`;
      file.key = `${file.storageFolder}/${name}`;
      cb(null, name);
    },
  });

  const fileFilter = (req, file, cb) => {
    const type = fields[file.fieldname];
    if (!type) return cb(new Error('Unexpected upload field: ' + file.fieldname + '. Only listed files are allowed.'));
    if (!TYPES[type][file.mimetype]) return cb(new Error(`For "${file.fieldname}", only ${TYPE_LABELS[type]} are allowed.`));
    cb(null, true);
  };

  return multer({ storage, fileFilter, limits: { fileSize: MAX_BYTES, files: Object.keys(fields).length } })
    .fields(Object.keys(fields).map((name) => ({ name, maxCount: 1 })));
}

// The key of an uploaded field, or null.
function uploadedKey(req, field) {
  const file = req.files && req.files[field] && req.files[field][0];
  return file ? file.key : null;
}

// Removes every file multer saved for this request (e.g. after a validation error).
function discardUploads(req) {
  Object.values(req.files || {}).flat().forEach((file) => fs.unlink(file.path, () => {}));
}

function deletePrivateFile(key) {
  const filePath = resolveKey(key);
  if (filePath) fs.unlink(filePath, () => {});
}

// Streams a private file to an admin with a readable download name.
function sendPrivateFile(res, key, downloadName) {
  const filePath = resolveKey(key);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });
  const ext = path.extname(filePath);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename="${String(downloadName).replace(/[^\w.\- ]/g, '_')}${ext}"`);
  res.sendFile(filePath);
}

module.exports = { PRIVATE_ROOT, privateUpload, uploadedKey, discardUploads, deletePrivateFile, sendPrivateFile, resolveKey };
