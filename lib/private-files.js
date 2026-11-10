// lib/private-files.js
// PRIVATE uploads (membership photos and payment slips), in the private R2
// bucket (lib/storage.js). Never public: streamed only to logged-in admins
// (see sendPrivateFile). The database keeps the key, e.g.
//   membership/applications/LT-20261106-7KQ2M9/photo-1793716438086-e8cc.jpg
//   membership/renewals/12/receipt-1793716438086-1a2b.pdf
//   membership/members/12/photo-1793716438086-3c4d.jpg
//   events/8/registrations/REG-ABC/receipt-1793716438086-9f0e.pdf

const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const storage = require('./storage');

const MAX_BYTES = 10 * 1024 * 1024;

const TYPES = {
  image: { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' },
  document: { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' },
};
const TYPE_LABELS = { image: 'JPEG, PNG or WEBP images', document: 'JPEG, PNG or WEBP images, or PDF files' };

// Multer middleware for private files.
//   folderFn(req) -> storage folder, e.g. "membership/renewals/12"
//   fields: { photo: 'image', receipt: 'document', ... } (field name -> type)
// Each saved file gets a `key` property; fields not listed are rejected.
function privateUpload(folderFn, fields) {
  const r2 = storage.multerStorage('private', (req, file) => {
    const ext = TYPES[fields[file.fieldname]][file.mimetype];
    return `${folderFn(req)}/${file.fieldname}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`;
  });

  const fileFilter = (req, file, cb) => {
    const type = fields[file.fieldname];
    if (!type) return cb(new Error('Unexpected upload field: ' + file.fieldname + '. Only listed files are allowed.'));
    if (!TYPES[type][file.mimetype]) return cb(new Error(`For "${file.fieldname}", only ${TYPE_LABELS[type]} are allowed.`));
    cb(null, true);
  };

  return multer({ storage: r2, fileFilter, limits: { fileSize: MAX_BYTES, files: Object.keys(fields).length } })
    .fields(Object.keys(fields).map((name) => ({ name, maxCount: 1 })));
}

// The key of an uploaded field, or null.
function uploadedKey(req, field) {
  const file = req.files && req.files[field] && req.files[field][0];
  return file ? file.key : null;
}

// Removes every file multer stored for this request (e.g. after a validation error).
function discardUploads(req) {
  Object.values(req.files || {}).flat().forEach((file) => { if (file.key) storage.remove('private', file.key); });
}

// Deletes one private file, or everything under a "folder" (runs in the background).
const deletePrivateFile = (key) => { if (key) storage.remove('private', key); };
const deletePrivateFolder = (prefix) => storage.removePrefix('private', prefix.endsWith('/') ? prefix : `${prefix}/`);

// Moves every file under one folder to another ("upload-XYZ/" -> "LT-2026.../").
async function movePrivateFolder(fromPrefix, toPrefix) {
  const from = fromPrefix.endsWith('/') ? fromPrefix : `${fromPrefix}/`;
  const to = toPrefix.endsWith('/') ? toPrefix : `${toPrefix}/`;
  for (const key of await storage.list('private', from)) await storage.move('private', key, to + key.slice(from.length));
}

// A private file's contents (e.g. a member photo for the ID card PDF), or null.
const privateFileBuffer = (key) => (key ? storage.getBuffer('private', key) : Promise.resolve(null));

// Streams a private file to an admin with a readable download name.
// downloadName is without the extension; { attachment: true } asks the browser to save it.
async function sendPrivateFile(res, key, downloadName, { attachment = false } = {}) {
  let obj = null;
  try {
    obj = storage.safeKey(key) ? await storage.get('private', key) : null;
  } catch (err) {
    console.error('Could not read private file', key, err.message);
    return res.status(502).json({ error: 'The file could not be loaded. Please try again.' });
  }
  if (!obj) return res.status(404).json({ error: 'File not found.' });
  const ext = path.extname(key);
  res.setHeader('Content-Type', storage.contentTypeFor(key, obj.ContentType));
  if (obj.ContentLength) res.setHeader('Content-Length', obj.ContentLength);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${attachment ? 'attachment' : 'inline'}; filename="${String(downloadName).replace(/[^\w.\- ]/g, '_')}${ext}"`);
  obj.Body.on('error', () => res.destroy());
  obj.Body.pipe(res);
}

module.exports = { privateUpload, uploadedKey, discardUploads, deletePrivateFile, deletePrivateFolder, movePrivateFolder, privateFileBuffer, sendPrivateFile };
