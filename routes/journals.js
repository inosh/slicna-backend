// routes/journals.js
// SLICNA journal issues (PDF), shown as a flipbook on the Journal page.
//   GET    /api/journals            published issues, newest first (public)
//   GET    /api/journals/:id        one issue (public)
//   POST   /api/journals            add (multipart: pdf required, cover image optional)
//   PUT    /api/journals/:id        edit (a new pdf/cover replaces the old; remove_image=true clears the cover)
//   DELETE /api/journals/:id        delete it and its files
// Files are public (uploads/journals/), like event posters and brochures.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { storageFor } = require('../middleware/upload');
const { deleteUpload, discardRequestFiles } = require('../lib/files');
const { parseFields, parseId, validationError } = require('../lib/crud');

const router = express.Router();
const notFound = (res) => res.status(404).json({ error: 'Journal issue not found.' });

const TYPES = {
  pdf: ['application/pdf'],
  cover: ['image/jpeg', 'image/png', 'image/webp'],
};
const upload = multer({
  storage: storageFor('journals'), // the public R2 bucket, journals/...
  fileFilter(req, file, cb) {
    const types = TYPES[file.fieldname];
    if (!types) return cb(new Error('Unexpected upload field: ' + file.fieldname + '. Only listed files are allowed.'));
    if (!types.includes(file.mimetype)) {
      return cb(new Error(file.fieldname === 'pdf' ? 'For the journal, only PDF files are allowed.' : 'For the cover, only JPEG, PNG or WEBP images are allowed.'));
    }
    cb(null, true);
  },
  limits: { fileSize: 30 * 1024 * 1024, files: 2 },
}).fields([{ name: 'pdf', maxCount: 1 }, { name: 'cover', maxCount: 1 }]);

const uploaded = (req, field) => (req.files && req.files[field] ? req.files[field][0] : null);
const discard = discardRequestFiles;
const publicPath = (file) => `/uploads/journals/${file.filename}`;

const FIELDS = {
  title: { type: 'text', label: 'Title', required: true, max: 300 },
  issue_label: { type: 'text', label: 'Volume / issue', max: 100 },
  published_on: { type: 'date', label: 'Publication date', required: true },
  description: { type: 'text', label: 'Description', max: 2000 },
};

router.get('/', async (req, res, next) => {
  try {
    res.json((await pool.query('SELECT * FROM journals ORDER BY published_on DESC, id DESC')).rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = (await pool.query('SELECT * FROM journals WHERE id = $1', [parseId(req.params.id)])).rows[0];
    if (!row) return notFound(res);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

async function save(req, res, next, existing) {
  try {
    const values = parseFields(req.body, FIELDS);
    const pdf = uploaded(req, 'pdf');
    const cover = uploaded(req, 'cover');
    if (!existing && !pdf) throw validationError('Please choose the journal PDF.');
    const old = [];
    if (pdf) {
      values.pdf_url = publicPath(pdf);
      values.pdf_name = pdf.originalname.slice(0, 255);
      values.pdf_size = pdf.size;
      if (existing) old.push(existing.pdf_url);
    }
    if (cover) {
      values.cover_url = publicPath(cover);
      if (existing) old.push(existing.cover_url);
    } else if (existing && req.body.remove_image === 'true') {
      values.cover_url = null;
      old.push(existing.cover_url);
    }
    const cols = Object.keys(values);
    const row = existing
      ? (await pool.query(
        `UPDATE journals SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
        [...Object.values(values), existing.id]
      )).rows[0]
      : (await pool.query(
        `INSERT INTO journals (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        Object.values(values)
      )).rows[0];
    old.forEach(deleteUpload);
    res.status(existing ? 200 : 201).json(row);
  } catch (err) {
    discard(req);
    next(err);
  }
}

router.post('/', requireAuth, upload, (req, res, next) => save(req, res, next, null));

router.put('/:id', requireAuth, upload, async (req, res, next) => {
  try {
    const existing = (await pool.query('SELECT * FROM journals WHERE id = $1', [parseId(req.params.id)])).rows[0];
    if (!existing) {
      discard(req);
      return notFound(res);
    }
    save(req, res, next, existing);
  } catch (err) {
    discard(req);
    next(err);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const row = (await pool.query('DELETE FROM journals WHERE id = $1 RETURNING *', [parseId(req.params.id)])).rows[0];
    if (!row) return notFound(res);
    deleteUpload(row.pdf_url);
    deleteUpload(row.cover_url);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
