// routes/news.js
// News articles: /api/news (public read, admin write).
//
//   GET    /api/news         articles, newest first (each with album_count)
//   GET    /api/news/types   the news types, for the admin form
//   GET    /api/news/:id     one article, with its album's photos and videos (photos)
//   POST   /api/news         add (multipart: "photo" cover photo or video, "photos" album items,
//                            "content_images" pictures inside the article text)
//   PUT    /api/news/:id     edit; new "photos" are added to the article's album
//                            (remove_image=true clears the cover)
//   DELETE /api/news/:id     delete the article (its album stays in the Gallery)
//
// As on the SLNA site, an article's photos and videos form an album named and
// dated after the article, so they also appear in the Gallery. The album is
// created with the first photos and kept in step with the article's title and
// date. Single photos are removed or reordered in the Gallery admin.
//
// The article text (body) is HTML from the admin's rich text editor (or older
// plain text). Pictures added inside the text arrive as "content_images" with
// "__CONTENT_IMG_<n>__" in the HTML where each goes; they're saved like other
// uploads and the placeholders replaced with their paths. The public page
// cleans the HTML (DOMPurify) before showing it.

const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { mediaUpload, mediaTypeFor, checkMediaSizes, publicPathFor } = require('../middleware/upload');
const { parseFields, parseId } = require('../lib/crud');
const { deleteUpload, discardRequestFiles } = require('../lib/files');

const router = express.Router();

// Types, as on the SLNA site (in step with the CHECK in db/schema.sql).
const NEWS_TYPES = ['International Nurses Day', 'Annual General Meeting', 'General Meeting', 'CPD Event', 'Community Event', 'Awareness Program', 'Celebration', 'General News'];

const FIELDS = {
  title: { type: 'text', label: 'Title', required: true, max: 300 },
  news_type: { type: 'enum', label: 'Type', values: NEWS_TYPES, default: 'General News' },
  published_at: { type: 'date', label: 'Published date', required: true },
  summary: { type: 'text', label: 'Summary', max: 1000 },
  body: { type: 'text', label: 'Full article', max: 200000 },
};

// "photo" is the cover (a photo or a video) and "photos" album photos and
// videos; "content_images" are the pictures in the text (images only).
const upload = mediaUpload('news', { imageFields: ['content_images'] }).fields([
  { name: 'photo', maxCount: 1 },
  { name: 'photos', maxCount: 50 },
  { name: 'content_images', maxCount: 20 },
]);

// Puts each uploaded in-text picture's path where its placeholder is.
function withContentImages(body, files) {
  let html = body || '';
  files.forEach((file, i) => { html = html.split(`__CONTENT_IMG_${i}__`).join(publicPathFor('news', file)); });
  return html;
}

