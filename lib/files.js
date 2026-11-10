// lib/files.js
// Removes uploaded files from disk when their record is deleted or the image
// is replaced. Only touches paths inside uploads/, never anything else.

const fs = require('fs');
const path = require('path');
const { UPLOAD_ROOT } = require('../middleware/upload');

function deleteUpload(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/')) return;

  const filePath = path.resolve(UPLOAD_ROOT, publicPath.slice('/uploads/'.length));
  if (!filePath.startsWith(UPLOAD_ROOT + path.sep)) return;

  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') console.error('Could not delete upload', publicPath, err.message);
  });
}

// Deletes files multer saved for a request that was then rejected (e.g. validation failed).
function discardRequestFiles(req) {
  // req.files is an array (.array()) or an object of arrays (.fields()).
  const files = req.file ? [req.file] : Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat();
  files.forEach((file) => fs.unlink(file.path, () => {}));
}

module.exports = { deleteUpload, discardRequestFiles };
