// routes/settings.js
// One-off page content stored in site_settings.
//   GET /api/settings               public: { key: value, ... }
//   PUT /api/settings/images/:key   admin: upload/replace an image setting

const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { imageUpload, publicPathFor } = require('../middleware/upload');
const { deleteUpload, discardRequestFiles } = require('../lib/files');

const router = express.Router();

// Image settings the admin panel may change, and the uploads/ folder each goes in.
const IMAGE_SETTINGS = {
  about_journey_photo: 'about',
};

router.get('/', async (req, res, next) => {
  try {
    const rows = (await pool.query('SELECT key, value FROM site_settings')).rows;
    res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  } catch (err) {
    next(err);
  }
});

router.put('/images/:key', requireAuth, (req, res, next) => {
  const folder = IMAGE_SETTINGS[req.params.key];
  if (!folder) return res.status(404).json({ error: 'Unknown setting.' });
  imageUpload(folder).single('photo')(req, res, async (uploadErr) => {
    if (uploadErr) return next(uploadErr);
    if (!req.file) return res.status(400).json({ error: 'Please choose a photo to upload.' });
    try {
      const old = (await pool.query('SELECT value FROM site_settings WHERE key = $1', [req.params.key])).rows[0];
      const value = publicPathFor(folder, req.file);
      await pool.query(
        `INSERT INTO site_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [req.params.key, value]
      );
      if (old) deleteUpload(old.value);
      res.json({ key: req.params.key, value });
    } catch (err) {
      discardRequestFiles(req);
      next(err);
    }
  });
});

module.exports = router;
