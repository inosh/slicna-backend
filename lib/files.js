// lib/files.js
// Removes public uploads from R2 when their record is deleted or the image is
// replaced. Only touches "/uploads/..." paths, never anything else.

const storage = require('./storage');

// publicPath: "/uploads/<key>" as stored in the database. Runs in the background.
function deleteUpload(publicPath) {
  const key = storage.publicKeyFromPath(publicPath);
  if (key) storage.remove('public', key);
}

// Deletes the files multer stored for a request that was then rejected (e.g. validation failed).
function discardRequestFiles(req) {
  // req.files is an array (.array()) or an object of arrays (.fields()).
  const files = req.file ? [req.file] : Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat();
  files.forEach((file) => { if (file.key) storage.remove(file.bucket || 'public', file.key); });
}

module.exports = { deleteUpload, discardRequestFiles };
