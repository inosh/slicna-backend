// routes/albums.js
// Gallery:
//   GET    /api/albums                  public: albums in order, each with photos + cover_photo
//   POST   /api/albums/:id/photos       admin: add photos (multipart "photos", up to 30)
//   PUT    /api/albums/photos/:photoId  admin: edit a photo's caption / order
//   DELETE /api/albums/photos/:photoId  admin: remove a photo
//   POST   /api/albums                  admin: create an album with its first photos
//                                       (multipart "photos", 1 to 30, required)
//   PUT/DELETE /api/albums/:id          admin: edit or delete an album

const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { imageUpload, publicPathFor } = require('../middleware/upload');
const { crudRouter, parseFields, parseId, validationError } = require('../lib/crud');
const { deleteUpload, discardRequestFiles } = require('../lib/files');

const router = express.Router();

const PHOTO_FIELDS = {
  caption: { type: 'text', label: 'Caption', max: 300 },
  display_order: { type: 'int', label: 'Display order', default: 0 },
};

const ALBUM_FIELDS = {
  title: { type: 'text', label: 'Title', required: true, max: 200 },
  description: { type: 'text', label: 'Description', max: 2000 },
  event_date: { type: 'date', label: 'Date' },
  display_order: { type: 'int', label: 'Display order', default: 0 },
};

router.get('/', async (req, res, next) => {
  try {
    const albums = (await pool.query('SELECT * FROM albums ORDER BY display_order ASC, id ASC')).rows;
    const photos = (await pool.query('SELECT * FROM album_photos ORDER BY display_order ASC, id ASC')).rows;
    res.json(albums.map((album) => {
      const own = photos.filter((p) => p.album_id === album.id);
      return { ...album, cover_photo: own[0] ? own[0].url : null, photos: own };
    }));
  } catch (err) {
    next(err);
  }
});

// An album is always created together with its first photos, so the gallery
// never shows an empty album. Album and photo rows are saved in one transaction.
router.post('/', requireAuth, imageUpload('albums').array('photos', 30), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const values = parseFields(req.body, ALBUM_FIELDS);
    if (!req.files || !req.files.length) throw validationError('Please choose at least one photo for the album.');

    await client.query('BEGIN');
    const album = (await client.query(
      'INSERT INTO albums (title, description, event_date, display_order) VALUES ($1, $2, $3, $4) RETURNING *',
      [values.title, values.description, values.event_date, values.display_order]
    )).rows[0];
    const photos = [];
    for (const [i, file] of req.files.entries()) {
      photos.push((await client.query(
        'INSERT INTO album_photos (album_id, url, display_order) VALUES ($1, $2, $3) RETURNING *',
        [album.id, publicPathFor('albums', file), (i + 1) * 10]
      )).rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json({ ...album, cover_photo: photos[0].url, photos });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    discardRequestFiles(req);
    next(err);
  } finally {
    client.release();
  }
});

router.post('/:id/photos', requireAuth, imageUpload('albums').array('photos', 30), async (req, res, next) => {
  const id = parseId(req.params.id);
  try {
    if (!id || !(await pool.query('SELECT 1 FROM albums WHERE id = $1', [id])).rows[0]) {
      discardRequestFiles(req);
      return res.status(404).json({ error: 'Album not found.' });
    }
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'Please choose at least one photo.' });

    // New photos go after the existing ones, in the order they were selected.
    const { max } = (await pool.query('SELECT COALESCE(MAX(display_order), 0) AS max FROM album_photos WHERE album_id = $1', [id])).rows[0];
    const inserted = [];
    for (const [i, file] of req.files.entries()) {
      const row = await pool.query(
        'INSERT INTO album_photos (album_id, url, display_order) VALUES ($1, $2, $3) RETURNING *',
        [id, publicPathFor('albums', file), max + (i + 1) * 10]
      );
      inserted.push(row.rows[0]);
    }
    await pool.query('UPDATE albums SET updated_at = now() WHERE id = $1', [id]);
    res.status(201).json(inserted);
  } catch (err) {
    discardRequestFiles(req);
    next(err);
  }
});

router.put('/photos/:photoId', requireAuth, multer().none(), async (req, res, next) => {
  const id = parseId(req.params.photoId);
  if (!id) return res.status(404).json({ error: 'Photo not found.' });
  try {
    const values = parseFields(req.body, PHOTO_FIELDS);
    const result = await pool.query(
      'UPDATE album_photos SET caption = $1, display_order = $2 WHERE id = $3 RETURNING *',
      [values.caption, values.display_order, id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Photo not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/photos/:photoId', requireAuth, async (req, res, next) => {
  const id = parseId(req.params.photoId);
  if (!id) return res.status(404).json({ error: 'Photo not found.' });
  try {
    const result = await pool.query('DELETE FROM album_photos WHERE id = $1 RETURNING url', [id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Photo not found.' });
    deleteUpload(result.rows[0].url);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Deleting an album deletes its photo rows (ON DELETE CASCADE); remove the files first.
router.delete('/:id', requireAuth, async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return next();
  try {
    const photos = (await pool.query('SELECT url FROM album_photos WHERE album_id = $1', [id])).rows;
    photos.forEach((p) => deleteUpload(p.url));
    next();
  } catch (err) {
    next(err);
  }
});

// GET /:id, PUT /:id and DELETE /:id (POST / is handled above).
router.use('/', crudRouter({
  table: 'albums',
  orderBy: 'display_order ASC, id ASC',
  fields: ALBUM_FIELDS,
}));

module.exports = router;