// Paths of the pictures used inside an article's text.
const inlineImages = (body) => new Set(String(body || '').match(/\/uploads\/news\/[^"'\s<>]+/g) || []);
const filesOf = (req, field) => (req.files && req.files[field]) || [];
const notFound = (res) => res.status(404).json({ error: 'News article not found.' });

// Adds uploaded album items to the article's album, creating the album first if
// it has none. Returns the album id. Runs inside the caller's transaction.
async function addToAlbum(client, albumId, article, files) {
  if (!files.length) return albumId;
  if (!albumId) {
    albumId = (await client.query(
      'INSERT INTO albums (title, event_date) VALUES ($1, $2) RETURNING id',
      [article.title, article.published_at]
    )).rows[0].id;
  }
  const { max } = (await client.query('SELECT COALESCE(MAX(display_order), 0) AS max FROM album_photos WHERE album_id = $1', [albumId])).rows[0];
  for (const [i, file] of files.entries()) {
    await client.query(
      'INSERT INTO album_photos (album_id, url, media_type, display_order) VALUES ($1, $2, $3, $4)',
      [albumId, publicPathFor('news', file), mediaTypeFor(file), max + (i + 1) * 10]
    );
  }
  await client.query('UPDATE albums SET updated_at = now() WHERE id = $1', [albumId]);
  return albumId;
}

router.get('/', async (req, res, next) => {
  try {
    const rows = (await pool.query(
      `SELECT n.*, (SELECT count(*)::int FROM album_photos p WHERE p.album_id = n.album_id) AS album_count
       FROM news n ORDER BY n.published_at DESC, n.id DESC`
    )).rows;
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/types', (req, res) => res.json(NEWS_TYPES));

router.get('/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  try {
    const item = (await pool.query('SELECT * FROM news WHERE id = $1', [id])).rows[0];
    if (!item) return notFound(res);
    item.photos = item.album_id
      ? (await pool.query('SELECT * FROM album_photos WHERE album_id = $1 ORDER BY display_order ASC, id ASC', [item.album_id])).rows
      : [];
    res.json(item);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, upload, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const values = parseFields(req.body, FIELDS);
    const albumFiles = filesOf(req, 'photos');
    checkMediaSizes([...filesOf(req, 'photo'), ...albumFiles, ...filesOf(req, 'content_images')]);
    values.body = withContentImages(values.body, filesOf(req, 'content_images'));
    const cover = filesOf(req, 'photo')[0];
    await client.query('BEGIN');
    const albumId = await addToAlbum(client, null, values, albumFiles);
    const row = (await client.query(
      `INSERT INTO news (title, news_type, published_at, summary, body, photo_url, album_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [values.title, values.news_type, values.published_at, values.summary, values.body, cover ? publicPathFor('news', cover) : null, albumId]
    )).rows[0];
    await client.query('COMMIT');
    res.status(201).json(row);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    discardRequestFiles(req);
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id', requireAuth, upload, async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) {
    discardRequestFiles(req);
    return notFound(res);
  }
  const client = await pool.connect();
  let oldCover = null;
  let removedInline = [];
  try {
    const values = parseFields(req.body, FIELDS);
    const albumFiles = filesOf(req, 'photos');
    checkMediaSizes([...filesOf(req, 'photo'), ...albumFiles, ...filesOf(req, 'content_images')]);
    values.body = withContentImages(values.body, filesOf(req, 'content_images'));
    const cover = filesOf(req, 'photo')[0];
    await client.query('BEGIN');
    const existing = (await client.query('SELECT * FROM news WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!existing) throw Object.assign(new Error('News article not found.'), { statusCode: 404 });

    let photoUrl = existing.photo_url;
    if (cover) {
      photoUrl = publicPathFor('news', cover);
      oldCover = existing.photo_url;
    } else if (req.body.remove_image === 'true') {
      photoUrl = null;
      oldCover = existing.photo_url;
    }
    const stillUsed = inlineImages(values.body);
    removedInline = [...inlineImages(existing.body)].filter((path) => !stillUsed.has(path));
    const albumId = await addToAlbum(client, existing.album_id, values, albumFiles);
    // The album keeps the article's name and date.
    if (albumId) await client.query('UPDATE albums SET title = $1, event_date = $2, updated_at = now() WHERE id = $3', [values.title, values.published_at, albumId]);

    const row = (await client.query(
      `UPDATE news SET title = $1, news_type = $2, published_at = $3, summary = $4, body = $5, photo_url = $6, album_id = $7, updated_at = now()
       WHERE id = $8 RETURNING *`,
      [values.title, values.news_type, values.published_at, values.summary, values.body, photoUrl, albumId, id]
    )).rows[0];
    await client.query('COMMIT');
    deleteUpload(oldCover);
    removedInline.forEach(deleteUpload);
    res.json(row);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    discardRequestFiles(req);
    next(err);
  } finally {
    client.release();
  }
});

// The article's album stays in the Gallery (delete it there if it's not wanted).
router.delete('/:id', requireAuth, async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  try {
    const row = (await pool.query('DELETE FROM news WHERE id = $1 RETURNING *', [id])).rows[0];
    if (!row) return notFound(res);
    deleteUpload(row.photo_url);
    inlineImages(row.body).forEach(deleteUpload);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
